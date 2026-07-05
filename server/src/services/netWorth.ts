import { getDb } from '../db/schema.js';
import { refreshAllAccounts } from './simplefin.js';
import { refreshAllPlaid } from './plaid.js';
import { refreshAllProperties } from './zillow.js';
import { recomputeMortgageBalances } from './mortgage.js';
import { taxBucket, TAX_BUCKETS, type TaxBucket } from '../util/taxBucket.js';
import { recordRealObservation } from './observations.js';
import type { Breakdown, Snapshot, Account, ManualAsset, Property } from '../shared/apiTypes.js';

// Recompute today's snapshot from whatever is currently in the DB.
// Does NOT call Plaid/Zillow — safe to run after every manual edit.
export function takeSnapshot(): void {
  const db = getDb();

  // Refresh amortized mortgage balances so equity reflects paydown to date.
  recomputeMortgageBalances();

  const { accounts_total } = db.prepare(`
    SELECT
      (SELECT COALESCE(SUM(balance), 0) FROM accounts WHERE hidden = 0)
      + (SELECT COALESCE(SUM(value), 0) FROM manual_assets) AS accounts_total
  `).get() as { accounts_total: number };

  const { real_estate_total } = db.prepare(`
    SELECT COALESCE(SUM(zestimate - mortgage_balance), 0) AS real_estate_total
    FROM properties WHERE zestimate IS NOT NULL
  `).get() as { real_estate_total: number };

  const net_worth = accounts_total + real_estate_total;
  const date = new Date().toISOString().slice(0, 10);

  db.prepare(`
    INSERT OR REPLACE INTO net_worth_snapshots (date, accounts_total, real_estate_total, net_worth)
    VALUES (?, ?, ?, ?)
  `).run(date, accounts_total, real_estate_total, net_worth);

  // Per-asset observations for the same day — the append-only history that
  // net_worth_snapshots (a single total) can't reconstruct after the fact.
  const observe = db.transaction(() => {
    for (const a of db.prepare('SELECT id, balance FROM accounts WHERE hidden = 0').all() as { id: string; balance: number }[]) {
      recordRealObservation(db, a.id, date, a.balance);
    }
    for (const m of db.prepare('SELECT id, value FROM manual_assets').all() as { id: number; value: number }[]) {
      recordRealObservation(db, `manual:${m.id}`, date, m.value);
    }
    for (const p of db.prepare('SELECT id, zestimate, mortgage_balance FROM properties WHERE zestimate IS NOT NULL').all() as { id: number; zestimate: number; mortgage_balance: number }[]) {
      recordRealObservation(db, `property:${p.id}`, date, p.zestimate - p.mortgage_balance);
    }
  });
  observe();

  console.log(`[${date}] Net worth snapshot: $${net_worth.toLocaleString()}`);
}

const LAST_RE_REFRESH = 'last_real_estate_refresh';

