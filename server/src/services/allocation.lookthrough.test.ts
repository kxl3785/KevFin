import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrations.js';
import type { SecurityMeta } from './yahooMeta.js';
import type { Constituent } from './fundHoldings.js';

// getAllocation end to end, with every outside source stubbed: a brokerage
// account holding a 60/40 fund (split only), a Vanguard-style stock fund
// (full holdings), a bond fund, a stock Yahoo can't place, and an untickered
// 401(k) trust the user described as a mix.
const s = vi.hoisted(() => ({
  db: null as unknown,
  holdings: new Map<string, unknown[]>(),
  metas: new Map<string, unknown>(),
  deep: new Map<string, unknown>(),
  sec: new Map<string, unknown>(),
  profiles: new Map<string, { ticker: string; weight: number }[]>(),
}));
vi.mock('../db/schema.js', () => ({ getDb: () => s.db }));
vi.mock('./simplefin.js', () => ({ fetchHoldings: async () => s.holdings }));
vi.mock('./yahooMeta.js', () => ({ fetchSecurityMeta: async (sym: string) => s.metas.get(sym) ?? emptyMeta() }));
vi.mock('./fundHoldings.js', async () => {
  const real = await vi.importActual<typeof import('./fundHoldings.js')>('./fundHoldings.js');
  return { mergeConstituents: real.mergeConstituents, fetchDeepConstituents: async (sym: string) => s.deep.get(sym) ?? null };
});
vi.mock('./secCompany.js', () => ({ fetchSecCompanyProfile: async (sym: string) => s.sec.get(sym) ?? null }));
vi.mock('./holdingProfiles.js', () => ({ getHoldingProfiles: () => s.profiles, getHoldingProfile: () => null, primaryTicker: () => '' }));
vi.mock('./figi.js', () => ({ knownTicker: () => undefined, queueTickerLookups: () => {} }));

function emptyMeta(): SecurityMeta {
  return { quoteType: null, sector: null, country: null, sectorWeightings: null, holdings: null, family: null, composition: null, bonds: null };
}
const fund = (m: Partial<SecurityMeta>): SecurityMeta => ({ ...emptyMeta(), quoteType: 'MUTUALFUND', ...m });
const bondLump = (percent: number): Constituent => ({ symbol: '— bonds —', name: 'Bonds', percent, country: 'Bonds / Commodities / Cash', kind: 'bond' });
const pos = (symbol: string, description: string, marketValue: number) => ({ symbol, description, marketValue, costBasis: null, shares: null, acquired: null });

let getAllocation: typeof import('./allocation.js').getAllocation;

beforeEach(async () => {
  const db = new Database(':memory:');
  runMigrations(db);
  db.prepare("INSERT INTO accounts (id, org_name, name, balance, category, hidden) VALUES ('a1', 'Broker', 'Brokerage', 0, 'brokerage', 0)").run();
  s.db = db;
  for (const m of [s.holdings, s.metas, s.deep, s.sec, s.profiles]) m.clear();
  s.holdings.set('a1', [
    pos('AOR', 'iShares Core 60/40 Balanced', 10000),
    pos('VTI', 'Vanguard Total Stock Market ETF', 10000),
    pos('BND', 'Vanguard Total Bond Market ETF', 5000),
    pos('XYZ', 'Obscure Industries', 1000),
    pos('', 'BJC 401k Trust 2055', 4000),
  ]);
  s.metas.set('AOR', fund({ quoteType: 'ETF', sectorWeightings: { Technology: 0.5, Healthcare: 0.5 }, composition: { stock: 0.6, bond: 0.4, cash: 0, other: 0 } }));
  s.metas.set('VTI', fund({ quoteType: 'ETF', family: 'Vanguard', composition: { stock: 1, bond: 0, cash: 0, other: 0 } }));
  s.deep.set('VTI', [
    { symbol: 'AAPL', name: 'APPLE INC', percent: 0.5, country: 'United States', isin: 'US0378331005' },
    { symbol: '2330', name: 'TSMC', percent: 0.5, country: 'Taiwan', isin: 'TW0002330008' },
  ]);
  s.metas.set('BND', fund({
    quoteType: 'ETF', composition: { stock: 0, bond: 1, cash: 0, other: 0 },
    bonds: { ratings: { AAA: 0.1, AA: 0.7, A: 0.2 }, govShare: 0.5, duration: 6, maturity: 8 },
  }));
  s.metas.set('XYZ', { ...emptyMeta(), quoteType: 'EQUITY' });
  s.sec.set('XYZ', { cik: 1, name: 'Obscure', sic: 3711, sicDescription: 'Motor vehicles', sector: 'Consumer Cyclical', country: 'United States' });
  // The trust: VTI 75% + an N-PORT-only fund 25% whose filing names TSMC by name with its ISIN.
  s.profiles.set('BJC 401k Trust 2055', [{ ticker: 'VTI', weight: 0.75 }, { ticker: 'BNDX', weight: 0.25 }]);
  s.metas.set('BNDX', fund({ quoteType: 'ETF', bonds: { ratings: { AA: 1 }, govShare: 1, duration: 7, maturity: null } }));
  s.deep.set('BNDX', [
    { symbol: 'TAIWAN SEMICONDUCTOR', name: 'Taiwan Semiconductor', percent: 0.2, country: 'Taiwan', isin: 'TW0002330008', named: true },
    bondLump(0.8),
  ]);
  ({ getAllocation } = await import('./allocation.js'));
});

