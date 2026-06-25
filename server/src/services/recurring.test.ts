import { describe, it, expect } from 'vitest';
import { monthsBetween, coefficientOfVariation, qualifiesAsFlexible } from './recurring.js';

describe('monthsBetween', () => {
  it('counts whole months between two YYYY-MM keys', () => {
    expect(monthsBetween('2024-01', '2024-01')).toBe(0);
    expect(monthsBetween('2024-01', '2024-12')).toBe(11);
    expect(monthsBetween('2023-06', '2024-06')).toBe(12);
  });
  it('is signed (negative when the second month is earlier)', () => {
    expect(monthsBetween('2024-06', '2023-06')).toBe(-12);
  });
});

describe('coefficientOfVariation', () => {
  it('treats fewer than two points as perfectly consistent', () => {
    expect(coefficientOfVariation([])).toBe(0);
    expect(coefficientOfVariation([42])).toBe(0);
  });
  it('is 0 for identical values', () => {
    expect(coefficientOfVariation([10, 10, 10])).toBe(0);
  });
  it('returns std-dev divided by mean for varying values', () => {
    // mean 15, population std-dev 5 → CV ≈ 0.333
    expect(coefficientOfVariation([10, 20])).toBeCloseTo(1 / 3, 5);
  });
  it('returns 1 when the mean is zero', () => {
    expect(coefficientOfVariation([-5, 5])).toBe(1);
  });
});

describe('qualifiesAsFlexible', () => {
  const m = (entries: Record<string, number[]>) => new Map(Object.entries(entries));

  describe('known subscriptions (loosest bar: 2+ months, CV < 0.40)', () => {
    it('accepts a consistent 2-month subscription', () => {
      expect(qualifiesAsFlexible('Netflix', m({ '2024-01': [15.99], '2024-02': [15.99] }))).toBe(true);
    });
    it('rejects a single month', () => {
      expect(qualifiesAsFlexible('Netflix', m({ '2024-01': [15.99] }))).toBe(false);
    });
    it('rejects wildly varying amounts', () => {
      expect(qualifiesAsFlexible('Netflix', m({ '2024-01': [15], '2024-02': [100] }))).toBe(false);
    });
  });

  describe('general services (3+ months, CV < 0.25, fill ≥ 0.35)', () => {
    it('accepts a steady monthly service', () => {
      expect(qualifiesAsFlexible('Acme Services Co', m({ '2024-01': [30], '2024-02': [30], '2024-03': [30] }))).toBe(true);
    });
    it('accepts quarterly billing (fill ≈ 0.43)', () => {
      expect(qualifiesAsFlexible('Acme Services Co', m({ '2024-01': [30], '2024-04': [30], '2024-07': [30] }))).toBe(true);
    });
    it('rejects scattered one-offs spread thinly over a long span', () => {
      expect(qualifiesAsFlexible('Acme Services Co', m({ '2024-01': [30], '2024-07': [30], '2025-01': [30] }))).toBe(false);
    });
    it('rejects fewer than three months', () => {
      expect(qualifiesAsFlexible('Acme Services Co', m({ '2024-01': [30], '2024-02': [30] }))).toBe(false);
    });
  });

  describe('retail merchants (strictest bar: 4+ months, CV < 0.08, fill ≥ 0.80)', () => {
    it('accepts an identically-billed monthly fee', () => {
      expect(qualifiesAsFlexible('Amazon', m({
        '2024-01': [14.99], '2024-02': [14.99], '2024-03': [14.99], '2024-04': [14.99],
      }))).toBe(true);
    });
    it('rejects irregular shopping', () => {
      expect(qualifiesAsFlexible('Amazon', m({ '2024-01': [50], '2024-04': [120], '2024-09': [30] }))).toBe(false);
    });
  });
});
