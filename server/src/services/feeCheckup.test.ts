import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Allocation, HoldingRow } from './allocation.js';

// getFeeCheckup glues the allocation's holdings to expense ratios and tax
// buckets. Every dependency with I/O is mocked: no database, no network.
const prefs: Record<string, string> = {};
const accounts = [
  { id: 'a1', name: 'Individual', display: 'Individual', org_name: 'Fidelity' },
  { id: 'a2', name: 'Rollover IRA', display: 'Rollover IRA', org_name: 'Fidelity' },
  { id: 'a3', name: 'Joint', display: 'Joint', org_name: 'Vanguard' },
];
vi.mock('../db/schema.js', () => ({ getDb: () => ({ prepare: () => ({ all: () => accounts }) }) }));
vi.mock('./prefs.js', () => ({ getAllPrefs: () => prefs, setPref: (k: string, v: string) => { prefs[k] = v; } }));
const quoteTypes: Record<string, string | null> = { VTI: 'ETF', BND: 'ETF', AAPL: 'EQUITY', MYST: 'MUTUALFUND', GBTC: 'ETF' };
const metaCalls: string[] = [];
vi.mock('./yahooMeta.js', () => ({
  fetchSecurityMeta: async (s: string) => { metaCalls.push(s); return { quoteType: quoteTypes[s] ?? null }; },
}));
const ratios: Record<string, number | null> = { VTI: 0.0003, BND: 0.0003, MYST: null, GBTC: 0.015 };
const lookups: string[] = [];
vi.mock('./expenseRatios.js', async () => {
  const { parseOverrides } = await import('../util/expenseRatio.js');
  return {
    fetchExpenseRatio: async (s: string) => { lookups.push(s); return ratios[s] ?? null; },
    getExpenseOverrides: () => parseOverrides(prefs['mon.expenseRatioOverrides']),
  };
});
// The tickers the institutions reported; 'ITOT' is deliberately absent — it is
// the proxy getAllocation shows for an untickered "Total Market" 529 portfolio.
// Reported by a1, a visible brokerage account (only those count as reported).
type Pos = { symbol: string; description?: string; marketValue?: number };
const DEFAULT_POSITIONS = (): Map<string, Pos[]> =>
  new Map([['a1', ['VTI', 'BND', 'AAPL', 'MYST', 'BTC', 'GBTC', ''].map(symbol => ({ symbol }))]]);
let positions = DEFAULT_POSITIONS();
vi.mock('./simplefin.js', () => ({ fetchHoldings: async () => positions }));
vi.mock('./allocation.js', () => ({
  holdingId: (symbol: string, name: string) => (symbol && symbol.trim() ? symbol.trim() : name.trim()),
  getAllocation: async () => { throw new Error('pass an allocation'); },
}));

const h = (symbol: string, name: string, assetClass: string, accts: [string, number][]): HoldingRow => ({
  symbol, name, assetClass, value: accts.reduce((s, [, v]) => s + v, 0),
  accounts: accts.map(([n, v]) => ({ name: n, value: v })),
  costBasis: null, costBasisCoveredValue: 0, costBasisComplete: true, costBasisSource: null, pct: 0, overridden: false,
});

function alloc(holdings: HoldingRow[]): Allocation {
  return {
    total: 0, holdings, bySector: [], byStock: [], byCountry: [], assetClasses: [], realEstate: [],
    byAssetClass: [
      { name: 'Domestic Stock', value: 0, pct: 0, contributors: [{ label: 'VTI', value: 60_000 }, { label: 'AAPL', value: 20_000 }] },
      { name: 'Bonds', value: 0, pct: 0, contributors: [{ label: 'BND', value: 40_000 }] },
    ],
  };
}

const BASE_ACCOUNTS = accounts.map(x => ({ ...x }));
beforeEach(() => {
  for (const k of Object.keys(prefs)) delete prefs[k];
  metaCalls.length = 0; lookups.length = 0;
  positions = DEFAULT_POSITIONS();
  accounts.splice(0, accounts.length, ...BASE_ACCOUNTS.map(x => ({ ...x })));
});

