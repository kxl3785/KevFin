import { getDb } from '../db/schema.js';
import { categorize } from '../util/categorize.js';

/**
 * SimpleFIN protocol flow:
 *  1. User creates a "setup token" at https://bridge.simplefin.org (base64 of a claim URL).
 *  2. We POST to the decoded claim URL once; it returns a permanent "access URL".
 *  3. We GET {access_url}/accounts to read balances + holdings + transactions.
 *
 * To respect SimpleFIN (and avoid hammering it on every page load), the full
 * /accounts payload is fetched at most once per ~24h per connection and cached
 * both in memory and in the DB (so it survives restarts). All consumers —
 * balances, holdings, transactions — derive from that one cached payload.
 */

interface SimpleFinAccount {
  org: { name?: string; domain?: string };
  id: string;
  name: string;
  currency: string;
  balance: string;
  'balance-date'?: number;
  holdings?: { symbol?: string; description?: string; market_value?: string; cost_basis?: string; purchase_price?: string; shares?: string; created?: number }[];
  transactions?: { id?: string; posted: number; transacted_at?: number; amount: string; description?: string; payee?: string; memo?: string }[];
}

interface AccountsResponse { errors: string[]; accounts: SimpleFinAccount[] }

const CACHE_MS = 23 * 60 * 60 * 1000; // ~once per day
const TXN_WINDOW_DAYS = 730;          // 2y of transactions in the cached payload
const memCache = new Map<number, { fetchedAt: number; accounts: SimpleFinAccount[] }>();

function splitAccessUrl(accessUrl: string): { baseUrl: string; authHeader: string } {
  const u = new URL(accessUrl);
  const authHeader =
    'Basic ' + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64');
  const baseUrl = `${u.protocol}//${u.host}${u.pathname}`.replace(/\/$/, '');
  return { baseUrl, authHeader };
}

