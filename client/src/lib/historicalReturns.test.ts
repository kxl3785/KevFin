import { describe, it, expect } from 'vitest';
import { HISTORICAL_RETURNS, HISTORY_FIRST_YEAR, HISTORY_LAST_YEAR } from './historicalReturns.ts';

const row = (y: number) => {
  const r = HISTORICAL_RETURNS.find(h => h.year === y);
  if (!r) throw new Error(`no row for ${y}`);
  return r;
};

describe('historical returns series', () => {
  it('covers every year from 1928 through the latest complete year, with no gaps', () => {
    expect(HISTORY_FIRST_YEAR).toBe(1928);
    expect(HISTORY_LAST_YEAR).toBe(2025);
    HISTORICAL_RETURNS.forEach((h, i) => expect(h.year).toBe(1928 + i));
    expect(HISTORICAL_RETURNS.length).toBe(2025 - 1928 + 1);
  });

  it('holds only finite decimal fractions in sane ranges', () => {
    for (const h of HISTORICAL_RETURNS) {
      for (const v of [h.stocks, h.bonds, h.bills, h.inflation]) expect(Number.isFinite(v)).toBe(true);
      expect(h.stocks).toBeGreaterThan(-0.6); expect(h.stocks).toBeLessThan(0.6);
      expect(h.bonds).toBeGreaterThan(-0.25); expect(h.bonds).toBeLessThan(0.4);
      expect(h.bills).toBeGreaterThanOrEqual(0); expect(h.bills).toBeLessThan(0.16);
      expect(h.inflation).toBeGreaterThan(-0.15); expect(h.inflation).toBeLessThan(0.2);
    }
  });

  // Spot checks against a SECOND, independent source (looked up separately on
  // 24 Nov 2026). Methods differ slightly (index levels, dividend timing, how the
  // year average is rounded), so these allow a small tolerance.
  it('matches S&P 500 total returns from Wikipedia "S&P 500" (annual returns table) within 0.75 pts', () => {
    const wiki: [number, number][] = [[1974, -0.2647], [1995, 0.3758], [2008, -0.37], [2022, -0.1811], [2024, 0.2502], [2025, 0.1788]];
    for (const [y, v] of wiki) expect(Math.abs(row(y).stocks - v)).toBeLessThan(0.0075);
  });

  it('matches annual-average CPI inflation from usinflationcalculator.com (BLS data) within 0.5 pts', () => {
    const cpi: [number, number][] = [[1932, -0.099], [1946, 0.083], [1974, 0.11], [1980, 0.135], [2009, -0.004], [2022, 0.08], [2024, 0.029], [2025, 0.026]];
    for (const [y, v] of cpi) expect(Math.abs(row(y).inflation - v)).toBeLessThan(0.005);
  });

  it('keeps known years exactly as published in the primary tables', () => {
    expect(row(1931).stocks).toBe(-0.4384);
    expect(row(2008).bonds).toBe(0.201);
    expect(row(2022).bonds).toBe(-0.1783);
    expect(row(1981).bills).toBeGreaterThan(0.14); // the 1981 T-bill peak
  });

  it('has long-run averages in line with the published 1928–2025 figures', () => {
    const n = HISTORICAL_RETURNS.length;
    const arith = (k: 'stocks' | 'bonds' | 'bills' | 'inflation') => HISTORICAL_RETURNS.reduce((t, h) => t + h[k], 0) / n;
    const geo = (k: 'stocks' | 'bonds' | 'bills' | 'inflation') =>
      Math.exp(HISTORICAL_RETURNS.reduce((t, h) => t + Math.log(1 + h[k]), 0) / n) - 1;
    expect(arith('stocks')).toBeGreaterThan(0.115); expect(arith('stocks')).toBeLessThan(0.122);
    expect(geo('stocks')).toBeGreaterThan(0.096); expect(geo('stocks')).toBeLessThan(0.104);
    expect(arith('bonds')).toBeGreaterThan(0.044); expect(arith('bonds')).toBeLessThan(0.052);
    expect(arith('bills')).toBeGreaterThan(0.03); expect(arith('bills')).toBeLessThan(0.038);
    expect(geo('inflation')).toBeGreaterThan(0.027); expect(geo('inflation')).toBeLessThan(0.034);
    // Stocks beat bonds beat bills over the whole span.
    expect(geo('stocks')).toBeGreaterThan(geo('bonds'));
    expect(geo('bonds')).toBeGreaterThan(geo('bills'));
  });
});
