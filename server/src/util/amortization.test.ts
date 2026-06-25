import { describe, it, expect } from 'vitest';
import { remainingMortgageBalance } from './amortization.js';

/**
 * Independent reference: iterate the amortization recurrence month by month
 *   B_{m+1} = B_m·(1+i) − payment
 * This is a different computation path from the closed-form geometric-sum
 * formula under test, so agreement between the two is a real cross-check.
 */
function simulateBalance(principal: number, annualRatePct: number, k: number, N: number): number {
  const i = annualRatePct / 100 / 12;
  if (i === 0) return principal * (1 - k / N);
  const g = Math.pow(1 + i, N);
  const payment = (principal * i * g) / (g - 1);
  let bal = principal;
  for (let m = 0; m < k; m++) bal = bal * (1 + i) - payment;
  return Math.max(0, Math.round(bal * 100) / 100);
}

describe('remainingMortgageBalance', () => {
  describe('guard clauses', () => {
    it('returns 0 for zero or negative principal', () => {
      expect(remainingMortgageBalance(0, 6, '2020-01-01')).toBe(0);
      expect(remainingMortgageBalance(-100, 6, '2020-01-01')).toBe(0);
    });
    it('returns 0 for a missing or invalid start date', () => {
      expect(remainingMortgageBalance(300000, 6, '')).toBe(0);
      expect(remainingMortgageBalance(300000, 6, 'not-a-date')).toBe(0);
    });
    it('returns 0 for a non-positive term', () => {
      expect(remainingMortgageBalance(300000, 6, '2020-01-01', 0)).toBe(0);
      expect(remainingMortgageBalance(300000, 6, '2020-01-01', -5)).toBe(0);
    });
  });

  it('equals the original principal at origination (k = 0)', () => {
    // asOf == start, same day-of-month → no payment elapsed yet.
    expect(remainingMortgageBalance(300000, 6, '2020-01-15', 30, new Date('2020-01-15T00:00:00')))
      .toBeCloseTo(300000, 2);
  });

  it('returns 0 once the loan is fully paid off (k >= N)', () => {
    expect(remainingMortgageBalance(300000, 6, '1990-01-01', 30, new Date('2030-01-01T00:00:00')))
      .toBe(0);
  });

  it('matches an independent month-by-month simulation at several points', () => {
    const principal = 300000, rate = 6, term = 30, N = term * 12;
    const cases: { asOf: string; k: number }[] = [
      { asOf: '2021-01-15', k: 12 },
      { asOf: '2025-01-15', k: 60 },
      { asOf: '2035-01-15', k: 180 },
    ];
    for (const { asOf, k } of cases) {
      const actual = remainingMortgageBalance(principal, rate, '2020-01-15', term, new Date(asOf + 'T00:00:00'));
      expect(actual).toBeCloseTo(simulateBalance(principal, rate, k, N), 1);
    }
  });

  it('reproduces the well-known $300k / 6% / 30yr payment via the first-month split', () => {
    // After 1 payment, principal paid = payment − first-month interest.
    // payment ≈ 1798.65, interest month 1 = 300000 * 0.005 = 1500.
    const afterOne = remainingMortgageBalance(300000, 6, '2020-01-15', 30, new Date('2020-02-15T00:00:00'));
    expect(300000 - afterOne).toBeCloseTo(1798.65 - 1500, 0); // ≈ 298.65 principal paid
  });

  it('pays down linearly when the loan is interest-free', () => {
    // 120k over 10yr (120 months), 60 months elapsed → exactly half remaining.
    expect(remainingMortgageBalance(120000, 0, '2020-01-01', 10, new Date('2025-01-01T00:00:00')))
      .toBeCloseTo(60000, 2);
  });

  it('does not count the current month before its payment date', () => {
    const onDue = remainingMortgageBalance(300000, 6, '2020-01-15', 30, new Date('2021-01-15T00:00:00'));
    const dayBefore = remainingMortgageBalance(300000, 6, '2020-01-15', 30, new Date('2021-01-14T00:00:00'));
    // The 14th is before the 15th → one fewer payment counted → higher balance.
    expect(dayBefore).toBeGreaterThan(onDue);
  });

  it('decreases monotonically over time and never exceeds principal', () => {
    const at = (asOf: string) =>
      remainingMortgageBalance(300000, 6, '2020-01-15', 30, new Date(asOf + 'T00:00:00'));
    const y1 = at('2021-01-15'), y5 = at('2025-01-15'), y10 = at('2030-01-15');
    expect(y1).toBeLessThanOrEqual(300000);
    expect(y5).toBeLessThan(y1);
    expect(y10).toBeLessThan(y5);
  });

  it('rounds the result to whole cents', () => {
    const bal = remainingMortgageBalance(287431.97, 5.375, '2019-07-15', 30, new Date('2024-03-15T00:00:00'));
    expect(bal).toBe(Math.round(bal * 100) / 100);
  });

  it('returns a finite, in-range number when asOf defaults to now', () => {
    const bal = remainingMortgageBalance(300000, 6, '2020-01-15');
    expect(Number.isFinite(bal)).toBe(true);
    expect(bal).toBeGreaterThanOrEqual(0);
    expect(bal).toBeLessThanOrEqual(300000);
  });
});
