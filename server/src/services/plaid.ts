import {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
  Products,
  CountryCode,
  type AccountBase,
} from 'plaid';
import { getDb } from '../db/schema.js';
import { categorize } from '../util/categorize.js';

const PLAID_ENV = (process.env.PLAID_ENV ?? 'sandbox') as keyof typeof PlaidEnvironments;

const config = new Configuration({
  basePath: PlaidEnvironments[PLAID_ENV],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID ?? '',
      'PLAID-SECRET': process.env.PLAID_SECRET ?? '',
    },
  },
});

export const plaidClient = new PlaidApi(config);

export function plaidConfigured(): boolean {
  return Boolean(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);
}

export async function createLinkToken(userId: string): Promise<string> {
  const res = await plaidClient.linkTokenCreate({
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
  const exchange = await plaidClient.itemPublicTokenExchange({ public_token: publicToken });
  const { access_token, item_id } = exchange.data;

  getDb()
    .prepare(`INSERT OR REPLACE INTO plaid_items (item_id, access_token, institution_name) VALUES (?, ?, ?)`)
    .run(item_id, access_token, institutionName);

  await refreshItem(item_id, access_token, institutionName);
}

export async function refreshItem(itemId: string, accessToken: string, institutionName: string): Promise<void> {
  const res = await plaidClient.accountsBalanceGet({ access_token: accessToken });

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
}

export interface TxnDelta { date: string; delta: number }

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
      const res = await plaidClient.transactionsGet({
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
