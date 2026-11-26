import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

// The stored Investments results against a real (temp-file) database: every
// kind of edit that changes the answer must stop the stored copy being served.
// The three computations themselves are counted stand-ins, since what is under
// test is WHEN they run, not what they return. Edits go through the same
// setters and statements the routes use.
const runs = { allocation: 0, estimate: 0, performance: 0, fees: 0 };
vi.mock('./allocation.js', () => ({
  getAllocation: async (opts: { estimate?: boolean } = {}) => (opts.estimate ? { estimate: ++runs.estimate } : { allocation: ++runs.allocation }),
}));
vi.mock('./performance.js', () => ({ getPerformance: async (days: number) => ({ days, performance: ++runs.performance }) }));
vi.mock('./feeCheckup.js', () => ({ getFeeCheckup: async () => ({ fees: ++runs.fees }) }));
// The build's version (a new build must not serve the old build's results).
const build = { version: '1.0.0' };
vi.mock('./data.js', () => ({ appVersion: () => build.version }));

let dir: string;
let db: Database.Database;
let closeDb: () => void;
let results: typeof import('./investmentResults.js');
let stored: typeof import('./storedResult.js');
let prefs: typeof import('./prefs.js');
let profiles: typeof import('./holdingProfiles.js');
let ratios: typeof import('./expenseRatios.js');
let cache: typeof import('../db/providerCache.js');
let prevEmail: string | undefined;

const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

async function boot() {
  vi.resetModules();
  const schema = await import('../db/schema.js');
  ({ closeDb } = schema);
  db = schema.getDb();
  results = await import('./investmentResults.js');
  stored = await import('./storedResult.js');
  prefs = await import('./prefs.js');
  profiles = await import('./holdingProfiles.js');
  ratios = await import('./expenseRatios.js');
  cache = await import('../db/providerCache.js');
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kevfin-results-'));
  process.env.DB_PATH = join(dir, 'test.db');
  prevEmail = process.env.SEC_CONTACT_EMAIL;
  delete process.env.SEC_CONTACT_EMAIL;
  delete process.env.SEC_EDGAR_UA;
  runs.allocation = runs.estimate = runs.performance = runs.fees = 0;
  build.version = '1.0.0';
  await boot();

  db.prepare(`INSERT INTO accounts (id, connection_id, org_name, name, currency, balance, category, hidden)
              VALUES ('b1', 1, 'Fidelity', 'Brokerage', 'USD', 1000, 'brokerage', 0)`).run();
  db.prepare(`INSERT INTO properties (address, zestimate, mortgage_balance) VALUES ('1 Main St', 500000, 200000)`).run();
  db.prepare(`INSERT INTO manual_assets (name, category, value) VALUES ('Gold', 'other', 5000)`).run();
  cache.writeProviderCache('sf_cache_1', { fetchedAt: 1, payload: [] });
}, 60_000); // module re-import can exceed the 10s default on a slow FS under full-suite load

afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  if (prevEmail === undefined) delete process.env.SEC_CONTACT_EMAIL;
  else process.env.SEC_CONTACT_EMAIL = prevEmail;
});