describe('getAllocation look-through', () => {
  it('scales a balanced fund’s sector weights by its stock share', async () => {
    const a = await getAllocation();
    const sector = (n: string) => a.bySector.find(x => x.name === n)?.contributors.find(c => c.label === 'AOR')?.value ?? 0;
    expect(sector('Technology')).toBeCloseTo(3000);
    expect(sector('Healthcare')).toBeCloseTo(3000);
    expect(sector('Bonds')).toBeCloseTo(4000);
  });

  it('splits a balanced fund across stock and bond asset classes', async () => {
    const a = await getAllocation();
    const cls = (n: string) => a.byAssetClass.find(x => x.name === n)?.contributors.find(c => c.label === 'AOR')?.value ?? 0;
    expect(cls('Domestic Stock')).toBeCloseTo(6000);
    expect(cls('Bonds')).toBeCloseTo(4000);
    expect(a.holdings.find(h => h.symbol === 'AOR')).toMatchObject({ assetClass: 'Domestic Stock', lookThrough: 'split' });
  });

  it('places a stock Yahoo can’t from its SEC company record', async () => {
    const a = await getAllocation();
    expect(a.bySector.find(x => x.name === 'Consumer Cyclical')?.value).toBeCloseTo(1000);
    expect(a.holdings.find(h => h.symbol === 'XYZ')?.lookThrough).toBe('full');
  });

  it('looks through a described mix and merges one stock across sources by ISIN', async () => {
    const a = await getAllocation();
    const trust = a.holdings.find(h => h.name === 'BJC 401k Trust 2055')!;
    expect(trust.profile).toEqual([{ ticker: 'VTI', weight: 0.75 }, { ticker: 'BNDX', weight: 0.25 }]);
    expect(trust.lookThrough).toBe('full');
    // TSMC: VTI 10000×0.5 + trust 4000×(0.75×0.5 + 0.25×0.2)
    const tsmc = a.byStock.find(x => x.symbol === '2330')!;
    expect(tsmc.value).toBeCloseTo(5000 + 4000 * (0.375 + 0.05));
    expect(a.byStock.some(x => x.symbol === 'TAIWAN SEMICONDUCTOR')).toBe(false);
    const trustBonds = a.byAssetClass.find(x => x.name === 'Bonds')?.contributors.find(c => c.label === 'BJC 401k Trust 2055')?.value;
    expect(trustBonds).toBeCloseTo(4000 * 0.25 * 0.8);
  });

  it('summarizes bond credit quality weighted by bond dollars', async () => {
    const a = await getAllocation();
    // BND 5000 bonds (rated) + AOR 4000 (unrated) + trust 800 (BNDX, rated AA)
    expect(a.bonds?.value).toBeCloseTo(9800);
    expect(a.bonds?.coverage).toBeCloseTo(5800 / 9800);
    const aa = a.bonds!.byRating.find(r => r.name === 'AA')!;
    expect(aa.pct).toBeCloseTo((5000 * 0.7 + 800) / 5800);
    expect(a.bonds!.byRating.map(r => r.name)).toEqual(['AAA', 'AA', 'A']);
    expect(a.bonds!.avgDuration).toBeCloseTo((5000 * 6 + 800 * 7) / 5800);
  });

  it('lets a description beat the name: a "bond"-named holding described as mostly stock', async () => {
    s.profiles.set('BND', [{ ticker: 'VTI', weight: 0.6 }, { ticker: 'BNDX', weight: 0.4 }]);
    const a = await getAllocation();
    const bnd = a.holdings.find(h => h.symbol === 'BND')!;
    // VTI half AAPL / half TSMC; BNDX 20% TSMC + 80% bonds → 30% US, 38% Taiwan, 32% bonds.
    expect(bnd.assetClass).toBe('Foreign Stock');
    const cls = (n: string) => a.byAssetClass.find(x => x.name === n)?.contributors.find(c => c.label === 'BND')?.value ?? 0;
    expect(cls('Domestic Stock')).toBeCloseTo(5000 * 0.3);
    expect(cls('Bonds')).toBeCloseTo(5000 * 0.4 * 0.8);
  });

  it('does not flag a bond fund with a known split as limited', async () => {
    const a = await getAllocation();
    expect(a.holdings.find(h => h.symbol === 'BND')?.lookThrough).toBe('full');
  });

  it('keeps every dollar: asset classes sum to the total', async () => {
    const a = await getAllocation();
    expect(a.byAssetClass.reduce((t, x) => t + x.value, 0)).toBeCloseTo(a.total);
    expect(a.byStock.reduce((t, x) => t + x.value, 0)).toBeCloseTo(30000);
  });
});
