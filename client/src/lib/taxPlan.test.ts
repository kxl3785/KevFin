import { describe, it, expect } from 'vitest';
import { DEFAULT_TAX_PLAN, normalizeTaxPlan, resolveFiling, simTaxFor, taxYearDetail } from './taxPlan.ts';
import { runForecastSim, type SimTaxYear } from './forecastSim.ts';

describe('taxPlan', () => {
  it('defaults to the flat model, which gives the sim no tax settings at all', () => {
    expect(normalizeTaxPlan(undefined)).toEqual(DEFAULT_TAX_PLAN);
    expect(simTaxFor(DEFAULT_TAX_PLAN, { twoEarners: true, retireAge: 65 })).toBeUndefined();
  });

  it('repairs junk and missing fields', () => {
    const p = normalizeTaxPlan({ mode: 'brackets', filing: 'hoh', stateRate: 7, convRate: 0.5, convEndAge: 'x', convStartAge: 'y' });
    expect(p.mode).toBe('brackets');
    expect(p.filing).toBe('auto');
    expect(p.stateRate).toBe(0.2);
    expect(p.convRate).toBe(0.22);
    expect(p.convEndAge).toBe(72);
    expect(p.convStartAge).toBeNull();
    expect(normalizeTaxPlan({ stateRate: -1 }).stateRate).toBe(0);
    expect(normalizeTaxPlan(null)).toEqual(DEFAULT_TAX_PLAN);
  });

  it('files jointly by default when the second earner is on', () => {
    expect(resolveFiling(DEFAULT_TAX_PLAN, true)).toBe('joint');
    expect(resolveFiling(DEFAULT_TAX_PLAN, false)).toBe('single');
    expect(resolveFiling({ ...DEFAULT_TAX_PLAN, filing: 'single' }, true)).toBe('single');
  });

  it('leaves a blank conversion start for the sim to resolve, and never ends before an explicit start', () => {
    const on = { ...DEFAULT_TAX_PLAN, mode: 'brackets' as const, convOn: true };
    // Blank start, no age given (as the Forecast page calls it) → null: the sim reads
    // earner 0's retirement age from the input it runs, so the Retire lever moves the
    // window (see the next test). Given an age, a blank start is pinned to it.
    expect(simTaxFor(on, { twoEarners: false })?.conversions).toEqual({ startAge: null, endAge: 72, bracketRate: 0.22, irmaaCap: true });
    expect(simTaxFor(on, { twoEarners: false, retireAge: 62 })?.conversions).toEqual({ startAge: 62, endAge: 72, bracketRate: 0.22, irmaaCap: true });
    expect(simTaxFor({ ...on, convStartAge: 75 }, { twoEarners: false, retireAge: 62 })?.conversions).toEqual({ startAge: 75, endAge: 75, bracketRate: 0.22, irmaaCap: true });
    expect(simTaxFor({ ...on, convOn: false }, { twoEarners: false, retireAge: 62 })?.conversions).toBeNull();
  });

  it('starts blank-start conversions at the retirement age of the input the sim runs (the lever), not the saved one', () => {
    // Saved plan retires at 65; the Retire lever (or the solver) runs it at 60.
    const plan = { ...DEFAULT_TAX_PLAN, mode: 'brackets' as const, convOn: true, convEndAge: 72 };
    const tax = simTaxFor(plan, { twoEarners: false })!;
    const run = (retireAge: number, t = tax) => runForecastSim({
      A: { endAge: 66, annualSpending: 40000, eduInflation: 0, collegeStartAge: 18, collegeYears: 4, collegeCostPerYear: 0, gradStartAge: 22, gradYears: 2, gradCostPerYear: 0, gradCoverage: 0, effTaxRate: 0.2, investReturn: 0, volatility: 0, realEstateGrowth: 0, retireTaxRate: 0.1 },
      currentAge0: 58, infl: 0, costPerKid: 0, kidIndependentAge: 22, kidAges: [], events: [],
      earners: [{ currentAge: 58, income: 120000, retireAge, raisePct: 0, ssEnabled: false, ssClaimAge: 67, ssAnnual: 0, enabled: true }],
      pools0: { taxable: 1_500_000, pretax: 1_500_000, roth: 0, hsa: 0, college: 0 },
      contribByBucket: { taxable: 0, pretax: 0, roth: 0, hsa: 0, college: 0 },
      baseRE: 0, hsaLast: true, collegeOn: false, gradOn: false, spendingAdjust: 1, runs: 1, yearNow: 2026, tax: t,
    }).tax!.medianPath;
    const conv = (path: ReturnType<typeof run>) => Object.fromEntries(path.map(y => [y.age, y.conversion]));
    const at60 = conv(run(60));
    expect(at60[58]).toBe(0); expect(at60[59]).toBe(0); // still working
    expect(at60[60]).toBeGreaterThan(0);                  // the first year without wages
    const at65 = conv(run(65));
    for (const a of [58, 59, 60, 61, 62, 63, 64]) expect(at65[a]).toBe(0); // the saved age: nothing before 65
    expect(at65[65]).toBeGreaterThan(0);
    // An explicit start still wins over the retirement age.
    const fixed = conv(run(60, simTaxFor({ ...plan, convStartAge: 62 }, { twoEarners: false })));
    expect(fixed[60]).toBe(0); expect(fixed[61]).toBe(0); expect(fixed[62]).toBeGreaterThan(0);
    // A retirement age past the end age gives a one-year window at that age, not none.
    const late = conv(run(66, simTaxFor({ ...plan, convEndAge: 62 }, { twoEarners: false })));
    expect(late[66]).toBeGreaterThan(0);
  });

  it('rebuilds a simulated year that matches the tax the sim charged', () => {
    const r = runForecastSim({
      A: { endAge: 70, annualSpending: 60000, eduInflation: 0, collegeStartAge: 18, collegeYears: 4, collegeCostPerYear: 0, gradStartAge: 22, gradYears: 2, gradCostPerYear: 0, gradCoverage: 0, effTaxRate: 0.2, investReturn: 0.05, volatility: 0.1, realEstateGrowth: 0, retireTaxRate: 0.1 },
      currentAge0: 62, infl: 0.03, costPerKid: 0, kidIndependentAge: 22, kidAges: [], events: [],
      earners: [{ currentAge: 62, income: 0, retireAge: 62, raisePct: 0, ssEnabled: true, ssClaimAge: 67, ssAnnual: 30000, enabled: true }],
      pools0: { taxable: 300000, pretax: 800000, roth: 0, hsa: 0, college: 0 },
      contribByBucket: { taxable: 0, pretax: 0, roth: 0, hsa: 0, college: 0 },
      baseRE: 0, hsaLast: true, collegeOn: false, gradOn: false, spendingAdjust: 1, runs: 40, yearNow: 2026,
      tax: { mode: 'brackets', filing: 'single', stateRate: 0, conversions: { startAge: 62, endAge: 70, bracketRate: 0.12, irmaaCap: true } },
    });
    const path = r.tax!.medianPath;
    expect(path.length).toBe(9);
    for (const rec of path) {
      const d = taxYearDetail(rec, 0.03);
      expect(d.result.total).toBeCloseTo(rec.fedTax, 6);
      expect(d.result.agi).toBeCloseTo(rec.magi, 6);
      expect(d.premiumYear).toBe(rec.year + 2);
      // Conversions fill to (not past) the top of the 12% bracket.
      if (rec.conversion > 0) expect(d.result.ordinaryTaxable).toBeLessThanOrEqual(d.params.brackets[2].from + 0.02);
    }
    expect(path.some(y => y.conversion > 0)).toBe(true);
  });

  // A bare record for taxYearDetail (no sim needed).
  const rec = (over: Partial<SimTaxYear>): SimTaxYear => ({
    age: 66, year: 2026, status: 'single', priceLevel: 1, age65Count: 1, medicareCount: 1, irmaaWatch: true,
    wages: 0, grossWages: [], socialSecurity: 0, rmd: 0, pretaxDraw: 0, conversion: 0, gains: 0,
    fedTax: 0, stateTax: 0, payroll: 0, penalty: 0, irmaaCost: 0, magi: 0, ...over,
  });

  it('measures bracket room as extra withdrawal that fits, counting Social Security phase-in and unused deduction', () => {
    // 2026 single 66, SS 30,000 only. Deduction 16,100 + 2,050 + 6,000 = 24,150. A withdrawal W
    // above 19,000 makes 0.85W − 11,650 of SS taxable, so taxable = 1.85W − 35,800 ≤ 12,400
    // → W = 48,200 / 1.85 = 26,054.05 (the old tile showed 12,400 − 0 = 12,400).
    const a = taxYearDetail(rec({ socialSecurity: 30000 }), 0);
    expect(a.result.bracketRate).toBe(0.10);
    expect(a.result.roomInBracket).toBe(12400); // the raw taxable-income figure is unchanged
    expect(Math.abs(a.roomAtRate! - 26054.05)).toBeLessThan(1);
    // 2029 single 65+ (2027 table at 0% inflation, no senior deduction): deduction 18,700.
    // 5,000 withdrawn → 13,700 of deduction unused + the 12,800-wide 10% bracket = 26,500.
    const b = taxYearDetail(rec({ year: 2029, pretaxDraw: 5000 }), 0);
    expect(b.result.roomInBracket).toBe(12800);
    expect(Math.abs(b.roomAtRate! - 26500)).toBeLessThan(1);
    // SS in the phase-in at 12%: SS 40,000 + 30,000 withdrawn → taxable 29,400; the
    // 12% top is 52,025, so 22,625 of taxable room, but each withdrawn dollar adds 1.85
    // taxable dollars here → 22,625 / 1.85 = 12,229.73 of withdrawal.
    const c = taxYearDetail(rec({ year: 2029, socialSecurity: 40000, pretaxDraw: 30000 }), 0);
    expect(c.result.bracketRate).toBe(0.12);
    expect(Math.abs(c.roomAtRate! - 12229.73)).toBeLessThan(1);
    // The top bracket has no room figure.
    expect(taxYearDetail(rec({ pretaxDraw: 2_000_000 }), 0).roomAtRate).toBeNull();
  });
});
