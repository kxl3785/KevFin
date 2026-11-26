import { describe, it, expect } from 'vitest';
import { trailingGrowth } from './homeGrowth.js';

describe('trailingGrowth', () => {
  it('gives the compound annual rate over a full five years', () => {
    // 500k → 638,140.78 is exactly 5% a year compounded over 5 years.
    const g = trailingGrowth([
      { date: '2021-06-01', value: 500_000 },
      { date: '2026-06-01', value: 500_000 * 1.05 ** 5 },
    ])!;
    expect(g.rate).toBeCloseTo(0.05, 3);
    expect(g.years).toBeCloseTo(5, 2);
    expect(g.from).toBe('2021-06-01');
    expect(g.to).toBe('2026-06-01');
  });

  it('measures only the last five years of a longer series', () => {
    // Flat for a decade, then doubles: the early years must not dilute the rate.
    const g = trailingGrowth([
      { date: '2011-01-01', value: 100_000 },
      { date: '2021-01-01', value: 100_000 },
      { date: '2026-01-01', value: 200_000 },
    ])!;
    expect(g.from).toBe('2021-01-01');
    expect(g.rate).toBeCloseTo(2 ** (1 / 5) - 1, 3);
  });

  it('interpolates the starting value between the points around the start date', () => {
    // Start date 2021-07-01 sits halfway (by days) between the first two points.
    const g = trailingGrowth([
      { date: '2021-01-01', value: 400_000 },
      { date: '2021-12-30', value: 500_000 },
      { date: '2026-07-01', value: 600_000 },
    ])!;
    expect(g.from).toBe('2021-07-01');
    const start = 400_000 + 100_000 * (181 / 363);
    expect(g.rate).toBeCloseTo((600_000 / start) ** (1 / g.years) - 1, 6);
  });

  it('uses the whole history when it is shorter than five years, and says how long', () => {
    const g = trailingGrowth([
      { date: '2024-06-01', value: 300_000 },
      { date: '2026-06-01', value: 330_750 }, // 5% a year for 2 years
    ])!;
    expect(g.years).toBeCloseTo(2, 2);
    expect(g.from).toBe('2024-06-01');
    expect(g.rate).toBeCloseTo(0.05, 3);
  });

  it('reports a falling value as a negative rate', () => {
    const g = trailingGrowth([
      { date: '2021-06-01', value: 500_000 },
      { date: '2026-06-01', value: 450_000 },
    ])!;
    expect(g.rate).toBeLessThan(0);
    expect(g.rate).toBeCloseTo(0.9 ** (1 / 5) - 1, 3);
  });

  it('has no answer for under a year of history', () => {
    expect(trailingGrowth([
      { date: '2026-01-01', value: 500_000 },
      { date: '2026-06-01', value: 560_000 },
    ])).toBeNull();
  });

  it('has no answer without two usable points', () => {
    expect(trailingGrowth([])).toBeNull();
    expect(trailingGrowth([{ date: '2026-06-01', value: 500_000 }])).toBeNull();
    expect(trailingGrowth([
      { date: '2020-06-01', value: 0 },
      { date: 'not-a-date', value: 400_000 },
      { date: '2026-06-01', value: 500_000 },
    ])).toBeNull();
  });

  it('sorts points itself and ignores unusable ones', () => {
    const g = trailingGrowth([
      { date: '2026-06-01', value: 500_000 * 1.05 ** 5 },
      { date: '2023-01-01', value: NaN },
      { date: '2021-06-01', value: 500_000 },
    ])!;
    expect(g.rate).toBeCloseTo(0.05, 3);
  });

  it('starts on Feb 28 when the window ends on a leap day', () => {
    const g = trailingGrowth([
      { date: '2018-01-01', value: 100_000 },
      { date: '2024-02-29', value: 150_000 },
    ], 5)!;
    expect(g.from).toBe('2019-02-28');
  });
});
