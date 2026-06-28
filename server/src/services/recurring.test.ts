import { describe, it, expect } from 'vitest';
import { monthsBetween, coefficientOfVariation, qualifiesAsFlexible, inFlexibleRecurringScope, fuzzyNameKey, classifySuggestion, monthlyCost } from './recurring.js';

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

describe('inFlexibleRecurringScope', () => {
  it('includes optimizable-fee categories', () => {
    expect(inFlexibleRecurringScope('Equinox', 'Fitness')).toBe(true);
    expect(inFlexibleRecurringScope('Some App', 'Subscriptions')).toBe(true);
    expect(inFlexibleRecurringScope('Red Cross', 'Charity')).toBe(true);
    // Recurring household services (maid, landscaping, pool, pest, …).
    expect(inFlexibleRecurringScope('Blue Wave Pool Service', 'Home Services')).toBe(true);
    expect(inFlexibleRecurringScope('Merry Maids', 'Home Services')).toBe(true);
  });
  it('excludes habitual day-to-day spending categories', () => {
    expect(inFlexibleRecurringScope('Whole Foods Market', 'Groceries')).toBe(false);
    expect(inFlexibleRecurringScope('Pizza Hut', 'Restaurants & Bars')).toBe(false);
    expect(inFlexibleRecurringScope('Starbucks', 'Coffee Shops')).toBe(false);
    expect(inFlexibleRecurringScope('Uber Trip', 'Taxi & Ride Shares')).toBe(false);
  });
  it('still includes a named subscription mis-filed under an out-of-scope category', () => {
    expect(inFlexibleRecurringScope('Netflix', 'Entertainment & Recreation')).toBe(true);
    expect(inFlexibleRecurringScope('Spotify', 'Personal')).toBe(true);
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

  describe('home services tier (3+ months, CV < 0.55, fill ≥ 0.50)', () => {
    it('accepts a variable-amount recurring service (seasonal landscaping)', () => {
      // CV ≈ 0.33 — would fail the general 0.25 bar, passes as Home Services.
      expect(qualifiesAsFlexible('Donaldson Landscaping',
        m({ '2024-04': [76], '2024-05': [76], '2024-06': [38], '2024-07': [38] }), 'Home Services')).toBe(true);
    });
    it('accepts a monthly pool service with occasional repair spikes', () => {
      // CV ≈ 0.46 — passes only under the relaxed Home Services tier.
      expect(qualifiesAsFlexible('Pool Pros',
        m({ '2024-01': [149], '2024-02': [407], '2024-03': [149], '2024-04': [278], '2024-05': [155], '2024-06': [149] }), 'Home Services')).toBe(true);
    });
    it('still rejects a one-off job (single month)', () => {
      expect(qualifiesAsFlexible('A1 Plumbing', m({ '2024-03': [850] }), 'Home Services')).toBe(false);
    });
    it('the same variable pattern fails without the Home Services category', () => {
      expect(qualifiesAsFlexible('Donaldson Landscaping',
        m({ '2024-04': [76], '2024-05': [76], '2024-06': [38], '2024-07': [38] }))).toBe(false);
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

describe('monthlyCost (amortize annual fees)', () => {
  const m = (obj: Record<string, number[]>) => new Map(Object.entries(obj));
  it('keeps a steady monthly bill as its per-month amount', () => {
    const r = monthlyCost(m({ '2024-01': [50], '2024-02': [50], '2024-03': [50] }), 'Some Sub');
    expect(r.annual).toBe(false);
    expect(r.monthlyAvg).toBe(50);
  });
  it('amortizes a yearly-cadence charge across 12 months', () => {
    // Two $480 charges ~12 months apart ⇒ $40/mo, flagged annual.
    const r = monthlyCost(m({ '2024-02': [480], '2025-02': [480] }), 'Membership');
    expect(r.annual).toBe(true);
    expect(r.monthlyAvg).toBeCloseTo(40, 5);
  });
  it('amortizes a single annual-named charge via its name', () => {
    const r = monthlyCost(m({ '2026-01': [600] }), 'Annual Fee');
    expect(r.annual).toBe(true);
    expect(r.monthlyAvg).toBeCloseTo(50, 5);
  });
  it('does not treat a single un-named charge as annual', () => {
    const r = monthlyCost(m({ '2026-01': [600] }), 'Random Vendor');
    expect(r.annual).toBe(false);
    expect(r.monthlyAvg).toBe(600);
  });
  it('sums several annual fees within one year, then divides by 12', () => {
    // e.g. multiple card annual fees billed close together: $495+$95+$89=$679/yr.
    const r = monthlyCost(m({ '2026-03': [495, 95], '2026-04': [89] }), 'Annual Fee');
    expect(r.annual).toBe(true);
    expect(r.monthlyAvg).toBeCloseTo(679 / 12, 5);
  });
});

describe('fuzzyNameKey (same-merchant-different-spelling)', () => {
  it('collapses digits, punctuation and noise tokens', () => {
    // The motivating case: a service split across two spellings.
    expect(fuzzyNameKey('Maid Dallas')).toBe(fuzzyNameKey('Maid 4 Dallas'));
    expect(fuzzyNameKey('Maid Dallas')).toBe('dallas maid');
  });
  it('is order-independent and drops generic suffixes', () => {
    expect(fuzzyNameKey('Dallas Maid Services LLC')).toBe(fuzzyNameKey('maid dallas'));
  });
  it('keeps genuinely different merchants apart', () => {
    expect(fuzzyNameKey('Blue Oasis Pools')).not.toBe(fuzzyNameKey('Pool Pros'));
  });
  it('returns empty when nothing distinctive remains (never merged)', () => {
    expect(fuzzyNameKey('LLC')).toBe('');
    expect(fuzzyNameKey('Payment 12345')).toBe('');
  });
});

describe('classifySuggestion (locale-agnostic edge-case triage)', () => {
  const base = { canonicalCategory: 'Home Services', categoryLabel: 'Home Services', payee: 'Acme', mergedNames: 1 };
  it('flags a repeated-but-irregular merchant as a medium-confidence suggestion', () => {
    const v = classifySuggestion({ ...base, distinctMonths: 2 });
    expect(v?.confidence).toBe('medium');
  });
  it('explains a merged split-name suggestion', () => {
    const v = classifySuggestion({ ...base, distinctMonths: 2, mergedNames: 2 });
    expect(v?.confidence).toBe('medium');
    expect(v?.reason).toMatch(/different names/i);
  });
  it('suggests a single charge in a bill-like category (the Maid Dallas case)', () => {
    const v = classifySuggestion({ ...base, distinctMonths: 1 });
    expect(v?.confidence).toBe('low');
  });
  it('does NOT suggest a one-off in a category that is commonly a one-off', () => {
    expect(classifySuggestion({
      distinctMonths: 1, canonicalCategory: 'Entertainment & Recreation',
      categoryLabel: 'Entertainment & Recreation', payee: 'Some Concert', mergedNames: 1,
    })).toBeNull();
  });
  it('still suggests a single charge from a named subscription out of a bill category', () => {
    const v = classifySuggestion({
      distinctMonths: 1, canonicalCategory: 'Entertainment & Recreation',
      categoryLabel: 'Entertainment & Recreation', payee: 'Netflix', mergedNames: 1,
    });
    expect(v?.confidence).toBe('low');
  });
});
