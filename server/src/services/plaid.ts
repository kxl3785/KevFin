import {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
  Products,
  CountryCode,
  type AccountBase,
  type Transaction,
} from 'plaid';
import { getDb } from '../db/schema.js';
import { categorize } from '../util/categorize.js';
import type { RawTxn } from './simplefin.js';

// Built lazily from the current env so credentials edited at runtime (via the
// Setup → API keys panel, which calls resetPlaidClient) take effect without a
// server restart. resolvePlaidEnv falls back to sandbox for an unknown value.
let cachedClient: PlaidApi | null = null;

function resolvePlaidEnv(): keyof typeof PlaidEnvironments {
  const env = process.env.PLAID_ENV ?? 'sandbox';
  return (env in PlaidEnvironments ? env : 'sandbox') as keyof typeof PlaidEnvironments;
}

export function getPlaidClient(): PlaidApi {
  if (!cachedClient) {
    cachedClient = new PlaidApi(new Configuration({
      basePath: PlaidEnvironments[resolvePlaidEnv()],
      baseOptions: {
        headers: {
          'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID ?? '',
          'PLAID-SECRET': process.env.PLAID_SECRET ?? '',
        },
      },
    }));
  }
  return cachedClient;
}

// Drop the cached client so the next call rebuilds it from the latest env.
export function resetPlaidClient(): void { cachedClient = null; }

export function plaidConfigured(): boolean {
  return Boolean(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);
}

export async function createLinkToken(userId: string): Promise<string> {
  const res = await getPlaidClient().linkTokenCreate({
    user: { client_user_id: userId },
    client_name: 'KevFin Net Worth Tracker',
    // transactions covers both Frec and Bilt; investments is pulled in only
    // for institutions that support it (Frec) so Bilt isn't blocked.
    products: [Products.Transactions],
    required_if_supported_products: [Products.Investments],
    country_codes: [CountryCode.Us],
    language: 'en',
  });
  return res.data.link_token;
}

export async function exchangePublicToken(publicToken: string, institutionName: string): Promise<void> {
  const exchange = await getPlaidClient().itemPublicTokenExchange({ public_token: publicToken });
  const { access_token, item_id } = exchange.data;

  getDb()
    .prepare(`INSERT OR REPLACE INTO plaid_items (item_id, access_token, institution_name) VALUES (?, ?, ?)`)
    .run(item_id, access_token, institutionName);

  await refreshItem(item_id, access_token, institutionName);
}

export async function refreshItem(itemId: string, accessToken: string, institutionName: string): Promise<void> {
  const res = await getPlaidClient().accountsBalanceGet({ access_token: accessToken });

  const db = getDb();
  // category only set on first insert; refreshes preserve user overrides.
  const upsert = db.prepare(`
    INSERT INTO accounts (id, source, connection_id, plaid_item_id, org_name, name, currency, balance, category, updated_at)
    VALUES (@id, 'plaid', 0, @plaid_item_id, @org_name, @name, @currency, @balance, @category, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      org_name   = excluded.org_name,
      name       = excluded.name,
      currency   = excluded.currency,
      balance    = excluded.balance,
      updated_at = datetime('now')
  `);

  for (const acct of res.data.accounts as AccountBase[]) {
    // Credit/loan balances are liabilities: store as negative so net worth subtracts them.
    const raw = acct.balances.current ?? 0;
    const balance = acct.type === 'credit' || acct.type === 'loan' ? -Math.abs(raw) : raw;
    upsert.run({
      id: acct.account_id,
      plaid_item_id: itemId,
      org_name: institutionName,
      name: acct.name,
      currency: acct.balances.iso_currency_code ?? 'USD',
      balance,
      category: categorize(acct.name),
    });
  }

  // Pull (and cache) this item's transaction feed too, so budgeting sees Plaid
  // accounts the same way it sees SimpleFIN ones. Forced because this IS the
  // refresh path (daily cron / manual "Sync now" / initial link).
  await getItemTransactions(itemId, accessToken, true).catch(err =>
    console.error(`[plaid] transaction refresh failed for item ${itemId}:`, err));
}

export interface TxnDelta { date: string; delta: number }

// --- Transaction feed (for budgeting) --------------------------------------
// Mirrors SimpleFIN: the full transaction list per item is fetched at most once
// per ~24h and cached in memory + the DB (survives restarts), so the Budget page
// can read it cheaply on every load instead of re-hitting Plaid.
const TXN_CACHE_MS = 23 * 60 * 60 * 1000; // ~once per day, matching SimpleFIN
const TXN_WINDOW_DAYS = 730;              // 2y of transactions, matching SimpleFIN
const txnMemCache = new Map<string, { fetchedAt: number; txns: RawTxn[] }>();

function readTxnDbCache(itemId: string): { fetchedAt: number; txns: RawTxn[] } | null {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(`plaid_txn_cache_${itemId}`) as { value: string } | undefined;
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const toUnix = (date: string | null): number | null =>
  date ? Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000) : null;