describe('the stored allocation', () => {
  it('is computed once and then served from the store', async () => {
    const a = await results.servedAllocation(false);
    const b = await results.servedAllocation(false);
    expect(a.value).toEqual({ allocation: 1 });
    expect(b).toEqual({ ...a, refreshing: false });
    expect(runs.allocation).toBe(1);
    // It is a row in provider_cache, so it outlives the process.
    expect(stored.storedResultKeys()).toEqual(['result:allocation']);
  });

  it('keeps the plain and ?estimate=1 variants apart', async () => {
    await results.servedAllocation(false);
    expect((await results.servedAllocation(true)).value).toEqual({ estimate: 1 });
    await results.servedAllocation(true);
    expect(runs).toMatchObject({ allocation: 1, estimate: 1 });
  });

  it('comes back from the database after a restart, then refreshes behind', async () => {
    const first = await results.servedAllocation(false);
    closeDb();
    await boot();
    const after = await results.servedAllocation(false);
    expect(after).toEqual({ value: { allocation: 1 }, computedAt: first.computedAt, refreshing: true });
    await settle();
    expect(await results.servedAllocation(false)).toMatchObject({ value: { allocation: 2 }, refreshing: false });
  });

  // Each of these is something the user does; the very next fetch must show it.
  const edits: [string, () => void][] = [
    ['an asset-class override (PUT /classification)', () =>
      db.prepare(`INSERT INTO asset_class_overrides (symbol, asset_class) VALUES ('VTI', 'Bonds')`).run()],
    ['a cost-basis override (PUT /cost-basis)', () =>
      db.prepare(`INSERT INTO cost_basis_overrides (symbol, cost_basis) VALUES ('VTI', 1234)`).run()],
    ['a cost basis imported from a statement', () =>
      db.prepare(`INSERT INTO imported_cost_basis (symbol, cost_basis) VALUES ('VTI', 999)`).run()],
    ['excluding a home (PUT /property-exclusion)', () =>
      db.prepare('UPDATE properties SET excluded_from_allocation = 1').run()],
    ["a home's value", () => db.prepare('UPDATE properties SET zestimate = 510000').run()],
    ["a home's mortgage balance", () => db.prepare('UPDATE properties SET mortgage_balance = 199000').run()],
    ['a new home', () => db.prepare(`INSERT INTO properties (address, zestimate, mortgage_balance) VALUES ('2 Oak Ave', 300000, 0)`).run()],
    ["a manual asset's value", () => db.prepare('UPDATE manual_assets SET value = 6000').run()],
    ['a new manual asset', () => db.prepare(`INSERT INTO manual_assets (name, category, value) VALUES ('Car', 'other', 9000)`).run()],
    ['a removed manual asset', () => db.prepare('DELETE FROM manual_assets').run()],
    ["the user's own expense ratio (PUT /expense-ratio)", () => ratios.setExpenseOverride('VTI', 0.0003)],
    ['a holding description (PUT /holding-profile)', () => profiles.setHoldingProfile('PDZJ', [{ ticker: 'VTTSX', weight: 1 }])],
    ["the Forecast's account reassignment (asset location)", () => prefs.setPref('mon.fcBucketOverrides', '{"b1":"roth"}')],
    ['hiding an account', () => db.prepare(`UPDATE accounts SET hidden = 1 WHERE id = 'b1'`).run()],
    ['renaming an account', () => db.prepare(`UPDATE accounts SET custom_name = 'Taxable' WHERE id = 'b1'`).run()],
    ["changing an account's category", () => db.prepare(`UPDATE accounts SET category = 'banking' WHERE id = 'b1'`).run()],
    ['a removed account', () => db.prepare(`DELETE FROM accounts WHERE id = 'b1'`).run()],
    ['setting the SEC contact email', () => { process.env.SEC_CONTACT_EMAIL = 'someone@example.com'; }],
    ['a new build of the app', () => { build.version = '1.0.1'; }],
  ];
  it.each(edits)('is recomputed before the next fetch after %s', async (_what, edit) => {
    await results.servedAllocation(false);
    await results.servedFeeCheckup();
    await results.servedPerformance(1825);
    edit();
    const next = await results.servedAllocation(false);
    expect(next).toMatchObject({ value: { allocation: 2 }, refreshing: false });
    // The fee check-up and the performance history are built on the same inputs.
    expect((await results.servedFeeCheckup()).value).toEqual({ fees: 2 });
    expect((await results.servedPerformance(1825)).value).toEqual({ days: 1825, performance: 2 });
    // And once recomputed, the new copy is served.
    await results.servedAllocation(false);
    expect(runs.allocation).toBe(2);
  });

  // What a sync replaces: the stored copy is still the user's own settings, so
  // it is served (flagged) while the new one is computed.
  const syncs: [string, () => void][] = [
    ['a new balance', () => db.prepare(`UPDATE accounts SET balance = 1100 WHERE id = 'b1'`).run()],
    ['a fresh holdings feed', () => cache.writeProviderCache('sf_cache_1', { fetchedAt: 2, payload: [] })],
    ['a second connection', () => cache.writeProviderCache('sf_cache_2', { fetchedAt: 2, payload: [] })],
    ['a CUSIP resolved to a ticker in the background', () => cache.writeProviderCache('figi:CUSIP:037833100', { fetchedAt: 2, payload: { ticker: 'AAPL' } })],
  ];
  it.each(syncs)('is served, marked refreshing, and recomputed behind after %s', async (_what, sync) => {
    await results.servedAllocation(false);
    sync();
    expect(await results.servedAllocation(false)).toMatchObject({ value: { allocation: 1 }, refreshing: true });
    await settle();
    expect(await results.servedAllocation(false)).toMatchObject({ value: { allocation: 2 }, refreshing: false });
  });

  it('is left alone by changes that are not its inputs', async () => {
    await results.servedAllocation(false);
    prefs.setPref('mon.allocOrder', '["assets","positions"]');
    db.prepare(`INSERT INTO net_worth_snapshots (date, accounts_total, real_estate_total, net_worth) VALUES ('2026-01-01', 1, 1, 2)`).run();
    cache.writeProviderCache('yahoo_meta:VTI', { fetchedAt: 5, payload: { quoteType: 'ETF' } });
    expect(await results.servedAllocation(false)).toMatchObject({ value: { allocation: 1 }, refreshing: false });
    expect(runs.allocation).toBe(1);
  });

  it('shares one computation between concurrent loads', async () => {
    const all = await Promise.all([results.servedAllocation(false), results.servedAllocation(false), results.servedAllocation(false)]);
    expect(all.map(s => s.value)).toEqual([{ allocation: 1 }, { allocation: 1 }, { allocation: 1 }]);
    expect(runs.allocation).toBe(1);
  });
});

