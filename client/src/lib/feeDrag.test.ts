import { describe, it, expect } from 'vitest';
import { annualFeeCost, feeDrag, forecastRates, fmtRatio, parseRatioInput, portfolioFeeDrag, collapsedFeeRows } from './feeDrag.ts';
import { DEFAULT_ASSUMPTIONS, DEFAULT_EARNERS } from './forecastConfig.ts';

describe('annualFeeCost', () => {
  it('is balance × ratio', () => {
    expect(annualFeeCost(100_000, 0.005)).toBeCloseTo(500, 10);
    expect(annualFeeCost(250_000, 0.0003)).toBeCloseTo(75, 10);
  });
  it('is 0 for zero, negative or non-finite input', () => {
    expect(annualFeeCost(0, 0.01)).toBe(0);
    expect(annualFeeCost(-1000, 0.01)).toBe(0);
    expect(annualFeeCost(1000, 0)).toBe(0);
    expect(annualFeeCost(1000, -0.01)).toBe(0);
    expect(annualFeeCost(Number.NaN, 0.01)).toBe(0);
    expect(annualFeeCost(1000, Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('feeDrag', () => {
  it('matches the hand-computed example: $100k, 7%, 0.5%, 3% inflation, 10 years', () => {
    // 1.07^10 = 1.9671514 ; 1.065^10 = 1.8771366 ; 1.03^10 = 1.3439164
    const d = feeDrag({ balance: 100_000, ratio: 0.005, expectedReturn: 0.07, inflation: 0.03, years: 10 });
    expect(d.withoutFees).toBeCloseTo(100_000 * 1.9671514 / 1.3439164, 0);
    expect(d.withFees).toBeCloseTo(100_000 * 1.8771366 / 1.3439164, 0);
    expect(d.cost).toBeCloseTo(6698, 0);
    // More than the simple 10 × $500, because each fee also loses its growth.
    expect(d.cost).toBeGreaterThan(5000);
  });

  it('with no return and no inflation, the gap is the compounding of the fee alone', () => {
    // 10,000 × (1 − 0.99^2) = 10,000 × 0.0199 = 199.
    expect(feeDrag({ balance: 10_000, ratio: 0.01, expectedReturn: 0, inflation: 0, years: 2 }).cost).toBeCloseTo(199, 8);
  });

  it('one year with no inflation equals the simple yearly cost', () => {
    expect(feeDrag({ balance: 50_000, ratio: 0.002, expectedReturn: 0.06, inflation: 0, years: 1 }).cost).toBeCloseTo(100, 8);
  });

  it('is zero for zero balance, zero ratio, zero years', () => {
    expect(feeDrag({ balance: 0, ratio: 0.01, expectedReturn: 0.07, inflation: 0.03, years: 30 }).cost).toBe(0);
    expect(feeDrag({ balance: 1000, ratio: 0, expectedReturn: 0.07, inflation: 0.03, years: 30 }).cost).toBe(0);
    expect(feeDrag({ balance: 1000, ratio: 0.01, expectedReturn: 0.07, inflation: 0.03, years: 0 }).cost).toBe(0);
  });

  it('never returns NaN, Infinity or a negative cost', () => {
    const cases = [
      { balance: -5000, ratio: 0.01, expectedReturn: 0.07, inflation: 0.03, years: 10 },
      { balance: 1000, ratio: -0.01, expectedReturn: 0.07, inflation: 0.03, years: 10 },
      { balance: 1000, ratio: 0.01, expectedReturn: -2, inflation: 0.03, years: 10 },
      { balance: 1000, ratio: 0.01, expectedReturn: 0.07, inflation: -1, years: 10 },
      { balance: Number.NaN, ratio: 0.01, expectedReturn: 0.07, inflation: 0.03, years: 10 },
      { balance: 1e300, ratio: 0.01, expectedReturn: 0.9, inflation: 0, years: 100 },
    ];
    for (const c of cases) {
      const d = feeDrag(c);
      for (const v of [d.withoutFees, d.withFees, d.cost]) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('uses whole years only', () => {
    const a = feeDrag({ balance: 1000, ratio: 0.01, expectedReturn: 0.05, inflation: 0.02, years: 10.9 });
    const b = feeDrag({ balance: 1000, ratio: 0.01, expectedReturn: 0.05, inflation: 0.02, years: 10 });
    expect(a.cost).toBe(b.cost);
  });
});

describe('forecastRates', () => {
  it('falls back to the Forecast defaults when nothing is saved', () => {
    expect(forecastRates(null)).toEqual({
      expectedReturn: DEFAULT_ASSUMPTIONS.investReturn,
      inflation: DEFAULT_ASSUMPTIONS.inflation,
      years: DEFAULT_ASSUMPTIONS.endAge - DEFAULT_ASSUMPTIONS.currentAge,
      fromSavedPlan: false,
    });
  });

  it('reads the saved plan, field by field', () => {
    expect(forecastRates({ ...DEFAULT_ASSUMPTIONS, investReturn: 0.06, inflation: 0.025, currentAge: 52, endAge: 95 }))
      .toEqual({ expectedReturn: 0.06, inflation: 0.025, years: 43, fromSavedPlan: true });
    // A partial or junk-valued save keeps the defaults for the bad fields.
    expect(forecastRates({ investReturn: 'high', inflation: 0.02, currentAge: 30 }))
      .toEqual({ expectedReturn: 0.07, inflation: 0.02, years: 60, fromSavedPlan: true });
  });

  it('takes the current age from earner 0, the age the Forecast edits and uses', () => {
    // The Forecast's "Current age" writes mon.fcEarners[0]; Assumptions.currentAge
    // is a frozen legacy field that stays at 40. A 62-year-old planning to 90 has
    // 90 − 62 = 28 years, not 90 − 40 = 50.
    const plan = { ...DEFAULT_ASSUMPTIONS, endAge: 90, annualSpending: 80_000 };
    const earners = [{ ...DEFAULT_EARNERS[0], currentAge: 62 }, DEFAULT_EARNERS[1]];
    expect(forecastRates(plan, earners)).toEqual({ expectedReturn: 0.07, inflation: 0.03, years: 28, fromSavedPlan: true });
    expect(forecastRates(plan, [{ ...DEFAULT_EARNERS[0], currentAge: 30 }]).years).toBe(60);
  });

  it('turns the right horizon into the right dollar figure', () => {
    // $1M at a 0.5% fee, 7% return, 3% inflation, worked out by hand:
    //   28 years: (1.07/1.03)^28 = 2.9061, (1.065/1.03)^28 = 2.5489 → gap ≈ $357,188
    //   50 years: (1.07/1.03)^50 = 6.7194, (1.065/1.03)^50 = 5.3164 → gap ≈ $1,402,938 (the old, wrong figure)
    const r = forecastRates({ ...DEFAULT_ASSUMPTIONS, endAge: 90 }, [{ ...DEFAULT_EARNERS[0], currentAge: 62 }]);
    const cost = portfolioFeeDrag([{ value: 1_000_000, expenseRatio: 0.005 }], r);
    expect(cost).toBeCloseTo(357_188.3, 0);
    // A 30-year-old to 90 with $500k: 60 years → ≈ $1,204,815.
    const r30 = forecastRates({ ...DEFAULT_ASSUMPTIONS, endAge: 90 }, [{ ...DEFAULT_EARNERS[0], currentAge: 30 }]);
    expect(portfolioFeeDrag([{ value: 500_000, expenseRatio: 0.005 }], r30)).toBeCloseTo(1_204_815.3, 0);
  });

  it('falls back to the legacy age while earner 0 is unset or still the default, as the Forecast migration does', () => {
    // Never opened the Forecast since the earners schema: no earners saved.
    expect(forecastRates({ ...DEFAULT_ASSUMPTIONS, currentAge: 55 }).years).toBe(35);
    expect(forecastRates({ ...DEFAULT_ASSUMPTIONS, currentAge: 55 }, DEFAULT_EARNERS).years).toBe(35);
    // Junk earner data never breaks it.
    expect(forecastRates(DEFAULT_ASSUMPTIONS, [null]).years).toBe(50);
    expect(forecastRates(DEFAULT_ASSUMPTIONS, [{ currentAge: 'sixty' }]).years).toBe(50);
    expect(forecastRates(DEFAULT_ASSUMPTIONS, [{ currentAge: 400 }]).years).toBe(50);
    expect(forecastRates(DEFAULT_ASSUMPTIONS, { 0: { currentAge: 60 } }).years).toBe(50);
  });

  it('says "from your Forecast" only when a figure differs from the Forecast defaults', () => {
    // usePersistentState hands back the defaults object when nothing is saved.
    expect(forecastRates(DEFAULT_ASSUMPTIONS).fromSavedPlan).toBe(false);
    expect(forecastRates(DEFAULT_ASSUMPTIONS, DEFAULT_EARNERS).fromSavedPlan).toBe(false);
    expect(forecastRates({ ...DEFAULT_ASSUMPTIONS, endAge: 95 }).fromSavedPlan).toBe(true);
    expect(forecastRates(DEFAULT_ASSUMPTIONS, [{ ...DEFAULT_EARNERS[0], currentAge: 45 }]).fromSavedPlan).toBe(true);
  });

  it('never yields a negative horizon', () => {
    expect(forecastRates({ currentAge: 95, endAge: 90 }).years).toBe(0);
    expect(forecastRates([1, 2]).years).toBe(DEFAULT_ASSUMPTIONS.endAge - DEFAULT_ASSUMPTIONS.currentAge);
  });
});

describe('fmtRatio', () => {
  it('formats fractions as short percents', () => {
    expect(fmtRatio(0.0003)).toBe('0.03%');
    expect(fmtRatio(0.00015)).toBe('0.015%');
    expect(fmtRatio(0.0125)).toBe('1.25%');
    expect(fmtRatio(0.001)).toBe('0.10%');
    expect(fmtRatio(0)).toBe('0%');
    expect(fmtRatio(null)).toBe('—');
    expect(fmtRatio(Number.NaN)).toBe('—');
  });
});

describe('parseRatioInput', () => {
  it('reads a typed percent as a fraction', () => {
    expect(parseRatioInput('0.03')).toEqual({ ratio: 0.0003 });
    expect(parseRatioInput(' 1.5% ')).toEqual({ ratio: 0.015 });
    expect(parseRatioInput('.5')).toEqual({ ratio: 0.005 });
    expect(parseRatioInput('0')).toEqual({ ratio: 0 });
    expect(parseRatioInput('5')).toEqual({ ratio: 0.05 });
  });
  it('treats blank as "clear" and refuses junk or out-of-range input', () => {
    expect(parseRatioInput('  ')).toEqual({ ratio: null });
    for (const bad of ['abc', '-1', '5.01', '1,5', '1e2', '0.0.1']) expect(parseRatioInput(bad)).toHaveProperty('error');
  });
});

describe('portfolioFeeDrag', () => {
  const rates = (expectedReturn: number, inflation: number, years: number) => ({ expectedReturn, inflation, years });

  it('grows each holding at its own fee: $90k of stocks + $10k of a 1% fund, 7%, no inflation, 50 years', () => {
    // Stocks add nothing; the fund: 10,000 × (1.07^50 − 1.06^50) = 10,000 × (29.457025 − 18.420154) ≈ $110,369.
    // (Growing the whole $100k at the 0.1% average fee would show ≈ $134,544.)
    const cost = portfolioFeeDrag([{ value: 90_000, expenseRatio: 0 }, { value: 10_000, expenseRatio: 0.01 }], rates(0.07, 0, 50));
    expect(cost).toBeCloseTo(110_368.71, 1);
  });

  it('matches the hand-worked figure at the Forecast defaults: $400k at 0% + $100k at 0.75%', () => {
    // 100,000 × (1.07^50 − 1.0625^50) / 1.03^50 = 100,000 × (29.457025 − 20.722728) / 4.383906 ≈ $199,235
    const cost = portfolioFeeDrag([{ value: 400_000, expenseRatio: 0 }, { value: 100_000, expenseRatio: 0.0075 }], rates(0.07, 0.03, 50));
    expect(cost).toBeCloseTo(199_235.49, 1);
  });

  it('over one year with no inflation equals the simple yearly cost', () => {
    // 90,000 × 0.03% + 10,000 × 1% = 27 + 100 = $127.
    const cost = portfolioFeeDrag([{ value: 90_000, expenseRatio: 0.0003 }, { value: 10_000, expenseRatio: 0.01 }], rates(0.07, 0, 1));
    expect(cost).toBeCloseTo(127, 8);
  });

  it('leaves out unknown and zero fees and stays finite', () => {
    expect(portfolioFeeDrag([{ value: 50_000, expenseRatio: null }, { value: 20_000, expenseRatio: 0 }], rates(0.07, 0.03, 30))).toBe(0);
    expect(portfolioFeeDrag([], rates(0.07, 0.03, 30))).toBe(0);
    // One holding equals feeDrag on its own.
    const one = feeDrag({ balance: 100_000, ratio: 0.005, expectedReturn: 0.07, inflation: 0.03, years: 10 }).cost;
    expect(portfolioFeeDrag([{ value: 100_000, expenseRatio: 0.005 }], rates(0.07, 0.03, 10))).toBe(one);
  });
});

describe('collapsedFeeRows', () => {
  it('shows the first rows plus every unknown fund after them, in order', () => {
    // Ten $1k stocks at 0%, then a $500k fund with no published fee (sorted last).
    const rows = [...Array.from({ length: 10 }, (_, i) => ({ id: `S${i}`, expenseRatio: 0 as number | null })),
      { id: 'X1', expenseRatio: 0.001 }, { id: 'BIGFUND', expenseRatio: null }];
    const shown = collapsedFeeRows(rows, 10);
    expect(shown.map(r => r.id)).toEqual([...Array.from({ length: 10 }, (_, i) => `S${i}`), 'BIGFUND']);
    expect(collapsedFeeRows(rows.slice(0, 3), 10)).toHaveLength(3);
  });
});
