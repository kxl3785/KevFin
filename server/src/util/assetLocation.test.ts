import { describe, it, expect } from 'vitest';
import { buildAssetLocation, locationObservations, classSplitFor, parseBucketOverrides, isTaxExemptBond } from './assetLocation.js';
import type { TaxBucket } from './taxBucket.js';

const buckets: Record<string, TaxBucket> = { 'Joint Brokerage': 'taxable', 'Rollover IRA': 'pretax', 'Roth IRA': 'roth', 'HSA': 'hsa' };
const bucketOf = (n: string) => buckets[n] ?? 'taxable';

describe('buildAssetLocation', () => {
  it('spreads each holding across its accounts and its asset classes', () => {
    const loc = buildAssetLocation([
      // A bond fund: $84k taxable, $16k pre-tax.
      { value: 100_000, accounts: [{ name: 'Joint Brokerage', value: 84_000 }, { name: 'Rollover IRA', value: 16_000 }], classSplit: { Bonds: 1 } },
      // A world fund 60/40 US/foreign, all in the Roth.
      { value: 50_000, accounts: [{ name: 'Roth IRA', value: 50_000 }], classSplit: { 'Domestic Stock': 0.6, 'Foreign Stock': 0.4 } },
    ], bucketOf);
    expect(loc.cells.Bonds).toEqual({ taxable: 84_000, pretax: 16_000 });
    expect(loc.cells['Domestic Stock']).toEqual({ roth: 30_000 });
    expect(loc.cells['Foreign Stock']).toEqual({ roth: 20_000 });
    expect(loc.bucketTotals).toEqual({ taxable: 84_000, pretax: 16_000, roth: 50_000, hsa: 0, college: 0 });
    expect(loc.total).toBe(150_000);
    expect(loc.classes).toEqual(['Bonds', 'Domestic Stock', 'Foreign Stock']);
    expect(loc.buckets).toEqual(['taxable', 'pretax', 'roth', 'hsa', 'college']);
  });

  it('normalises a split that does not sum to 1 and skips junk', () => {
    const loc = buildAssetLocation([
      { value: 1000, accounts: [{ name: 'Joint Brokerage', value: 1000 }], classSplit: { 'Domestic Stock': 0.3, 'Foreign Stock': 0.2 } },
      { value: 500, accounts: [{ name: 'Joint Brokerage', value: -500 }], classSplit: { Bonds: 1 } },
      { value: 500, accounts: [{ name: 'Joint Brokerage', value: 500 }], classSplit: {} },
    ], bucketOf);
    expect(loc.cells['Domestic Stock'].taxable).toBeCloseTo(600, 8);
    expect(loc.cells['Foreign Stock'].taxable).toBeCloseTo(400, 8);
    expect(loc.total).toBeCloseTo(1000, 8);
    expect(loc.cells.Bonds).toBeUndefined();
  });

  it('returns an empty table (no NaN) for no holdings', () => {
    const loc = buildAssetLocation([], bucketOf);
    expect(loc.total).toBe(0);
    expect(loc.classes).toEqual([]);
    expect(loc.observations).toEqual([]);
  });
});

describe('locationObservations', () => {
  it('notes bonds and REITs in taxable accounts and foreign stock in sheltered ones, largest first', () => {
    const obs = locationObservations({
      Bonds: { taxable: 84_000, pretax: 10_000 },
      'Real Estate': { taxable: 5_000 },
      'Foreign Stock': { pretax: 20_000, roth: 10_000, taxable: 99_000 },
    }, 400_000);
    expect(obs).toEqual([
      { kind: 'bonds-taxable', amount: 84_000 },
      { kind: 'foreign-sheltered', amount: 30_000 },
      { kind: 'reits-taxable', amount: 5_000 },
    ]);
  });

  it('needs both $1,000 and 1% of the total; exactly at the threshold counts', () => {
    // total 100k → 1% = 1,000 → threshold max(1000, 1000) = 1000.
    expect(locationObservations({ Bonds: { taxable: 1000 } }, 100_000)).toEqual([{ kind: 'bonds-taxable', amount: 1000 }]);
    expect(locationObservations({ Bonds: { taxable: 999.99 } }, 100_000)).toEqual([]);
    // total 1M → 1% = 10,000 → $9,000 of bonds is too small to mention.
    expect(locationObservations({ Bonds: { taxable: 9000 } }, 1_000_000)).toEqual([]);
    expect(locationObservations({ Bonds: { taxable: 5000 } }, 0)).toEqual([]);
  });

  it('says nothing about bonds sheltered in retirement accounts', () => {
    expect(locationObservations({ Bonds: { pretax: 50_000, roth: 50_000 } }, 100_000)).toEqual([]);
  });
});

