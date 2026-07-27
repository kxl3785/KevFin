import { getDb } from '../db/schema.js';
import { refreshAllAccounts } from './simplefin.js';
import { refreshAllPlaid } from './plaid.js';
import { refreshAllProperties } from './zillow.js';
import { recomputeMortgageBalances } from './mortgage.js';
import { taxBucket, TAX_BUCKETS, type TaxBucket } from '../util/taxBucket.js';
import { getMeta, setMeta } from './meta.js';

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

  // A property with no Zestimate yet still carries its mortgage liability
  // (backfill values it the same way), so don't drop the whole row on a null.
  const { real_estate_total } = db.prepare(`
    SELECT COALESCE(SUM(COALESCE(zestimate, 0) - COALESCE(mortgage_balance, 0)), 0) AS real_estate_total
    FROM properties
  `).get() as { real_estate_total: number };

  const net_worth = accounts_total + real_estate_total;
  const date = new Date().toISOString().slice(0, 10);

  db.prepare(`
    INSERT OR REPLACE INTO net_worth_snapshots (date, accounts_total, real_estate_total, net_worth)
    VALUES (?, ?, ?, ?)
  `).run(date, accounts_total, real_estate_total, net_worth);

  console.log(`[${date}] Net worth snapshot: $${net_worth.toLocaleString()}`);
}

const LAST_RE_REFRESH = 'last_real_estate_refresh';

// Run every provider refresh to completion and report which ones failed, rather
// than letting the first rejection abort the rest. A provider being briefly
// unreachable must not cost the day its snapshot: the DB still holds the other
// providers' balances, and skipping the write would leave a hole in net-worth
// history that only a full backfill can repair.
async function settleRefreshes(jobs: { label: string; run: () => Promise<void> }[]): Promise<Set<string>> {
  const results = await Promise.allSettled(jobs.map(j => j.run()));
  const failed = new Set<string>();
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      failed.add(jobs[i].label);
      console.error(`[refresh] ${jobs[i].label} failed:`, r.reason);
    }
  });
  return failed;
}

// Full refresh: pull latest from all account sources + Zillow, then snapshot.
// Forces a fresh SimpleFIN fetch (bypasses the daily cache) since this is the
// explicit "Sync now" action — newly-linked accounts should appear at once.
// Records the real-estate refresh time too, so the Setup "last synced" readout
// reflects that this path also pulled property values.
// This one is user-initiated, so it still reports failure after snapshotting —
// "Sync now" must not claim success when a provider didn't sync.
export async function refreshAndSnapshot(): Promise<void> {
  const failed = await settleRefreshes([
    { label: 'SimpleFIN', run: () => refreshAllAccounts(true) },
    { label: 'Plaid', run: () => refreshAllPlaid() },
    { label: 'real estate', run: () => refreshAllProperties() },
  ]);
  // Only stamp the real-estate clock on an actual refresh — stamping it after a
  // failure would suppress the startup catch-up for another 15 days.
  if (!failed.has('real estate')) setMeta(LAST_RE_REFRESH, new Date().toISOString());
  takeSnapshot();
  if (failed.size) throw new Error(`refresh failed for: ${[...failed].join(', ')}`);
}

// Accounts only (SimpleFIN + Plaid), then snapshot. Leaves real estate untouched.
// Forces a fresh SimpleFIN fetch: this is the scheduled daily refresh, and the
// 23h read-cache is also warmed by ordinary page views — so without force a
// casual visit before 6 AM would make the cron a no-op and new transactions /
// balances wouldn't sync until the cache happened to expire.
// Unattended: a failing provider is logged, and the snapshot still happens.
export async function refreshAccountsAndSnapshot(): Promise<void> {
  await settleRefreshes([
    { label: 'SimpleFIN', run: () => refreshAllAccounts(true) },
    { label: 'Plaid', run: () => refreshAllPlaid() },
  ]);
  takeSnapshot();
}

// Real estate only (Zillow), then snapshot. Leaves accounts untouched.
export async function refreshRealEstateAndSnapshot(): Promise<void> {
  const failed = await settleRefreshes([
    { label: 'real estate', run: () => refreshAllProperties() },
  ]);
  if (!failed.size) setMeta(LAST_RE_REFRESH, new Date().toISOString());
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

export function getNetWorthHistory(days = 90): unknown[] {
  const db = getDb();
  // Take the most recent `days` rows, but keep them in ascending order so the
  // backfill-artifact check below sees the oldest point of the window first.
  const rows = db.prepare(`
    SELECT * FROM (
      SELECT date, accounts_total, real_estate_total, net_worth
      FROM net_worth_snapshots
      ORDER BY date DESC
      LIMIT ?
    ) ORDER BY date ASC
  `).all(days) as { date: string; accounts_total: number; real_estate_total: number; net_worth: number }[];

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

export function getCurrentBreakdown() {
  const db = getDb();

  const accounts = db.prepare(`
    SELECT id, org_name,
           COALESCE(custom_name, name) AS name,
           (custom_name IS NOT NULL) AS renamed,
           balance, currency, category, hidden, updated_at
    FROM accounts
    ORDER BY org_name, name
  `).all();

  const manualAssets = db.prepare(`
    SELECT id, name, category, value, interest_rate, updated_at FROM manual_assets ORDER BY name
  `).all();

  const properties = db.prepare(`
    SELECT id, address, zestimate, mortgage_balance,
           mortgage_principal, mortgage_rate, mortgage_start, mortgage_term_years,
           property_tax_annual, insurance_annual, hoa_annual, rental_income_annual, updated_at
    FROM properties ORDER BY address
  `).all();

  return { accounts, manualAssets, properties };
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
