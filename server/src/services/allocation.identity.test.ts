import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrations.js';
import type { SecurityMeta } from './yahooMeta.js';

// One company, one row in "What you own" — and two companies never one row —
// end to end through getAllocation with every outside source stubbed (as in
// allocation.listed.test.ts). Sightings are resolved by ISIN / CUSIP, not by
// the symbol string (util/companyIdentity.ts); the dollars must not move.
const s = vi.hoisted(() => ({
  db: null as unknown,
  holdings: new Map<string, unknown[]>(),
  metas: new Map<string, unknown>(),
  deep: new Map<string, unknown>(),
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
  return { ...real, fetchListedLookThroughs: async () => new Map() };
});
vi.mock('./secCompany.js', () => ({ fetchSecCompanyProfile: async () => null }));
vi.mock('./holdingProfiles.js', () => ({ getHoldingProfiles: () => new Map(), getHoldingProfile: () => null, primaryTicker: () => '' }));
vi.mock('./figi.js', () => ({ knownTicker: () => undefined, queueTickerLookups: () => {} }));

function emptyMeta(): SecurityMeta {
  return { quoteType: null, sector: null, country: null, sectorWeightings: null, holdings: null, family: null, composition: null, bonds: null };
}
const pos = (symbol: string, description: string, marketValue: number) => ({ symbol, description, marketValue, costBasis: null, shares: null, acquired: null });
const etf = (): SecurityMeta => ({ ...emptyMeta(), quoteType: 'ETF', sectorWeightings: { Technology: 1 } });

let getAllocation: typeof import('./allocation.js').getAllocation;

beforeEach(async () => {
  const db = new Database(':memory:');
  runMigrations(db);
  db.prepare("INSERT INTO accounts (id, org_name, name, balance, category, hidden) VALUES ('a1', 'Broker', 'Brokerage', 0, 'brokerage', 0)").run();
  db.prepare("INSERT INTO accounts (id, org_name, name, balance, category, hidden) VALUES ('a2', 'Broker', 'Roth IRA', 0, 'brokerage', 0)").run();
  s.db = db;
  for (const m of [s.holdings, s.metas, s.deep]) m.clear();
  s.holdings.set('a1', [
    pos('ACN', 'ACCENTURE PLC IRELAND SHS CLASS A', 1000),
    pos('VTI', 'Vanguard Total Stock Market ETF', 10000),
    pos('VXUS', 'Vanguard Total International Stock ETF', 4000),
  ]);
  s.holdings.set('a2', [
    pos('VTI', 'Vanguard Total Stock Market ETF', 2000),
    pos('DFEMX', 'DFA Emerging Markets Portfolio', 3000),
    pos('QQQ', 'Invesco QQQ Trust', 1000),
  ]);
  s.metas.set('ACN', { ...emptyMeta(), quoteType: 'EQUITY', sector: 'Technology', country: 'Ireland' });
  for (const f of ['VTI', 'VXUS', 'DFEMX', 'QQQ']) s.metas.set(f, etf());
  s.deep.set('VTI', [
    { symbol: 'GOOGL', name: 'ALPHABET INC-A', percent: 0.3, country: 'United States', isin: 'US02079K3059' },
    { symbol: 'GOOG', name: 'ALPHABET INC-C', percent: 0.2, country: 'United States', isin: 'US02079K1079' },
    { symbol: 'ACN', name: 'ACCENTURE PLC-A', percent: 0.1, country: 'Ireland', isin: 'IE00B4BNMY34' },
    { symbol: 'AAPL', name: 'APPLE INC', percent: 0.4, country: 'United States', isin: 'US0378331005' },
  ]);
  // QQQ's N-PORT has no tickers; the SEC name map calls both classes GOOGL.
  s.deep.set('QQQ', [
    { symbol: 'GOOGL', name: 'Alphabet Inc', percent: 0.5, country: 'United States', isin: 'US02079K1079' },
    { symbol: 'AAPL', name: 'Apple Inc', percent: 0.5, country: 'United States', isin: 'US0378331005' },
  ]);
  s.deep.set('VXUS', [
    { symbol: '2330', name: 'TSMC', percent: 0.25, country: 'Taiwan', isin: 'TW0002330008' },
    { symbol: 'BN', name: 'BROOKFIELD CORP', percent: 0.25, country: 'Canada', isin: 'CA11271J1075' },
    { symbol: 'BN', name: 'DANONE', percent: 0.25, country: 'France', isin: 'FR0000120644' },
    { symbol: '2628', name: 'CHINA LIFE-H', percent: 0.02, country: 'China', isin: 'CNE1000002L3' },
    { symbol: '1336', name: 'NEW CHINA LIFE-H', percent: 0.01, country: 'China', isin: 'CNE100001922' },
    { symbol: '— cash —', name: 'Cash', percent: 0.05, country: 'Bonds / Commodities / Cash', kind: 'cash' },
  ]);
  s.deep.set('DFEMX', [
    { symbol: 'TSM', name: 'Taiwan Semiconductor Manufacturing Co Ltd', percent: 0.6, country: 'Taiwan', isin: 'TW0002330008' },
    { symbol: 'TAIWAN SEMICONDUCTOR MANUFACTURING', name: 'TAIWAN SEMICONDUCTOR MANUFACTURING', percent: 0.1, country: 'Taiwan', isin: 'TW0002330008', named: true },
    // Two insurers whose names reduce to one key, CHINA LIFE INSURANCE.
    { symbol: 'CHINA LIFE INSURANCE', name: 'China Life Insurance Co Ltd', percent: 0.05, country: 'China', isin: 'CNE1000002L3', named: true },
    { symbol: 'CHINA LIFE INSURANCE', name: 'New China Life Insurance Co Ltd', percent: 0.05, country: 'China', isin: 'CNE100001922', named: true },
  ]);
  ({ getAllocation } = await import('./allocation.js'));
});

const sum = (xs: { value: number }[]) => xs.reduce((a, x) => a + x.value, 0);

describe('stock rows by company in getAllocation', () => {
  it('shows TSMC once, under TSM, with both funds as sources', async () => {
    const a = await getAllocation();
    const rows = a.byStock.filter(x => x.symbol === 'TSM' || x.symbol === '2330' || x.aliases?.includes('2330'));
    expect(rows).toHaveLength(1);
    const tsm = rows[0];
    expect(tsm.symbol).toBe('TSM');
    expect(tsm.name).toBe('Taiwan Semiconductor Manufacturing Co Ltd');
    expect(tsm.aliases).toEqual(['2330']);
    expect(tsm.value).toBeCloseTo(3000 * 0.7 + 4000 * 0.25);
    expect(Object.fromEntries(tsm.sources.map(x => [x.label, x.value]))).toEqual({ DFEMX: 2100, VXUS: 1000 });
    // DFEMX is in the Roth, VXUS in the brokerage account.
    expect(Object.fromEntries(tsm.accounts.map(x => [x.name, x.value]))).toEqual({ 'Roth IRA': 2100, Brokerage: 1000 });
  });

  it('keeps Brookfield and Danone apart though both are “BN”', async () => {
    const a = await getAllocation();
    const bn = a.byStock.filter(x => x.symbol === 'BN').map(x => [x.name, x.value]);
    expect(bn).toEqual([['BROOKFIELD CORP', 1000], ['DANONE', 1000]]);
    expect(a.byStock.filter(x => x.symbol === 'BN').every(x => !x.aliases)).toBe(true);
  });

  it('keeps China Life and New China Life apart though their names key alike', async () => {
    const a = await getAllocation();
    const of = (sym: string) => a.byStock.filter(x => x.symbol === sym).map(x => [x.name, x.value, x.aliases]);
    expect(of('2628')).toEqual([['CHINA LIFE-H', 3000 * 0.05 + 4000 * 0.02, undefined]]);
    expect(of('1336')).toEqual([['NEW CHINA LIFE-H', 3000 * 0.05 + 4000 * 0.01, undefined]]);
  });

  it('joins GOOGL and GOOG, from every fund', async () => {
    const a = await getAllocation();
    const alphabet = a.byStock.filter(x => x.symbol === 'GOOGL' || x.symbol === 'GOOG');
    expect(alphabet).toHaveLength(1);
    expect(alphabet[0].symbol).toBe('GOOGL');
    expect(alphabet[0].aliases).toEqual(['GOOG']);
    expect(alphabet[0].value).toBeCloseTo(12000 * 0.5 + 1000 * 0.5);
    expect(Object.fromEntries(alphabet[0].sources.map(x => [x.label, x.value]))).toEqual({ VTI: 6000, QQQ: 500 });
  });

  it('joins a direct holding to its fund sightings', async () => {
    const a = await getAllocation();
    const acn = a.byStock.filter(x => x.symbol === 'ACN');
    expect(acn).toHaveLength(1);
    expect(acn[0].value).toBeCloseTo(1000 + 12000 * 0.1);
    expect(Object.fromEntries(acn[0].sources.map(x => [x.label, x.value]))).toEqual({ 'Direct holding': 1000, VTI: 1200 });
    expect(acn[0].aliases).toBeUndefined();
  });

  it('moves no money: every view, source and account adds up as before', async () => {
    const a = await getAllocation();
    const total = 1000 + 10000 + 4000 + 2000 + 3000 + 1000;
    expect(a.total).toBe(total);
    expect(sum(a.byStock)).toBeCloseTo(total, 6);
    expect(sum(a.bySector)).toBeCloseTo(total, 6);
    expect(sum(a.byCountry)).toBeCloseTo(total, 6);
    expect(sum(a.byAssetClass)).toBeCloseTo(total, 6);
    // What each holding put into the stock list is exactly its own value…
    const bySource = new Map<string, number>();
    for (const row of a.byStock) for (const src of row.sources) bySource.set(src.label, (bySource.get(src.label) ?? 0) + src.value);
    expect(Object.fromEntries([...bySource].map(([k, v]) => [k, Math.round(v * 1e6) / 1e6]))).toEqual({
      'Direct holding': 1000, VTI: 12000, VXUS: 4000, DFEMX: 3000, QQQ: 1000,
    });
    // …and each account's share of every row sums to the row.
    for (const row of a.byStock) expect(sum(row.accounts)).toBeCloseTo(row.value, 6);
    // Rows: Alphabet, Apple, ACN, TSMC, Brookfield, Danone, the two insurers, and the remainders.
    expect(a.byStock.map(x => x.symbol).sort()).toEqual(['1336', '2628', 'AAPL', 'ACN', 'BN', 'BN', 'GOOGL', 'TSM', '— diversified —', '— non-equity —'].sort());
  });
});