describe('classSplitFor', () => {
  const slices = [
    { name: 'Domestic Stock', contributors: [{ label: 'VT', value: 600 }, { label: 'VTI', value: 1000 }] },
    { name: 'Foreign Stock', contributors: [{ label: 'VT', value: 400 }] },
  ];
  it('splits a fund by its look-through contributions', () => {
    expect(classSplitFor('VT', 1000, 'Domestic Stock', slices)).toEqual({ 'Domestic Stock': 0.6, 'Foreign Stock': 0.4 });
    expect(classSplitFor('VTI', 1000, 'Domestic Stock', slices)).toEqual({ 'Domestic Stock': 1 });
  });
  it('falls back to the primary class when the label is missing, shared or mismatched', () => {
    expect(classSplitFor('', 1000, 'Uncategorized', slices)).toEqual({ Uncategorized: 1 });
    expect(classSplitFor('NONE', 1000, 'Bonds', slices)).toEqual({ Bonds: 1 });
    expect(classSplitFor('VT', 5000, 'Domestic Stock', slices)).toEqual({ 'Domestic Stock': 1 });
    expect(classSplitFor('VT', 0, '', slices)).toEqual({ Uncategorized: 1 });
  });
});

describe('parseBucketOverrides', () => {
  it('keeps known buckets only', () => {
    expect(parseBucketOverrides('{"a1":"roth","a2":"bogus","a3":5}')).toEqual({ a1: 'roth' });
    expect(parseBucketOverrides('nope')).toEqual({});
    expect(parseBucketOverrides(null)).toEqual({});
  });
});

describe('tax-exempt (municipal) bond funds', () => {
  it('recognises muni / tax-exempt funds by name or symbol, and not ordinary bond funds', () => {
    expect(isTaxExemptBond('VTEB', 'Vanguard Tax-Exempt Bond Index Fund ETF')).toBe(true);
    expect(isTaxExemptBond('MUB', 'iShares National Muni Bond ETF')).toBe(true);
    expect(isTaxExemptBond('VWIUX', 'Vanguard Intermediate-Term Tax Exempt Fund Admiral')).toBe(true);
    expect(isTaxExemptBond('NVHAX', 'Nuveen High Yield Municipal Bond Fund')).toBe(true);
    expect(isTaxExemptBond('FTABX', 'Fidelity Tax-Free Bond Fund')).toBe(true);
    expect(isTaxExemptBond('BND', 'Vanguard Total Bond Market ETF')).toBe(false);
    expect(isTaxExemptBond('VGIT', 'Vanguard Intermediate-Term Treasury ETF')).toBe(false);
    expect(isTaxExemptBond('TMFC', 'Motley Fool 100 Index ETF')).toBe(false);
  });

  it('keeps a muni fund in the Bonds row but leaves it out of the bonds-taxable note', () => {
    // $80k VTEB in a taxable account, $120k of stock in an IRA.
    const loc = buildAssetLocation([
      { value: 80_000, accounts: [{ name: 'Joint Brokerage', value: 80_000 }], classSplit: { Bonds: 1 }, taxExempt: true },
      { value: 120_000, accounts: [{ name: 'Rollover IRA', value: 120_000 }], classSplit: { 'Domestic Stock': 1 } },
    ], bucketOf);
    expect(loc.cells.Bonds).toEqual({ taxable: 80_000 });
    expect(loc.observations).toEqual([]);
  });

  it('notes only the taxable-bond part when munis and taxable bonds sit together', () => {
    // Bonds in taxable accounts: $84k of a taxable bond fund + $50k of munis = $134k; only $84k is noted.
    const loc = buildAssetLocation([
      { value: 84_000, accounts: [{ name: 'Joint Brokerage', value: 84_000 }], classSplit: { Bonds: 1 } },
      { value: 50_000, accounts: [{ name: 'Joint Brokerage', value: 50_000 }], classSplit: { Bonds: 1 }, taxExempt: true },
      // A muni fund in an IRA changes nothing (the note is about taxable accounts).
      { value: 10_000, accounts: [{ name: 'Rollover IRA', value: 10_000 }], classSplit: { Bonds: 1 }, taxExempt: true },
    ], bucketOf);
    expect(loc.cells.Bonds).toEqual({ taxable: 134_000, pretax: 10_000 });
    expect(loc.observations).toEqual([{ kind: 'bonds-taxable', amount: 84_000 }]);
  });

  it('subtracts the exempt amount in locationObservations, never below zero', () => {
    const cells = { Bonds: { taxable: 50_000 } };
    expect(locationObservations(cells, 100_000)).toEqual([{ kind: 'bonds-taxable', amount: 50_000 }]);
    expect(locationObservations(cells, 100_000, 30_000)).toEqual([{ kind: 'bonds-taxable', amount: 20_000 }]);
    expect(locationObservations(cells, 100_000, 60_000)).toEqual([]);
    expect(locationObservations(cells, 100_000, Number.NaN)).toEqual([{ kind: 'bonds-taxable', amount: 50_000 }]);
  });
});