describe('getFeeCheckup', () => {
  const holdings = () => [
    h('VTI', 'Vanguard Total Stock', 'Domestic Stock', [['Individual', 30_000], ['Rollover IRA', 30_000]]),
    h('BND', 'Vanguard Total Bond', 'Bonds', [['Individual', 40_000]]),
    h('AAPL', 'Apple Inc', 'Domestic Stock', [['Joint', 20_000]]),
    h('MYST', 'Mystery Fund', 'Uncategorized', [['Rollover IRA', 10_000]]),
    h('', 'Cash', 'Short Term', [['Individual', 5_000]]),
    h('BTC', 'Bitcoin', 'Crypto', [['Joint', 2_000]]),
    h('GBTC', 'Grayscale Bitcoin Trust', 'Crypto', [['Joint', 1_000]]),
    // Home equity / manual assets have no accounts: excluded from both views.
    h('', '1 Main St', 'Real Estate', []),
  ];

  it('prices every holding and sums the yearly cost (hand-checked)', async () => {
    const { getFeeCheckup } = await import('./feeCheckup.js');
    const r = await getFeeCheckup(alloc(holdings()));
    const by = Object.fromEntries(r.rows.map(x => [x.id, x]));
    expect(by.VTI).toMatchObject({ expenseRatio: 0.0003, source: 'provider' });
    expect(by.AAPL).toMatchObject({ expenseRatio: 0, source: 'stock' });
    expect(by.Cash).toMatchObject({ expenseRatio: 0, source: 'cash' });
    expect(by.BTC).toMatchObject({ expenseRatio: 0, source: 'not-fund' });
    expect(by.GBTC).toMatchObject({ expenseRatio: 0.015, source: 'provider' });
    expect(by.MYST).toMatchObject({ expenseRatio: null, source: 'unknown', annualCost: null });
    expect(r.rows.find(x => x.name === '1 Main St')).toBeUndefined();
    // Costs: VTI 60k×0.03% = 18 ; BND 40k×0.03% = 12 ; GBTC 1k×1.5% = 15 → 45.
    expect(r.totalAnnualCost).toBeCloseTo(45, 8);
    // Covered = 60k + 40k + 20k + 5k + 2k + 1k = 128k of 138k.
    expect(r.coveredValue).toBe(128_000);
    expect(r.totalValue).toBe(138_000);
    expect(r.weightedRatio).toBeCloseTo(45 / 128_000, 12);
    expect(r.largestId).toBe('VTI');
    // Coins are never looked up; stocks aren't sent for a fee lookup.
    expect(metaCalls).not.toContain('BTC');
    expect(lookups.sort()).toEqual(['BND', 'GBTC', 'MYST', 'VTI']);
  });

  it('never prices an untickered fund by its proxy ticker', async () => {
    ratios.ITOT = 0.0003;
    quoteTypes.ITOT = 'ETF';
    const { getFeeCheckup } = await import('./feeCheckup.js');
    const r = await getFeeCheckup(alloc([h('ITOT', 'CollegeAmerica Total Market Portfolio', 'Domestic Stock', [['Individual', 25_000]])]));
    expect(r.rows[0]).toMatchObject({ id: 'ITOT', expenseRatio: null, source: 'unknown' });
    expect(lookups).not.toContain('ITOT');
    expect(metaCalls).not.toContain('ITOT');
    expect(r.coverage).toBe(0);
  });

  it('lets the user figure win and skips the lookup', async () => {
    prefs['mon.expenseRatioOverrides'] = JSON.stringify({ MYST: 0.008, VTI: 0.0004 });
    const { getFeeCheckup } = await import('./feeCheckup.js');
    const r = await getFeeCheckup(alloc(holdings()));
    const by = Object.fromEntries(r.rows.map(x => [x.id, x]));
    expect(by.MYST).toMatchObject({ expenseRatio: 0.008, source: 'manual', annualCost: 80 });
    expect(by.VTI).toMatchObject({ expenseRatio: 0.0004, source: 'manual' });
    expect(lookups).not.toContain('VTI');
    expect(r.coverage).toBe(1);
  });

  it('builds the location table with the Forecast reassignments applied', async () => {
    prefs['mon.fcBucketOverrides'] = JSON.stringify({ a3: 'roth' }); // "Joint" reassigned to Roth
    const { getFeeCheckup } = await import('./feeCheckup.js');
    const { location } = await getFeeCheckup(alloc(holdings()));
    expect(location.cells.Bonds).toEqual({ taxable: 40_000 });
    expect(location.cells['Domestic Stock']).toEqual({ taxable: 30_000, pretax: 30_000, roth: 20_000 });
    expect(location.cells.Uncategorized).toEqual({ pretax: 10_000 });
    expect(location.cells.Crypto).toEqual({ roth: 3_000 });
    expect(location.total).toBe(138_000);
    expect(location.observations).toEqual([{ kind: 'bonds-taxable', amount: 40_000 }]);
  });

  it('never prices a proxied 529 portfolio, even when a hidden account reports the proxy ticker', async () => {
    // The 529 (a4, visible) holds an untickered "Total Market Index Portfolio",
    // shown as ITOT. A hidden account reports real ITOT: it must not count.
    accounts.push({ id: 'a4', name: '529 Plan', display: '529 Plan', org_name: 'State Plan' });
    positions = new Map([
      ['a4', [{ symbol: '', description: 'Total Market Index Portfolio', marketValue: 100_000 }]],
      ['hidden1', [{ symbol: 'ITOT', description: 'iShares Core S&P Total U.S. Stock Market ETF', marketValue: 5_000 }]],
    ]);
    ratios.ITOT = 0.0003; quoteTypes.ITOT = 'ETF';
    const { getFeeCheckup } = await import('./feeCheckup.js');
    const r = await getFeeCheckup(alloc([h('ITOT', 'Total Market Index Portfolio', 'Domestic Stock', [['529 Plan', 100_000]])]));
    expect(r.rows[0]).toMatchObject({ expenseRatio: null, source: 'unknown', annualCost: null });
    expect(lookups).not.toContain('ITOT');
    expect(r.totalAnnualCost).toBe(0);
  });

  it('leaves a row unknown when a proxied position is merged into a real ticker\'s row', async () => {
    // a1 reports real ITOT ($20k); the 529 (a4) holds an untickered Total Market
    // portfolio ($80k) that getAllocation merges into the same ITOT row.
    // Pricing the whole $100k at ITOT's 0.03% ($30/yr) would understate the
    // plan's fee, so the row stays unknown until the user enters a figure.
    accounts.push({ id: 'a4', name: '529 Plan', display: '529 Plan', org_name: 'State Plan' });
    positions = new Map([
      ['a1', [{ symbol: 'ITOT', description: 'iShares Core S&P Total U.S. Stock Market ETF', marketValue: 20_000 }]],
      ['a4', [{ symbol: '', description: 'Total Market Index Portfolio', marketValue: 80_000 }]],
    ]);
    ratios.ITOT = 0.0003; quoteTypes.ITOT = 'ETF';
    const { getFeeCheckup } = await import('./feeCheckup.js');
    const r = await getFeeCheckup(alloc([h('ITOT', 'iShares Core S&P Total U.S. Stock Market ETF', 'Domestic Stock', [['Individual', 20_000], ['529 Plan', 80_000]])]));
    expect(r.rows[0]).toMatchObject({ expenseRatio: null, source: 'unknown' });
    expect(lookups).not.toContain('ITOT');
    // A figure the user enters still applies.
    prefs['mon.expenseRatioOverrides'] = JSON.stringify({ ITOT: 0.002 });
    const r2 = await getFeeCheckup(alloc([h('ITOT', 'iShares Core S&P Total U.S. Stock Market ETF', 'Domestic Stock', [['Individual', 20_000], ['529 Plan', 80_000]])]));
    expect(r2.rows[0]).toMatchObject({ expenseRatio: 0.002, source: 'manual', annualCost: 200 }); // 100,000 × 0.2%
  });

  it('does not send options or CUSIP-held Treasury bills for a fund-fee lookup', async () => {
    positions = new Map([['a1', [{ symbol: '912797KX4' }, { symbol: '-AAPL250117C150' }, { symbol: 'VTI' }]]]);
    const { getFeeCheckup } = await import('./feeCheckup.js');
    const r = await getFeeCheckup(alloc([
      h('912797KX4', 'UNITED STATES TREAS BILLS', 'Short Term', [['Individual', 50_000]]),
      h('-AAPL250117C150', 'CALL APPLE INC $150 EXP 01/17/25', 'Options', [['Individual', 3_000]]),
      h('VTI', 'Vanguard Total Stock', 'Domestic Stock', [['Individual', 50_000]]),
    ]));
    const by = Object.fromEntries(r.rows.map(x => [x.id, x]));
    expect(by['912797KX4']).toMatchObject({ expenseRatio: 0, source: 'not-fund', annualCost: 0 });
    expect(by['-AAPL250117C150']).toMatchObject({ expenseRatio: 0, source: 'not-fund' });
    expect(r.unknownCount).toBe(0);
    expect(r.coverage).toBe(1);
    expect(lookups).toEqual(['VTI']);
    expect(metaCalls).not.toContain('912797KX4');
    // VTI 50k × 0.03% = $15, over 103k covered.
    expect(r.totalAnnualCost).toBeCloseTo(15, 8);
  });

  it('keeps a muni fund in the Bonds row but out of the "bonds in taxable accounts" note', async () => {
    positions = new Map([['a1', [{ symbol: 'VTEB' }, { symbol: 'BND' }]]]);
    quoteTypes.VTEB = 'ETF'; ratios.VTEB = 0.0005;
    const { getFeeCheckup } = await import('./feeCheckup.js');
    const munis = [h('VTEB', 'Vanguard Tax-Exempt Bond Index Fund ETF', 'Bonds', [['Individual', 80_000]]),
      h('VTI', 'Vanguard Total Stock', 'Domestic Stock', [['Rollover IRA', 120_000]])];
    const { location } = await getFeeCheckup(alloc(munis));
    expect(location.cells.Bonds).toEqual({ taxable: 80_000 });
    expect(location.observations).toEqual([]);
    // A taxable bond fund beside it is still noted, for its own $40k only.
    const { location: mixed } = await getFeeCheckup(alloc([...munis, h('BND', 'Vanguard Total Bond', 'Bonds', [['Individual', 40_000]])]));
    expect(mixed.cells.Bonds).toEqual({ taxable: 120_000 });
    expect(mixed.observations).toEqual([{ kind: 'bonds-taxable', amount: 40_000 }]);
  });

  it('splits same-named accounts that resolve to different account types', async () => {
    // Two accounts both raw-named "Brokerage": b1 a taxable account at Schwab,
    // b2 at Fidelity that the user reassigned to Roth on the Forecast. VXUS:
    // $60k in b1 and $40k in b2, which getAllocation merges into one entry.
    accounts.splice(0, accounts.length,
      { id: 'b1', name: 'Brokerage', display: 'Individual', org_name: 'Schwab' },
      { id: 'b2', name: 'Brokerage', display: 'Brokerage', org_name: 'Fidelity' });
    prefs['mon.fcBucketOverrides'] = JSON.stringify({ b2: 'roth' });
    positions = new Map([
      ['b1', [{ symbol: 'VXUS', description: 'Vanguard Total International Stock ETF', marketValue: 60_000 }]],
      ['b2', [{ symbol: 'VXUS', description: 'Vanguard Total International Stock ETF', marketValue: 40_000 }]],
    ]);
    const { getFeeCheckup } = await import('./feeCheckup.js');
    const { location } = await getFeeCheckup(alloc([h('VXUS', 'Vanguard Total International Stock ETF', 'Foreign Stock', [['Brokerage', 100_000]])]));
    expect(location.cells['Foreign Stock']).toEqual({ taxable: 60_000, roth: 40_000 });
    expect(location.total).toBe(100_000);
    // $40k of foreign stock in a Roth is material (≥ $1,000 and ≥ 1%).
    expect(location.observations).toEqual([{ kind: 'foreign-sheltered', amount: 40_000 }]);
  });

  it('keeps one entry for same-named accounts of the same type', async () => {
    accounts.splice(0, accounts.length,
      { id: 'b1', name: 'Brokerage', display: 'Individual', org_name: 'Schwab' },
      { id: 'b2', name: 'Brokerage', display: 'Joint', org_name: 'Fidelity' });
    positions = new Map([['b1', [{ symbol: 'VXUS', marketValue: 60_000 }]], ['b2', [{ symbol: 'VXUS', marketValue: 40_000 }]]]);
    const { getFeeCheckup } = await import('./feeCheckup.js');
    const { location } = await getFeeCheckup(alloc([h('VXUS', 'Vanguard Total International Stock ETF', 'Foreign Stock', [['Brokerage', 100_000]])]));
    expect(location.cells['Foreign Stock']).toEqual({ taxable: 100_000 });
  });
});
