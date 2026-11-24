import { describe, it, expect } from 'vitest';
import { summarizeBacktest, summarizeCuts, medianOf, chunk, normalizeBacktestSettings, simExtrasFor, DEFAULT_BACKTEST_SETTINGS } from './backtest.ts';
import { DEFAULT_WITHDRAWAL_RULE } from './withdrawalRules.ts';
import type { SimHistoricalStart } from './forecastSim.ts';

const st = (startYear: number, over: Partial<SimHistoricalStart> = {}): SimHistoricalStart =>
  ({ startYear, ranOutAge: null, deepestCut: 0, lowestSpendReal: 40000, endInvReal: 100000, endNWReal: 100000, ...over });

describe('summarizeBacktest', () => {
  it('handles no starting years', () => {
    const s = summarizeBacktest([]);
    expect(s).toMatchObject({ total: 0, lasted: 0, worst: null, medianEndReal: 0, deepestCut: 0, deepestCutYear: null });
  });

  it('counts lasted, lists the years that ran out, and picks the earliest failure as worst', () => {
    const s = summarizeBacktest([
      st(1966, { ranOutAge: 85, endInvReal: 0 }), st(1929, { ranOutAge: 80, endInvReal: 0 }),
      st(1950, { endInvReal: 900000 }), st(1980, { endInvReal: 2_000_000 }),
    ]);
    expect(s.total).toBe(4);
    expect(s.lasted).toBe(2);
    expect(s.ranOut.map(r => r.startYear)).toEqual([1929, 1966]);
    expect(s.worst?.startYear).toBe(1929);
    expect(s.medianEndReal).toBe(0); // [0, 0, 900k, 2M] → lower middle
  });

  it('when everything lasted, the worst is the deepest cut, then the smallest balance', () => {
    const s = summarizeBacktest([st(1960, { deepestCut: 0.1, endInvReal: 500 }), st(1970, { deepestCut: 0.27, endInvReal: 9000 }), st(1990, { endInvReal: 1 })]);
    expect(s.worst?.startYear).toBe(1970);
    expect(s.deepestCut).toBeCloseTo(0.27, 12);
    expect(s.deepestCutYear).toBe(1970);
    const t = summarizeBacktest([st(1960, { endInvReal: 500 }), st(1970, { endInvReal: 200 })]);
    expect(t.worst?.startYear).toBe(1970);
    expect(t.deepestCutYear).toBeNull();
  });
});

describe('helpers', () => {
  it('medianOf ignores non-finite values and returns 0 when empty', () => {
    expect(medianOf([])).toBe(0);
    expect(medianOf([NaN, Infinity])).toBe(0);
    expect(medianOf([3, 1, 2])).toBe(2);
    expect(medianOf([4, 1, 3, 2])).toBe(2);
  });
  it('summarizeCuts reports the median and hardest-tenth cut', () => {
    expect(summarizeCuts([])).toEqual({ median: 0, worstTenth: 0, anyCut: 0 });
    const paths = Array.from({ length: 11 }, (_, i) => ({ ranOutAge: null, deepestCut: i / 100, lowestSpendReal: 1, endInvReal: 1, endNWReal: 1 }));
    const c = summarizeCuts(paths);
    expect(c.median).toBeCloseTo(0.05, 12);
    expect(c.worstTenth).toBeCloseTo(0.09, 12);
    expect(c.anyCut).toBeCloseTo(10 / 11, 12);
  });
  it('chunk splits evenly and tolerates bad sizes', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([1, 2], 0)).toEqual([[1], [2]]);
    expect(chunk([], 3)).toEqual([]);
  });
});

describe('saved settings', () => {
  it('normalizes junk to the defaults', () => {
    expect(normalizeBacktestSettings(undefined)).toEqual(DEFAULT_BACKTEST_SETTINGS);
    expect(normalizeBacktestSettings({ returnModel: 'x', stockShare: 0.55 })).toEqual(DEFAULT_BACKTEST_SETTINGS);
    expect(normalizeBacktestSettings({ returnModel: 'historical', stockShare: 0.6 })).toEqual({ returnModel: 'historical', stockShare: 0.6 });
  });
  it('adds nothing to the sim input with the defaults', () => {
    expect(simExtrasFor(DEFAULT_BACKTEST_SETTINGS, DEFAULT_WITHDRAWAL_RULE)).toEqual({});
  });
  it('adds the return model and rule when switched on', () => {
    const rule = { ...DEFAULT_WITHDRAWAL_RULE, kind: 'guardrails' as const };
    expect(simExtrasFor({ returnModel: 'historical', stockShare: 0.8 }, rule)).toEqual({ returnModel: 'historical', historicalStockShare: 0.8, withdrawal: rule });
  });
});