// Map a Plaid transaction into KevFin's RawTxn shape. Plaid amounts are positive
// when money LEAVES the account; SimpleFIN (and the budget) use the opposite
// convention (+ = money in), so flip the sign here.
function toRawTxn(t: Transaction, names: Map<string, string>): RawTxn {
  return {
    id: t.transaction_id,
    posted: toUnix(t.date) ?? 0,
    transactedAt: toUnix(t.authorized_date ?? null),
    amount: -(t.amount ?? 0),
    description: t.name ?? '',
    payee: t.merchant_name ?? '',
    memo: '',
    accountId: t.account_id,
    accountName: names.get(t.account_id) ?? '',
  };
}

// Live, paginated transaction pull for one item over the budgeting window.
async function fetchItemTransactionsLive(accessToken: string): Promise<RawTxn[]> {
  const endDate = ymd(new Date());
  const startDate = ymd(new Date(Date.now() - TXN_WINDOW_DAYS * 86400 * 1000));
  const names = new Map<string, string>();
  const out: RawTxn[] = [];
  let offset = 0;
  for (;;) {
    const res = await getPlaidClient().transactionsGet({
      access_token: accessToken,
      start_date: startDate,
      end_date: endDate,
      options: { count: 500, offset },
    });
    for (const a of res.data.accounts) names.set(a.account_id, a.name);
    for (const t of res.data.transactions) {
      // Skip pending rows: Plaid later replaces each with a posted row carrying a
      // new transaction_id, so counting both would double-count the same charge.
      if (t.pending) continue;
      out.push(toRawTxn(t, names));
    }
    offset += res.data.transactions.length;
    if (offset >= res.data.total_transactions || res.data.transactions.length === 0) break;
  }
  return out;
}

/** Cached transaction feed for one item — re-fetched at most once per TXN_CACHE_MS. */
async function getItemTransactions(itemId: string, accessToken: string, force = false): Promise<RawTxn[]> {
  const now = Date.now();

  const mem = txnMemCache.get(itemId);
  if (!force && mem && now - mem.fetchedAt < TXN_CACHE_MS) return mem.txns;

  if (!force) {
    const db = readTxnDbCache(itemId);
    if (db && now - db.fetchedAt < TXN_CACHE_MS) { txnMemCache.set(itemId, db); return db.txns; }
  }

  try {
    const txns = await fetchItemTransactionsLive(accessToken);
    const entry = { fetchedAt: now, txns };
    txnMemCache.set(itemId, entry);
    getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(`plaid_txn_cache_${itemId}`, JSON.stringify(entry));
    console.log(`[plaid] fetched item ${itemId} (${txns.length} transactions) — cached for ~24h`);
    return txns;
  } catch (err) {
    console.error(`[plaid] transaction fetch failed for item ${itemId}:`, err);
    return mem?.txns ?? readTxnDbCache(itemId)?.txns ?? []; // fall back to stale
  }
}

/** All Plaid transactions across items (from the daily cache), for budgeting. */
export async function getAllPlaidTransactions(): Promise<RawTxn[]> {
  if (!plaidConfigured()) return [];
  const items = getDb().prepare('SELECT item_id, access_token FROM plaid_items').all() as { item_id: string; access_token: string }[];
  const lists = await Promise.all(items.map(i => getItemTransactions(i.item_id, i.access_token)));
  return lists.flat();
}

/**
 * Fetch transactions since `startDate` (YYYY-MM-DD) for all Plaid items, grouped
 * by account id. Plaid amounts are positive when money LEAVES the account, so the
 * balance effect is delta = -amount.
 */
export async function fetchPlaidTransactions(startDate: string, endDate: string): Promise<Map<string, TxnDelta[]>> {
  const out = new Map<string, TxnDelta[]>();
  if (!plaidConfigured()) return out;

  const db = getDb();
  const items = db.prepare('SELECT access_token FROM plaid_items').all() as { access_token: string }[];

  for (const it of items) {
    let offset = 0;
    // paginate until we've pulled every transaction in the window
    for (;;) {
      const res = await getPlaidClient().transactionsGet({
        access_token: it.access_token,
        start_date: startDate,
        end_date: endDate,
        options: { count: 500, offset },
      });
      for (const t of res.data.transactions) {
        const list = out.get(t.account_id) ?? [];
        list.push({ date: t.date, delta: -(t.amount ?? 0) });
        out.set(t.account_id, list);
      }
      offset += res.data.transactions.length;
      if (offset >= res.data.total_transactions || res.data.transactions.length === 0) break;
    }
  }
  return out;
}

export async function refreshAllPlaid(): Promise<void> {
  if (!plaidConfigured()) return;
  const db = getDb();
  const items = db
    .prepare('SELECT item_id, access_token, institution_name FROM plaid_items')
    .all() as { item_id: string; access_token: string; institution_name: string }[];

  await Promise.all(items.map(i => refreshItem(i.item_id, i.access_token, i.institution_name)));
}
