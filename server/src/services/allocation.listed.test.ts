import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrations.js';
import { LISTED_HOLDINGS } from '../util/assumptions.js';
import type { SecurityMeta } from './yahooMeta.js';
import type { ListedLookThrough } from './listedHoldings.js';

// Berkshire opened into its 13F stocks, end to end through getAllocation with
// every outside source stubbed: held directly, inside a fund with a full
// holdings list, and inside a fund known only by its Yahoo top holdings. The
// point is the money: every view must still add up to the same total, with
// nothing counted twice or lost.
const s = vi.hoisted(() => ({
  db: null as unknown,
  holdings: new Map<string, unknown[]>(),
  metas: new Map<string, unknown>(),
  deep: new Map<string, unknown>(),
  listed: new Map<string, unknown>(),
}));
vi.mock('../db/schema.js', () => ({ getDb: () => s.db }));
vi.mock('./simplefin.js', () => ({ fetchHoldings: async () => s.holdings }));
vi.mock('./yahooMeta.js', () => ({ fetchSecurityMeta: async (sym: string) => s.metas.get(sym) ?? emptyMeta() }));
vi.mock('./fundHoldings.js', async () => {
  const real = await vi.importActual<typeof import('./fundHoldings.js')>('./fundHoldings.js');
  return { mergeConstituents: real.mergeConstituents, fetchDeepConstituents: async (sym: string) => s.deep.get(sym) ?? null };
});
vi.mock('./listedHoldings.js', async () => {
  const real = await vi.importActual<typeof import('./listedHoldings.js')>('./listedHoldings.js');
  return { ...real, fetchListedLookThroughs: async () => s.listed };
});
vi.mock('./secCompany.js', () => ({ fetchSecCompanyProfile: async () => null }));
vi.mock('./holdingProfiles.js', () => ({ getHoldingProfiles: () => new Map(), getHoldingProfile: () => null, primaryTicker: () => '' }));
vi.mock('./figi.js', () => ({ knownTicker: () => undefined, queueTickerLookups: () => {} }));

function emptyMeta(): SecurityMeta {
  return { quoteType: null, sector: null, country: null, sectorWeightings: null, holdings: null, family: null, composition: null, bonds: null };
}
const pos = (symbol: string, description: string, marketValue: number) => ({ symbol, description, marketValue, costBasis: null, shares: null, acquired: null });

// A quarter of Berkshire is listed stocks: Apple (15%) and Chubb (10%).
const BERKSHIRE: ListedLookThrough = {
  key: 'BRK', symbol: 'BRK-B', remainderName: LISTED_HOLDINGS.BRK.remainderName,
  asOf: '2026-09-30', filed: '2026-11-16', marketCap: 1e12, listedShare: 0.25, sector: 'Financial Services',
  note: '25.0% of Berkshire Hathaway is the listed stocks in its 13F filing…',
  positions: [
    { symbol: 'AAPL', name: 'APPLE INC', cusip: '037833100', value: 1.5e11, share: 0.15, sector: 'Technology', country: 'United States' },
    { symbol: 'CB', name: 'CHUBB LIMITED', cusip: 'H1467J104', value: 1e11, share: 0.1, sector: 'Financial Services', country: 'Switzerland' },
  ],
};

let getAllocation: typeof import('./allocation.js').getAllocation;

beforeEach(async () => {
  const db = new Database(':memory:');
  runMigrations(db);
  db.prepare("INSERT INTO accounts (id, org_name, name, balance, category, hidden) VALUES ('a1', 'Broker', 'Brokerage', 0, 'brokerage', 0)").run();
  s.db = db;
  for (const m of [s.holdings, s.metas, s.deep, s.listed]) m.clear();
  s.holdings.set('a1', [
    pos('BRK.B', 'Berkshire Hathaway Inc Class B', 1000),
    pos('VTI', 'Vanguard Total Stock Market ETF', 10000),
    pos('SPY', 'SPDR S&P 500 ETF', 5000),
  ]);
  s.metas.set('BRK.B', { ...emptyMeta(), quoteType: 'EQUITY', sector: 'Financial Services', country: 'United States' });
  s.metas.set('VTI', { ...emptyMeta(), quoteType: 'ETF', sectorWeightings: { Technology: 0.6, 'Financial Services': 0.4 }, composition: { stock: 0.99, bond: 0, cash: 0.01, other: 0 } });
  s.deep.set('VTI', [
    { symbol: 'AAPL', name: 'APPLE INC', percent: 0.5, country: 'United States' },
    { symbol: 'MSFT', name: 'MICROSOFT', percent: 0.47, country: 'United States' },
    { symbol: 'BERKSHIRE HATHAWAY', name: 'BERKSHIRE HATHAWAY INC-CL B', percent: 0.02, country: 'United States', named: true },
    { symbol: '— cash —', name: 'Cash', percent: 0.01, country: 'Bonds / Commodities / Cash', kind: 'cash' },
  ]);
  s.metas.set('SPY', { ...emptyMeta(), quoteType: 'ETF', sectorWeightings: { Technology: 0.5, 'Financial Services': 0.5 },
    holdings: [{ symbol: 'AAPL', name: 'Apple', percent: 0.07 }, { symbol: 'BRK-B', name: 'Berkshire', percent: 0.02 }] });
  ({ getAllocation } = await import('./allocation.js'));
});

