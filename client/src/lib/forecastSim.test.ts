import { describe, it, expect } from 'vitest';
import { runForecastSim, type SimInput } from './forecastSim.ts';

// A neutral baseline: one non-working earner, a single taxable pool, no income,
// no spending, no inflation, no taxes, no kids/education. Individual tests turn
// on just the dimension they exercise.
function baseInput(over: Partial<SimInput> = {}): SimInput {
  return {
    A: {
      endAge: 45,
      annualSpending: 0,
      eduInflation: 0,
      collegeStartAge: 18, collegeYears: 4, collegeCostPerYear: 0,
      gradStartAge: 22, gradYears: 2, gradCostPerYear: 0, gradCoverage: 0,
      effTaxRate: 0,
      investReturn: 0.05, volatility: 0,
      realEstateGrowth: 0,
      retireTaxRate: 0,
    },
    currentAge0: 40,
    infl: 0,
    costPerKid: 0,
    kidIndependentAge: 18,
    kidAges: [],
    events: [],
    // retireAge == currentAge → never working → no wage income or contributions.
    earners: [{ currentAge: 40, income: 0, retireAge: 40, raisePct: 0, ssEnabled: false, ssClaimAge: 67, ssAnnual: 0, enabled: true }],
    pools0: { taxable: 100000, pretax: 0, roth: 0, hsa: 0, college: 0 },
    contribByBucket: { taxable: 0, pretax: 0, roth: 0, hsa: 0, college: 0 },
    baseRE: 0,
    hsaLast: true,
    collegeOn: false,
    gradOn: false,
    spendingAdjust: 1,
    runs: 50,
    yearNow: 2026,
    ...over,
  };
}

