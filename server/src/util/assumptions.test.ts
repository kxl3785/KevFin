import { describe, it, expect } from 'vitest';
import { buildAssumptionsMeta, PROXY_FUND, FUND_OF_FUNDS } from './assumptions.js';
import { TAX_BUCKETS } from './taxBucket.js';

describe('buildAssumptionsMeta', () => {
  const meta = buildAssumptionsMeta();

  it('exposes every proxy-fund substitution with from/to/label', () => {
    expect(meta.proxyFunds.length).toBe(Object.keys(PROXY_FUND).length);
    for (const p of meta.proxyFunds) {
      expect(p.from).toBeTruthy();
      expect(p.to).toBeTruthy();
      expect(p.label).toBeTruthy();
    }
    // a representative mapping the look-through relies on
    expect(meta.proxyFunds.find(p => p.from === 'IVV')?.to).toBe('VOO');
  });

  it('exposes every fund-of-funds entry', () => {
    expect(meta.fundOfFunds.length).toBe(Object.keys(FUND_OF_FUNDS).length);
    expect(meta.fundOfFunds.map(f => f.ticker)).toContain('VFFVX');
  });

  it('reports the canonical tax buckets (kept in sync with taxBucket.ts)', () => {
    expect(meta.taxBuckets).toEqual(TAX_BUCKETS);
  });
});

describe('FUND_OF_FUNDS invariants', () => {
  it('every fund-of-funds glide path sums to 100%', () => {
    for (const [ticker, fof] of Object.entries(FUND_OF_FUNDS)) {
      const total = fof.constituents.reduce((s, c) => s + c.weight, 0);
      expect(total, `${ticker} weights should sum to 1`).toBeCloseTo(1, 5);
    }
  });

  it('every constituent is tagged equity or bond', () => {
    for (const fof of Object.values(FUND_OF_FUNDS)) {
      for (const c of fof.constituents) {
        expect(['equity', 'bond']).toContain(c.kind);
      }
    }
  });
});