const sum = (xs: { value: number }[]) => xs.reduce((a, x) => a + x.value, 0);

describe('Berkshire look-through in getAllocation', () => {
  it('keeps every view’s total, and the per-holding totals, unchanged', async () => {
    const before = await getAllocation();
    s.listed.set('BRK', BERKSHIRE);
    const after = await getAllocation();
    expect(after.total).toBe(16000);
    for (const a of [before, after]) {
      expect(sum(a.byStock)).toBeCloseTo(16000, 6);
      expect(sum(a.bySector)).toBeCloseTo(16000, 6);
      expect(sum(a.byCountry)).toBeCloseTo(16000, 6);
    }
    // Each holding still contributes exactly its own value to each view.
    for (const view of ['bySector', 'byCountry'] as const) {
      for (const label of ['BRK.B', 'VTI', 'SPY']) {
        const of = (a: typeof after) => a[view].reduce((t, sl) => t + (sl.contributors.find(c => c.label === label)?.value ?? 0), 0);
        expect(of(after), `${view} ${label}`).toBeCloseTo(of(before), 6);
      }
    }
    expect(after.holdings.map(h => [h.symbol, h.value])).toEqual(before.holdings.map(h => [h.symbol, h.value]));
  });

  it('splits Berkshire’s dollars between its stocks and what stays, without losing any', async () => {
    s.listed.set('BRK', BERKSHIRE);
    const a = await getAllocation();
    const stock = (sym: string) => a.byStock.find(x => x.symbol === sym);
    const berkshire = 1000 + 10000 * 0.02 + 5000 * 0.02; // direct + inside VTI + inside SPY
    expect(stock('BRK-B')?.value).toBeCloseTo(berkshire * 0.75);
    expect(stock('BRK-B')?.name).toBe('Berkshire Hathaway (own businesses and cash)');
    expect(stock('BRK-B')?.note).toBe(BERKSHIRE.note);
    expect(stock('CB')?.value).toBeCloseTo(berkshire * 0.1);
    expect(stock('AAPL')?.value).toBeCloseTo(10000 * 0.5 + 5000 * 0.07 + berkshire * 0.15);
    expect(a.byStock.some(x => x.symbol === 'BRK.B' || x.symbol === 'BERKSHIRE HATHAWAY')).toBe(false);
    // "Exposure via" says which Apple came through Berkshire.
    const via = Object.fromEntries(stock('AAPL')!.sources.map(x => [x.label, x.value]));
    expect(via['VTI via BRK-B']).toBeCloseTo(10000 * 0.02 * 0.15);
    expect(via['SPY via BRK-B']).toBeCloseTo(5000 * 0.02 * 0.15);
    expect(via['Direct holding via BRK-B']).toBeCloseTo(1000 * 0.15);
    expect(via.VTI).toBeCloseTo(5000);
  });

  it('moves the opened part into its stocks’ sectors and countries', async () => {
    const before = await getAllocation();
    s.listed.set('BRK', BERKSHIRE);
    const after = await getAllocation();
    const sector = (a: typeof after, n: string) => a.bySector.find(x => x.name === n)?.value ?? 0;
    const berkshire = 1300;
    // Apple's 15% leaves Financial Services for Technology; Chubb's 10% stays.
    expect(sector(after, 'Technology') - sector(before, 'Technology')).toBeCloseTo(berkshire * 0.15);
    expect(sector(after, 'Financial Services') - sector(before, 'Financial Services')).toBeCloseTo(-berkshire * 0.15);
    // Chubb is Swiss: from the direct holding and from VTI's full list (SPY's
    // countries come from its name, not its holdings, so it adds none).
    expect(after.byCountry.find(x => x.name === 'Switzerland')?.value).toBeCloseTo(1000 * 0.1 + 10000 * 0.02 * 0.1);
  });

  it('leaves Berkshire whole when it can’t be opened', async () => {
    const a = await getAllocation();
    const brk = a.byStock.find(x => x.symbol === 'BRK.B')!;
    expect(brk.value).toBeCloseTo(1000);
    expect(brk.note).toBeUndefined();
    expect(a.byStock.some(x => x.name === 'Berkshire Hathaway (own businesses and cash)')).toBe(false);
  });
});

describe('a feeder fund whose master couldn’t be found', () => {
  it('shows as the fund itself: its own row, abroad by its name, not a US "stock"', async () => {
    s.holdings.set('a1', [pos('DFEMX', 'DFA Emerging Markets Portfolio', 5000)]);
    s.metas.set('DFEMX', { ...emptyMeta(), quoteType: 'MUTUALFUND' });
    // What fundHoldings.ts returns for it (see fundHoldings.test.ts).
    s.deep.set('DFEMX', [{ symbol: 'DFEMX', name: 'Emerging Markets Portfolio', percent: 1, fund: true }]);
    const a = await getAllocation();
    expect(a.byStock.map(x => [x.symbol, x.name, x.value])).toEqual([['DFEMX', 'Emerging Markets Portfolio', 5000]]);
    expect(a.byCountry.map(x => [x.name, x.value])).toEqual([['International / Other', 5000]]);
    expect(a.holdings[0].assetClass).toBe('Foreign Stock');
  });
});
