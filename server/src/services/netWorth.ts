import { getDb } from '../db/schema.js';
import { refreshAllAccounts } from './simplefin.js';
import { refreshAllPlaid } from './plaid.js';
import { refreshAllProperties } from './zillow.js';

// Recompute today's snapshot from whatever is currently in the DB.
// Does NOT call Plaid/Zillow — safe to run after every manual edit.
export function takeSnapshot(): void {
  const db = getDb();

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

  console.log(`[${date}] Net worth snapshot: $${net_worth.toLocaleString()}`);
}

// Full refresh: pull latest from all account sources + Zillow, then snapshot.
// Forces a fresh SimpleFIN fetch (bypasses the daily cache) since this is the
// explicit "Refresh Now" action — newly-linked accounts should appear at once.
export async function refreshAndSnapshot(): Promise<void> {
  await Promise.all([refreshAllAccounts(true), refreshAllPlaid(), refreshAllProperties()]);
  takeSnapshot();
}

// Accounts only (SimpleFIN + Plaid), then snapshot. Leaves real estate untouched.
export async function refreshAccountsAndSnapshot(): Promise<void> {
  await Promise.all([refreshAllAccounts(), refreshAllPlaid()]);
  takeSnapshot();
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

export function getNetWorthHistory(days = 90): unknown[] {
  const db = getDb();
  return db.prepare(`
    SELECT date, accounts_total, real_estate_total, net_worth
    FROM net_worth_snapshots
    ORDER BY date DESC
    LIMIT ?
  `).all(days);
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
    SELECT id, name, category, value, updated_at FROM manual_assets ORDER BY name
  `).all();

  const properties = db.prepare(`
    SELECT id, address, zestimate, mortgage_balance, updated_at FROM properties ORDER BY address
  `).all();

  return { accounts, manualAssets, properties };
}