describe('the stored performance history', () => {
  it('is stored per requested window', async () => {
    expect((await results.servedPerformance(1825)).value).toEqual({ days: 1825, performance: 1 });
    expect((await results.servedPerformance(365)).value).toEqual({ days: 365, performance: 2 });
    await results.servedPerformance(1825);
    await results.servedPerformance(365);
    expect(runs.performance).toBe(2);
  });
});

describe('refreshInvestmentResults', () => {
  it('does nothing before the page has ever been opened', async () => {
    results.refreshInvestmentResults();
    await settle();
    expect(runs).toEqual({ allocation: 0, estimate: 0, performance: 0, fees: 0 });
  });

  it('recomputes, with nobody waiting, each result the page has asked for', async () => {
    await results.servedAllocation(false);
    await results.servedFeeCheckup();
    await results.servedPerformance(1825);
    db.prepare(`UPDATE accounts SET balance = 1100 WHERE id = 'b1'`).run(); // a sync
    results.refreshInvestmentResults();
    await settle();
    expect(runs).toEqual({ allocation: 2, estimate: 0, performance: 2, fees: 2 });
    // The next load finds a current copy: no waiting, nothing to refresh.
    expect(await results.servedAllocation(false)).toMatchObject({ value: { allocation: 2 }, refreshing: false });
    expect(await results.servedPerformance(1825)).toMatchObject({ value: { performance: 2 }, refreshing: false });
    expect(await results.servedFeeCheckup()).toMatchObject({ value: { fees: 2 }, refreshing: false });
  });

  it('leaves current results alone', async () => {
    await results.servedAllocation(false);
    results.refreshInvestmentResults();
    await settle();
    expect(runs.allocation).toBe(1);
  });

  it('ignores a stored key this build does not know', async () => {
    cache.writeProviderCache('result:something-newer', { fetchedAt: 1, payload: { edits: 'x', feed: 'y', degraded: false, value: 1 } });
    expect(() => results.refreshInvestmentResults()).not.toThrow();
  });
});

describe('a restore or an erase', () => {
  it('drops the stored results', async () => {
    await results.servedAllocation(false);
    stored.clearStoredResults();
    expect(stored.storedResultKeys()).toEqual([]);
    expect((await results.servedAllocation(false)).value).toEqual({ allocation: 2 });
  });
});