describe('runForecastSim', () => {
  it('produces one band per projected year, labeled by age and calendar year', () => {
    const { bands } = runForecastSim(baseInput()); // ages 40..45 → 6 years
    expect(bands.length).toBe(6);
    bands.forEach((b, i) => {
      expect(b.age).toBe(40 + i);
      expect(b.year).toBe(2026 + i);
    });
  });

  it('floors the horizon at a single year when endAge precedes the current age', () => {
    const { bands } = runForecastSim(baseInput({ A: { ...baseInput().A, endAge: 39 } }));
    expect(bands.length).toBe(1);
  });

  it('matches closed-form compound growth when volatility is zero', () => {
    // No income, spending, or contributions → each pool just compounds at 5%.
    // After 6 yearly steps: 100000 · 1.05^6, identical across every run.
    const { bands, successPct } = runForecastSim(baseInput());
    const expected = 100000 * Math.pow(1.05, 6);
    const last = bands[bands.length - 1];
    expect(last.p50).toBeCloseTo(expected, 2);
    expect(last.band).toBe(0);       // zero volatility → no spread
    expect(successPct).toBe(100);    // no spending → never insolvent
  });

  it('grows real estate deterministically, independent of the random runs', () => {
    const { bands } = runForecastSim(baseInput({ baseRE: 500000, A: { ...baseInput().A, realEstateGrowth: 0.03 } }));
    bands.forEach((b, i) => {
      expect(b.re).toBe(Math.round(500000 * Math.pow(1.03, i + 1)));
    });
  });

  it('reports 0% success when spending dwarfs savings with no income', () => {
    const { bands, successPct } = runForecastSim(baseInput({
      pools0: { taxable: 1000, pretax: 0, roth: 0, hsa: 0, college: 0 },
      A: { ...baseInput().A, annualSpending: 100000 },
    }));
    expect(successPct).toBe(0);
    expect(bands[bands.length - 1].p50).toBe(0); // pools fully drained
  });

  it('is fully reproducible: identical inputs yield identical output', () => {
    const input = baseInput({ A: { ...baseInput().A, volatility: 0.15 } });
    expect(runForecastSim(input)).toEqual(runForecastSim(input));
  });

  it('produces a spread under volatility, with p10 ≤ p50 ≤ p90', () => {
    const { bands } = runForecastSim(baseInput({ A: { ...baseInput().A, volatility: 0.15 } }));
    const last = bands[bands.length - 1];
    expect(last.band).toBeGreaterThan(0);
    for (const b of bands) {
      expect(b.p10).toBeLessThanOrEqual(b.p50);
      expect(b.p50).toBeLessThanOrEqual(b.p10 + b.band); // p10 + band = p90
    }
  });

  it('taps home equity as a last resort only when opted in, lifting solvency', () => {
    // Retired now, spending far exceeds the tiny liquid pool, but a large house is
    // available. Without the toggle the run is insolvent (house untouched); with it,
    // home equity covers the shortfall and the run survives.
    const over = {
      pools0: { taxable: 5000, pretax: 0, roth: 0, hsa: 0, college: 0 },
      baseRE: 2_000_000,
      A: { ...baseInput().A, annualSpending: 80000, volatility: 0, realEstateGrowth: 0 },
    };
    const without = runForecastSim(baseInput(over));
    const withTap = runForecastSim(baseInput({ ...over, tapHomeEquity: true }));
    expect(without.successPct).toBe(0);
    expect(withTap.successPct).toBe(100);
    // And the net-worth band reflects the drawdown: the failing run keeps the whole
    // house, while the tapping run has spent part of it down by the final year.
    const last = (r: typeof without) => r.bands[r.bands.length - 1].p50;
    expect(last(withTap)).toBeLessThan(last(without));
  });

  it('does not tap home equity while still working, even when opted in', () => {
    // A working earner with a one-time cost they can't cover from liquid assets: the
    // house is off-limits during working years, so the toggle changes nothing.
    const over = {
      earners: [{ currentAge: 40, income: 10000, retireAge: 70, raisePct: 0, ssEnabled: false, ssClaimAge: 67, ssAnnual: 0, enabled: true }],
      pools0: { taxable: 1000, pretax: 0, roth: 0, hsa: 0, college: 0 },
      baseRE: 1_000_000,
      events: [{ type: 'oneTime', age: 41, amount: 500000 }],
      A: { ...baseInput().A, volatility: 0, realEstateGrowth: 0 },
    };
    expect(runForecastSim(baseInput(over)).successPct)
      .toBe(runForecastSim(baseInput({ ...over, tapHomeEquity: true })).successPct);
  });

  it('taxes Social Security at the retirement rate once nobody is working', () => {
    // Retired earner drawing only Social Security. The deterministic income net of
    // tax should reflect the retirement rate (15%), not the working rate (50%): with
    // a pool big enough to never need a withdrawal, end wealth = SS net of tax,
    // compounded. We isolate the tax path by checking the two rates diverge.
    const earner = { currentAge: 70, income: 0, retireAge: 65, raisePct: 0, ssEnabled: true, ssClaimAge: 67, ssAnnual: 100000, enabled: true };
    const base = {
      currentAge0: 70, earners: [earner],
      pools0: { taxable: 10_000_000, pretax: 0, roth: 0, hsa: 0, college: 0 },
      A: { ...baseInput().A, endAge: 71, investReturn: 0, volatility: 0, effTaxRate: 0.5, retireTaxRate: 0.15 },
    };
    const { bands } = runForecastSim(baseInput(base));
    // SS = 100k, 85% taxable at 15% → tax = 0.85*100k*0.15 = 12,750. Net SS added to
    // the pool in year 0 = 100k − 12,750 = 87,250 (no spending in the baseline).
    expect(bands[0].p50).toBeCloseTo(10_000_000 + 87_250, 0);
  });

  it('glide path narrows the outcome band versus staying fully invested', () => {
    const over = { A: { ...baseInput().A, endAge: 65, volatility: 0.15 } };
    const fully = runForecastSim(baseInput(over));
    const glided = runForecastSim(baseInput({ ...over, glidePath: true }));
    const lastBand = (r: typeof fully) => r.bands[r.bands.length - 1].band;
    expect(lastBand(glided)).toBeLessThan(lastBand(fully));
  });

  it('leaves results unchanged when the glide path is off (eq = 1)', () => {
    const input = baseInput({ A: { ...baseInput().A, volatility: 0.15 } });
    expect(runForecastSim({ ...input, glidePath: false })).toEqual(runForecastSim(input));
  });

  it('rewards pre-tax contributions via tax deferral (lower tax → higher wealth)', () => {
    // Same wages and tax rate; the only difference is a deductible pre-tax
    // contribution, which shrinks taxable income and the tax bill — so the saver
    // ends up ahead. (A *taxable* contribution would be net-neutral.)
    const earner = { currentAge: 40, income: 200000, retireAge: 70, raisePct: 0, ssEnabled: false, ssClaimAge: 67, ssAnnual: 0, enabled: true };
    const taxed = { ...baseInput().A, effTaxRate: 0.3 };
    const withPretax = runForecastSim(baseInput({
      earners: [earner], A: taxed,
      contribByBucket: { taxable: 0, pretax: 20000, roth: 0, hsa: 0, college: 0 },
    }));
    const without = runForecastSim(baseInput({ earners: [earner], A: taxed }));
    const a = withPretax.bands[withPretax.bands.length - 1].p50;
    const b = without.bands[without.bands.length - 1].p50;
    expect(a).toBeGreaterThan(b);
  });
});