function getMeta(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function setMeta(key: string, value: string): void {
  getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
}

// Full refresh: pull latest from all account sources + Zillow, then snapshot.
// Forces a fresh SimpleFIN fetch (bypasses the daily cache) since this is the
// explicit "Sync now" action — newly-linked accounts should appear at once.
// Records the real-estate refresh time too, so the Setup "last synced" readout
// reflects that this path also pulled property values.
export async function refreshAndSnapshot(): Promise<void> {
  await Promise.all([refreshAllAccounts(true), refreshAllPlaid(), refreshAllProperties()]);
  setMeta(LAST_RE_REFRESH, new Date().toISOString());
  takeSnapshot();
}

// Accounts only (SimpleFIN + Plaid), then snapshot. Leaves real estate untouched.
// Forces a fresh SimpleFIN fetch: this is the scheduled daily refresh, and the
// 23h read-cache is also warmed by ordinary page views — so without force a
// casual visit before 6 AM would make the cron a no-op and new transactions /
// balances wouldn't sync until the cache happened to expire.
export async function refreshAccountsAndSnapshot(): Promise<void> {
  await Promise.all([refreshAllAccounts(true), refreshAllPlaid()]);
  takeSnapshot();
}

// Real estate only (Zillow), then snapshot. Leaves accounts untouched.
export async function refreshRealEstateAndSnapshot(): Promise<void> {
  await refreshAllProperties();
  setMeta(LAST_RE_REFRESH, new Date().toISOString());
  takeSnapshot();
}

// On startup: if real estate hasn't been refreshed in >15 days, catch up now.
// Covers the case where the server was asleep/stopped on the 1st or 15th.
export async function catchUpRealEstate(): Promise<void> {
  const last = getMeta(LAST_RE_REFRESH);
  const daysSince = last
    ? (Date.now() - new Date(last).getTime()) / (1000 * 60 * 60 * 24)
    : Infinity;

  if (daysSince > 15) {
    console.log(`[startup] Real estate last refreshed ${last ?? 'never'} — catching up...`);
    await refreshRealEstateAndSnapshot();
  }
}

export function getNetWorthHistory(days = 90): Snapshot[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT date, accounts_total, real_estate_total, net_worth
    FROM net_worth_snapshots
    ORDER BY date ASC
    LIMIT ?
  `).all(days) as Snapshot[];

  // Drop the oldest point if it's a backfill boundary artifact. The first
  // backfilled date sits right at the edge of the Plaid transaction window;
  // balanceAsOf() mis-counts if a large Plaid transaction falls exactly on
  // that date, producing a >15% overnight jump that isn't a real change.
  if (rows.length >= 2) {
    const jump = Math.abs(rows[1].net_worth - rows[0].net_worth) /
      Math.max(rows[0].net_worth, rows[1].net_worth);
    if (jump > 0.15) rows.shift();
  }

  return rows.reverse();
}

export function getCurrentBreakdown(): Breakdown {
  const db = getDb();

  const accounts = db.prepare(`
    SELECT id, org_name,
           COALESCE(custom_name, name) AS name,
           (custom_name IS NOT NULL) AS renamed,
           balance, currency, category, hidden, updated_at
    FROM accounts
    ORDER BY org_name, name
  `).all() as (Omit<Account, 'renamed' | 'hidden'> & { renamed: number; hidden: number })[];

  const manualAssets = db.prepare(`
    SELECT id, name, category, value, interest_rate, updated_at FROM manual_assets ORDER BY name
  `).all() as ManualAsset[];

  const properties = db.prepare(`
    SELECT id, address, zestimate, mortgage_balance,
           mortgage_principal, mortgage_rate, mortgage_start, mortgage_term_years,
           property_tax_annual, insurance_annual, hoa_annual, rental_income_annual, updated_at
    FROM properties ORDER BY address
  `).all() as Property[];

  // SQLite has no boolean type; convert its 0/1 here so the wire format (and
  // the shared Account type) carries real booleans instead of leaking the
  // storage convention to every consumer.
  return {
    accounts: accounts.map(a => ({ ...a, renamed: !!a.renamed, hidden: !!a.hidden })),
    manualAssets,
    properties,
  };
}

// Classify every visible cash/investment account into a tax bucket (by name) and
// sum balances per bucket — the starting pools for the Forecast retirement model.
// Credit-card (liability) accounts are excluded; they aren't investable assets.
export function getTaxBuckets() {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, COALESCE(custom_name, name) AS name, org_name, balance, category
    FROM accounts
    WHERE hidden = 0 AND category != 'credit'
    ORDER BY org_name, name
  `).all() as { id: string; name: string; org_name: string; balance: number; category: string }[];

  const totals: Record<TaxBucket, number> = { taxable: 0, pretax: 0, roth: 0, hsa: 0, college: 0 };
  const accounts = rows.map(r => {
    const bucket = taxBucket(`${r.name} ${r.org_name}`);
    totals[bucket] += r.balance;
    return { id: r.id, name: r.name, org_name: r.org_name, balance: r.balance, bucket };
  });

  return { buckets: TAX_BUCKETS, totals, accounts };
}