function readDbCache(id: number): { fetchedAt: number; accounts: SimpleFinAccount[] } | null {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(`sf_cache_${id}`) as { value: string } | undefined;
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

/** Cached full account payload for one connection — fetched at most once per CACHE_MS. */
async function getConnectionAccounts(id: number, accessUrl: string, force = false): Promise<SimpleFinAccount[]> {
  const now = Date.now();

  const mem = memCache.get(id);
  if (!force && mem && now - mem.fetchedAt < CACHE_MS) return mem.accounts;

  if (!force) {
    const db = readDbCache(id);
    if (db && now - db.fetchedAt < CACHE_MS) { memCache.set(id, db); return db.accounts; }
  }

  const { baseUrl, authHeader } = splitAccessUrl(accessUrl);
  const sinceUnix = Math.floor(now / 1000) - TXN_WINDOW_DAYS * 86400;
  try {
    const res = await fetch(`${baseUrl}/accounts?start-date=${sinceUnix}`, { headers: { Authorization: authHeader } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as AccountsResponse;
    if (data.errors?.length) console.error('SimpleFIN returned errors:', data.errors);
    const entry = { fetchedAt: now, accounts: data.accounts ?? [] };
    memCache.set(id, entry);
    getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(`sf_cache_${id}`, JSON.stringify(entry));
    console.log(`[simplefin] fetched connection ${id} (${entry.accounts.length} accounts) — cached for ~24h`);
    return entry.accounts;
  } catch (err) {
    console.error(`[simplefin] fetch failed for connection ${id}:`, err);
    return mem?.accounts ?? readDbCache(id)?.accounts ?? []; // fall back to stale
  }
}

function allConnections(): { id: number; access_url: string }[] {
  return getDb().prepare('SELECT id, access_url FROM simplefin_connections').all() as { id: number; access_url: string }[];
}

/** Exchange a setup token for a permanent access URL and store the connection. */
export async function claimSetupToken(setupToken: string): Promise<number> {
  const claimUrl = Buffer.from(setupToken.trim(), 'base64').toString('utf-8');
  if (!claimUrl.startsWith('http')) throw new Error('Invalid setup token');

  const res = await fetch(claimUrl, { method: 'POST' });
  if (!res.ok) throw new Error(`Failed to claim setup token: HTTP ${res.status}`);
  const accessUrl = (await res.text()).trim();

  const info = getDb().prepare('INSERT INTO simplefin_connections (access_url) VALUES (?)').run(accessUrl);
  const connectionId = Number(info.lastInsertRowid);

  await refreshConnection(connectionId, accessUrl, true); // force initial fetch
  return connectionId;
}

/** Upsert balances for one connection from its (cached) accounts. */
export async function refreshConnection(connectionId: number, accessUrl: string, force = false): Promise<void> {
  const accounts = await getConnectionAccounts(connectionId, accessUrl, force);
  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO accounts (id, connection_id, org_name, name, currency, balance, category, balance_date, updated_at)
    VALUES (@id, @connection_id, @org_name, @name, @currency, @balance, @category, @balance_date, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      org_name     = excluded.org_name,
      name         = excluded.name,
      currency     = excluded.currency,
      balance      = excluded.balance,
      balance_date = excluded.balance_date,
      updated_at   = datetime('now')
  `);

  for (const acct of accounts) {
    upsert.run({
      id: acct.id,
      connection_id: connectionId,
      org_name: acct.org?.name ?? acct.org?.domain ?? 'Unknown',
      name: acct.name,
      currency: acct.currency ?? 'USD',
      balance: parseFloat(acct.balance) || 0,
      category: categorize(acct.name),
      balance_date: acct['balance-date'] ? new Date(acct['balance-date'] * 1000).toISOString() : null,
    });
  }
}

export interface TxnDelta { date: string; delta: number } // delta = effect on balance
// costBasis is null when the institution doesn't expose it (most do not, or
// send 0) — kept distinct from a real 0 so the UI can show "—" instead of
// fabricating a 100% gain. shares/acquired (the lot's open date) are carried so
// a last-resort basis can be ESTIMATED as shares × historical price on that date.
export interface Holding {
  symbol: string; description: string; marketValue: number; costBasis: number | null;
  shares: number | null; acquired: string | null;
}

/** Current holdings per account, from the cached payload. */
export async function fetchHoldings(): Promise<Map<string, Holding[]>> {
  const out = new Map<string, Holding[]>();
  for (const c of allConnections()) {
    const accounts = await getConnectionAccounts(c.id, c.access_url);
    for (const acct of accounts) {
      out.set(acct.id, (acct.holdings ?? []).map(h => {
        // SimpleFIN passes cost basis straight through from the aggregator. Many
        // institutions (esp. employer 401k/403b/IRA plans) leave `cost_basis` at
        // "0.00" but still report an average `purchase_price` and `shares` — so
        // fall back to purchase_price × shares before giving up. Anything that
        // still can't yield a positive basis stays null ("unknown") rather than a
        // fake zero basis that would show a wildly inflated gain.
        const num = (s?: string) => { const n = parseFloat(s ?? ''); return Number.isFinite(n) ? n : null; };
        const sh = num(h.shares);
        const cb = num(h.cost_basis);
        let costBasis = cb != null && cb > 0 ? cb : null;
        if (costBasis == null) {
          const pp = num(h.purchase_price);
          if (pp != null && sh != null && pp * sh > 0) costBasis = pp * sh;
        }
        return {
          symbol: (h.symbol ?? '').trim(),
          description: (h.description ?? '').trim(),
          marketValue: parseFloat(h.market_value ?? '0') || 0,
          costBasis,
          shares: sh != null && sh !== 0 ? sh : null,
          acquired: typeof h.created === 'number' && h.created > 0
            ? new Date(h.created * 1000).toISOString().slice(0, 10) : null,
        };
      }));
    }
  }
  return out;
}

/** Transactions since `sinceUnix`, grouped by account id, from the cached payload. */
export async function fetchTransactions(sinceUnix: number): Promise<Map<string, TxnDelta[]>> {
  const out = new Map<string, TxnDelta[]>();
  for (const c of allConnections()) {
    const accounts = await getConnectionAccounts(c.id, c.access_url);
    for (const acct of accounts) {
      const list = out.get(acct.id) ?? [];
      for (const t of acct.transactions ?? []) {
        if (t.posted >= sinceUnix) {
          list.push({ date: new Date(t.posted * 1000).toISOString().slice(0, 10), delta: parseFloat(t.amount) || 0 });
        }
      }
      out.set(acct.id, list);
    }
  }
  return out;
}

export interface RawTxn {
  id: string; posted: number; transactedAt: number | null; amount: number; description: string; payee: string; memo: string;
  accountId: string; accountName: string;
}

/** All transactions across connections (from the daily cache), for budgeting. */
export async function getAllTransactions(): Promise<RawTxn[]> {
  const out: RawTxn[] = [];
  for (const c of allConnections()) {
    const accounts = await getConnectionAccounts(c.id, c.access_url);
    for (const a of accounts) {
      for (const t of a.transactions ?? []) {
        out.push({
          id: t.id ?? `${a.id}-${t.posted}-${t.amount}`,
          posted: t.posted,
          transactedAt: t.transacted_at ?? null,
          amount: parseFloat(t.amount) || 0,
          description: t.description ?? '',
          payee: t.payee ?? '',
          memo: t.memo ?? '',
          accountId: a.id,
          accountName: a.name,
        });
      }
    }
  }
  return out;
}

/**
 * Refresh every stored connection's balances. By default reuses the ~daily
 * cache; pass force=true (e.g. the manual "Refresh Now" action) to bypass it and
 * re-fetch from SimpleFIN so newly-linked institutions/accounts show up at once.
 */
export async function refreshAllAccounts(force = false): Promise<void> {
  await Promise.all(allConnections().map(c => refreshConnection(c.id, c.access_url, force)));
}
