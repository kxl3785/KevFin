import { describe, it, expect } from 'vitest';
import { runForecastSim, type SimInput } from './forecastSim.ts';
import {
  solvePlan, solveScenarioRow, maxSpendWhere, minBalanceWhere, runToEnd, runInSlices, Evaluator,
  withInvestable, withSpending, investableOf, spendingOf, shiftRetirement, stopWorkNow, normalizeTargets,
  hashInputs, AnswerCache, DEFAULT_TARGETS, SPEND_STEP, handleSolveJob, jobGenerator, answerRule, type SolveMessage,
} from './forecastSolve.ts';
import { DEFAULT_WITHDRAWAL_RULE } from './withdrawalRules.ts';

// A mid-career single earner: 40, $500k saved, $70k spending, retiring at 65,
// Social Security from 67. Fewer paths than the solver's default keep the suite fast;
// the searches don't care how many paths a rate is read from.
const RUNS = 150;
function plan(over: Partial<SimInput> = {}): SimInput {
  return {
    A: {
      endAge: 90, annualSpending: 70000, eduInflation: 0.05,
      collegeStartAge: 18, collegeYears: 4, collegeCostPerYear: 0,
      gradStartAge: 22, gradYears: 2, gradCostPerYear: 0, gradCoverage: 0,
      effTaxRate: 0.24, investReturn: 0.07, volatility: 0.15, realEstateGrowth: 0.04, retireTaxRate: 0.15,
    },
    currentAge0: 40, infl: 0.03, costPerKid: 0, kidIndependentAge: 22, kidAges: [], events: [],
    earners: [{ currentAge: 40, income: 180000, retireAge: 65, raisePct: 0.02, ssEnabled: true, ssClaimAge: 67, ssAnnual: 36000, employerMatch: 12000, enabled: true }],
    pools0: { taxable: 150000, pretax: 300000, roth: 50000, hsa: 0, college: 20000 },
    contribByBucket: { taxable: 0, pretax: 23000, roth: 0, hsa: 0, college: 0 },
    baseRE: 0, hsaLast: true, collegeOn: false, gradOn: false, spendingAdjust: 1, yearNow: 2026,
    runs: RUNS,
    ...over,
  };
}
const rate = (x: SimInput) => runForecastSim({ ...x, runs: RUNS, exactSuccess: true }).successRate as number;

// Synthetic predicates for the search helpers (no simulation involved).
const pred = (f: (v: number) => boolean) => function* (v: number): Generator<number, boolean> { yield 0; return f(v); };

describe('sim switches used by the solver', () => {
  it('leaves the default result untouched (no successRate unless asked)', () => {
    const r = runForecastSim(plan());
    expect('successRate' in r).toBe(false);
    expect(runForecastSim({ ...plan(), seedOffset: 0, coast: false })).toEqual(r);
  });

  it('reports the unrounded success share alongside the rounded percentage', () => {
    const r = runForecastSim({ ...plan(), exactSuccess: true });
    expect(r.successRate).toBeGreaterThanOrEqual(0);
    expect(r.successRate).toBeLessThanOrEqual(1);
    expect(Math.round((r.successRate as number) * 100)).toBe(r.successPct);
  });

  it('coast: no contributions, no match, and leftover pay is spent while working', () => {
    // No volatility, 5% return, no tax: $100k with $100k pay and $50k spending.
    // Coasting, the balance just compounds: 100000 · 1.05^5 after five working years.
    const x = plan({
      A: { ...plan().A, endAge: 44, annualSpending: 50000, effTaxRate: 0, retireTaxRate: 0, investReturn: 0.05, volatility: 0 },
      infl: 0,
      earners: [{ currentAge: 40, income: 100000, retireAge: 80, raisePct: 0, ssEnabled: false, ssClaimAge: 67, ssAnnual: 0, employerMatch: 5000, enabled: true }],
      pools0: { taxable: 100000, pretax: 0, roth: 0, hsa: 0, college: 0 },
      contribByBucket: { taxable: 0, pretax: 10000, roth: 0, hsa: 0, college: 0 },
    });
    const coast = runForecastSim({ ...x, coast: true });
    expect(coast.bands[4].p50).toBeCloseTo(100000 * Math.pow(1.05, 5), 4);
    // Without coast the surplus ($100k − $10k pre-tax − $50k = $40k), the $10k
    // contribution and the $5k match are all invested each year: $55k/yr more.
    const normal = runForecastSim(x);
    let bal = 100000;
    for (let i = 0; i < 5; i++) bal = bal * 1.05 + 55000;
    expect(normal.bands[4].p50).toBeCloseTo(bal, 4);
  });

  it('seedOffset draws a different set of paths', () => {
    const a = runForecastSim({ ...plan(), exactSuccess: true });
    const b = runForecastSim({ ...plan(), exactSuccess: true, seedOffset: 10_000 });
    expect(b.bands[10].p50).not.toBe(a.bands[10].p50);
  });
});

describe('dials', () => {
  it('scales the investable balance keeping the mix, leaving the 529 alone', () => {
    const x = withInvestable(plan(), 1_000_000);
    expect(investableOf(x)).toBeCloseTo(1_000_000, 6);
    expect(x.pools0.taxable).toBeCloseTo(300000, 6);
    expect(x.pools0.pretax).toBeCloseTo(600000, 6);
    expect(x.pools0.roth).toBeCloseTo(100000, 6);
    expect(x.pools0.college).toBe(20000);
    expect(investableOf(withInvestable(plan(), -5))).toBe(0);
  });

  it('puts a balance into the taxable account when there is no mix to keep', () => {
    const empty = plan({ pools0: { taxable: 0, pretax: 0, roth: 0, hsa: 0, college: 0 } });
    expect(withInvestable(empty, 250000).pools0.taxable).toBe(250000);
  });

  it('reads and sets spending through the Spending lever', () => {
    expect(spendingOf(plan({ spendingAdjust: 0.9 }))).toBeCloseTo(63000, 6);
    const s = withSpending(plan({ spendingAdjust: 0.9 }), 80000);
    expect(s.A.annualSpending).toBe(80000);
    expect(s.spendingAdjust).toBe(1);
  });

  it('shifts only the earners still working, never before today', () => {
    const two = plan({ earners: [
      plan().earners[0],
      { currentAge: 38, income: 90000, retireAge: 60, raisePct: 0.02, ssEnabled: false, ssClaimAge: 67, ssAnnual: 0, enabled: true },
      { currentAge: 70, income: 0, retireAge: 65, raisePct: 0, ssEnabled: false, ssClaimAge: 67, ssAnnual: 0, enabled: true },
    ] });
    const s = shiftRetirement(two, -3);
    expect(s.earners.map(e => e.retireAge)).toEqual([62, 57, 65]);
    expect(shiftRetirement(two, -40).earners.map(e => e.retireAge)).toEqual([40, 38, 65]);
    expect(stopWorkNow(two).earners.map(e => e.retireAge)).toEqual([40, 38, 65]);
  });
});

describe('search helpers', () => {
  it('maxSpendWhere lands on the highest $500 step that passes, from any start', () => {
    for (const start of [0, 1000, 73000, 73500, 200000, 4_000_000]) {
      const r = runToEnd(maxSpendWhere(pred(s => s <= 73_250), start));
      expect(r).toEqual({ status: 'ok', amount: 73000 });
    }
    // Exactly at a step boundary: 73,500 passes, 74,000 does not.
    expect(runToEnd(maxSpendWhere(pred(s => s <= 73_500), 10_000))).toEqual({ status: 'ok', amount: 73500 });
  });

  it('maxSpendWhere: never (not even $0) and unbounded (passes at the cap)', () => {
    expect(runToEnd(maxSpendWhere(pred(() => false), 70000))).toEqual({ status: 'never' });
    expect(runToEnd(maxSpendWhere(pred(() => false), 0))).toEqual({ status: 'never' });
    expect(runToEnd(maxSpendWhere(pred(() => true), 70000))).toEqual({ status: 'unbounded' });
    expect(runToEnd(maxSpendWhere(pred(s => s === 0), 70000))).toEqual({ status: 'ok', amount: 0 });
  });

  it('minBalanceWhere converges to within max($1,000, 0.5%) above the threshold', () => {
    for (const start of [0, 50_000, 123_456, 2_000_000]) {
      const r = runToEnd(minBalanceWhere(pred(b => b >= 123_456), start));
      expect(r.status).toBe('ok');
      const amt = (r as { amount: number }).amount;
      expect(amt).toBeGreaterThanOrEqual(123_456);
      expect(amt - 123_456).toBeLessThanOrEqual(1000 + 1000);
      // Whole thousands, unless the start itself passed and is reported as is.
      if (amt !== start) expect(amt % 1000).toBe(0);
    }
  });

  it('minBalanceWhere: zero when nothing is needed, out of reach when nothing passes', () => {
    expect(runToEnd(minBalanceWhere(pred(() => true), 300_000))).toEqual({ status: 'ok', amount: 0 });
    expect(runToEnd(minBalanceWhere(pred(() => true), 0))).toEqual({ status: 'ok', amount: 0 });
    expect(runToEnd(minBalanceWhere(pred(() => false), 300_000))).toEqual({ status: 'outOfReach' });
  });

  it('minBalanceWhere never reports more than a starting balance that already passes', () => {
    const r = runToEnd(minBalanceWhere(pred(b => b >= 499_700), 500_300));
    expect(r).toEqual({ status: 'ok', amount: 500_300 });
  });
});

describe('common random numbers keep success monotone', () => {
  const variants: [string, Partial<SimInput>][] = [
    ['flat tax', {}],
    ['bracket tax with conversions', { tax: { mode: 'brackets', filing: 'single', stateRate: 0.04, conversions: { startAge: 65, endAge: 72, bracketRate: 0.22, irmaaCap: true } } }],
    ['guardrails spending rule', { withdrawal: { ...DEFAULT_WITHDRAWAL_RULE, kind: 'guardrails' } }],
    ['historical replay', { returnModel: 'historical' }],
  ];
  for (const [name, over] of variants) {
    it(`more spending never raises success (${name})`, () => {
      let prev = Infinity;
      for (let s = 30000; s <= 180000; s += 15000) {
        const r = rate(withSpending(plan(over), s));
        expect(r).toBeLessThanOrEqual(prev);
        prev = r;
      }
    });
    it(`a bigger balance never lowers success (${name})`, () => {
      let prev = -Infinity;
      for (const b of [0, 100e3, 250e3, 500e3, 1e6, 2e6]) {
        const r = rate(withInvestable(withSpending(plan(over), 110000), b));
        expect(r).toBeGreaterThanOrEqual(prev);
        prev = r;
      }
    });
  }
});

describe('solvePlan', () => {
  const solved = runToEnd(solvePlan(plan(), DEFAULT_TARGETS, RUNS));

  it('finds the highest $500 step of spending that keeps 85%', () => {
    expect(solved.safeSpending.status).toBe('ok');
    const S = (solved.safeSpending as { amount: number }).amount;
    expect(S % SPEND_STEP).toBe(0);
    expect(rate(withSpending(plan(), S))).toBeGreaterThanOrEqual(0.85);
    expect(rate(withSpending(plan(), S + SPEND_STEP))).toBeLessThan(0.85);
    expect(solved.current.spending).toBe(70000);
    expect(solved.current.investable).toBe(500000);
    expect(solved.current.successRate).toBeCloseTo(rate(plan()), 12);
  });

  it('gives the same answers on every call', () => {
    expect(runToEnd(solvePlan(plan(), DEFAULT_TARGETS, RUNS))).toEqual(solved);
  });

  it('places the guardrails around today and checks them against the simulation', () => {
    const S = (solved.safeSpending as { amount: number }).amount;
    const g = solved.guardrails!;
    expect(g.lower && g.upper).toBeTruthy();
    const lo = g.lower!, up = g.upper!;
    expect(lo.balance).toBeLessThan(500000);
    expect(up.balance).toBeGreaterThan(500000);
    const at = (b: number, s = S) => rate(withInvestable(withSpending(plan(), s), b));
    // At the lower guardrail success is still ≥ 70%; a little below (beyond the
    // search tolerance) it is under.
    expect(at(lo.balance)).toBeGreaterThanOrEqual(0.70);
    expect(at(lo.balance - 2000 - lo.balance * 0.005)).toBeLessThan(0.70);
    expect(at(up.balance)).toBeGreaterThanOrEqual(0.95);
    expect(at(up.balance - 2000 - up.balance * 0.005)).toBeLessThan(0.95);
    // The spending that restores 85% there: lower balance → less, higher → more.
    expect(lo.spending).not.toBeNull();
    expect(up.spending).not.toBeNull();
    expect(lo.spending!).toBeLessThan(S);
    expect(up.spending!).toBeGreaterThan(S);
    expect(at(lo.balance, lo.spending!)).toBeGreaterThanOrEqual(0.85);
    expect(at(lo.balance, lo.spending! + SPEND_STEP)).toBeLessThan(0.85);
  });

  it('independence number: stopping today works at it and not much below it', () => {
    expect(solved.independence.status).toBe('ok');
    const { amount, progress } = solved.independence as { amount: number; progress: number };
    expect(amount).toBeGreaterThan(500000);
    expect(progress).toBeCloseTo(500000 / amount, 12);
    const at = (b: number) => rate(withInvestable(stopWorkNow(plan()), b));
    expect(at(amount)).toBeGreaterThanOrEqual(0.85);
    expect(at(amount * 0.99 - 2000)).toBeLessThan(0.85);
  });

  it('coast point: a balance that carries retirement at 65 with no new saving', () => {
    expect(solved.coast.status).toBe('ok');
    const c = solved.coast as { amount: number; coasting: boolean };
    expect(c.coasting).toBe(500000 >= c.amount);
    const at = (b: number) => rate({ ...withInvestable(plan(), b), coast: true });
    expect(at(c.amount)).toBeGreaterThanOrEqual(0.85);
    expect(at(c.amount * 0.99 - 2000)).toBeLessThan(0.85);
    // Coasting needs less than stopping work today (wages still pay the bills).
    expect(c.amount).toBeLessThan((solved.independence as { amount: number }).amount);
  });

  it('earliest workable retirement age: works at that age, not a year sooner', () => {
    expect(solved.earliestRetirement.status).toBe('ok');
    const e = solved.earliestRetirement as { age: number; shift: number };
    expect(e.age).toBe(65 + e.shift);
    expect(rate(shiftRetirement(plan(), e.shift))).toBeGreaterThanOrEqual(0.85);
    if (e.age > 40) expect(rate(shiftRetirement(plan(), e.shift - 1))).toBeLessThan(0.85);
  });

  it('a plan that never succeeds: no safe spending, no workable retirement age', () => {
    // A $400k/yr fixed cost (a recurring event, which spending cuts can't touch)
    // and no savings: even $0 of everyday spending fails.
    const x = plan({
      pools0: { taxable: 0, pretax: 0, roth: 0, hsa: 0, college: 0 },
      events: [{ type: 'recurring', age: 40, amount: 400000, untilAge: 90 }],
    });
    const r = runToEnd(solvePlan(x, DEFAULT_TARGETS, RUNS));
    expect(r.safeSpending).toEqual({ status: 'never' });
    expect(r.guardrails).toBeNull();
    expect(r.earliestRetirement).toEqual({ status: 'never' });
    expect(r.current.successRate).toBe(0);
    for (const v of [r.current.spending, r.current.investable]) expect(Number.isFinite(v)).toBe(true);
  });

  it('a plan that always succeeds: unbounded spending, no guardrails, nothing needed to stop', () => {
    // Social Security far larger than any spending the solver tries.
    const x = plan({
      earners: [{ currentAge: 40, income: 0, retireAge: 40, raisePct: 0, ssEnabled: true, ssClaimAge: 40, ssAnnual: 8_000_000, enabled: true }],
      A: { ...plan().A, effTaxRate: 0, retireTaxRate: 0 },
    });
    const r = runToEnd(solvePlan(x, DEFAULT_TARGETS, RUNS));
    expect(r.safeSpending).toEqual({ status: 'unbounded' });
    expect(r.guardrails).toBeNull();
    expect(r.independence).toEqual({ status: 'ok', amount: 0, progress: 1 });
    expect(r.current.successRate).toBe(1);
  });

  it('already retired: no coast point or retirement age to find; independence is the balance needed', () => {
    const x = plan({
      currentAge0: 66,
      earners: [{ currentAge: 66, income: 0, retireAge: 60, raisePct: 0, ssEnabled: true, ssClaimAge: 67, ssAnnual: 36000, enabled: true }],
      pools0: { taxable: 400000, pretax: 900000, roth: 100000, hsa: 0, college: 0 },
      contribByBucket: { taxable: 0, pretax: 0, roth: 0, hsa: 0, college: 0 },
    });
    const r = runToEnd(solvePlan(x, DEFAULT_TARGETS, RUNS));
    expect(r.coast).toEqual({ status: 'retired' });
    expect(r.earliestRetirement).toEqual({ status: 'retired' });
    expect(r.independence.status).toBe('ok');
    const ind = r.independence as { amount: number; progress: number };
    // Already retired → the independence balance is just the balance this plan needs.
    if (r.current.successRate >= 0.85) {
      expect(ind.amount).toBeLessThanOrEqual(1_400_000);
      expect(ind.progress).toBeGreaterThanOrEqual(1);
    } else {
      expect(ind.amount).toBeGreaterThan(1_400_000);
      expect(ind.progress).toBeLessThan(1);
    }
  });

  it('works under the bracket tax model, historical replay and spending rules (all finite)', () => {
    const settings: Partial<SimInput>[] = [
      { tax: { mode: 'brackets', filing: 'joint', stateRate: 0.05, conversions: { startAge: 65, endAge: 72, bracketRate: 0.22, irmaaCap: true } } },
      { returnModel: 'historical', historicalStockShare: 0.6 },
      { withdrawal: { ...DEFAULT_WITHDRAWAL_RULE, kind: 'guardrails' } },
      { withdrawal: { ...DEFAULT_WITHDRAWAL_RULE, kind: 'percentOfPortfolio', percent: { rate: 0.04, floor: 0.8, ceiling: 1.5 } } },
    ];
    for (const s of settings) {
      const r = runToEnd(solvePlan(plan(s), DEFAULT_TARGETS, 80));
      const nums = JSON.stringify(r).match(/-?\d+(\.\d+)?(e[+-]?\d+)?|null|NaN|Infinity/g) ?? [];
      expect(nums).not.toContain('NaN');
      expect(nums).not.toContain('Infinity');
      if (r.safeSpending.status === 'ok') expect(r.safeSpending.amount % SPEND_STEP).toBe(0);
    }
  });

  it('counts its simulations and memoises repeated candidates', () => {
    const ev = new Evaluator(plan(), 50);
    runToEnd(ev.rate({ spend: 60000 }));
    runToEnd(ev.rate({ spend: 60000 }));
    runToEnd(ev.rate({}));
    expect(ev.sims).toBe(2);
  });
});

describe('solveScenarioRow', () => {
  it('reports success, median ending net worth in today\'s $, safe spending and retirement age', () => {
    const r = runToEnd(solveScenarioRow(plan(), DEFAULT_TARGETS, RUNS));
    const sim = runForecastSim({ ...plan(), exactSuccess: true });
    const last = sim.bands[sim.bands.length - 1];
    expect(r.successRate).toBeCloseTo(sim.successRate as number, 12);
    expect(r.medianEndReal).toBeCloseTo(last.p50 / Math.pow(1.03, 90 - 40 + 1), 6);
    expect(r.retireAge).toBe(65);
    expect(r.safeSpending).toEqual(runToEnd(solvePlan(plan(), DEFAULT_TARGETS, RUNS)).safeSpending);
  });
});

describe('targets, hashing, cache and the sliced driver', () => {
  it('normalizes targets into order', () => {
    expect(normalizeTargets(undefined)).toEqual(DEFAULT_TARGETS);
    const t = normalizeTargets({ target: 0.9, lower: 0.95, upper: 0.5 });
    expect(t.target).toBe(0.9);
    expect(t.lower).toBeCloseTo(0.75, 12);
    expect(t.upper).toBeCloseTo(0.95, 12);
    expect(normalizeTargets({ target: 5 }).target).toBe(0.99);
    expect(normalizeTargets({ target: NaN }).target).toBe(0.85);
  });

  it('hashes inputs stably and distinguishes changes', () => {
    expect(hashInputs(plan())).toBe(hashInputs(plan()));
    expect(hashInputs(plan())).not.toBe(hashInputs(withSpending(plan(), 70500)));
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(typeof hashInputs(cyclic)).toBe('string');
  });

  it('keeps the most recently used entries', () => {
    const c = new AnswerCache<number>(2);
    c.set('a', 1); c.set('b', 2); c.get('a'); c.set('c', 3);
    expect(c.get('a')).toBe(1);
    expect(c.get('b')).toBeUndefined();
    expect(c.get('c')).toBe(3);
  });

  it('runs a solve in slices and reports progress, or stops on cancel', async () => {
    const progress: number[] = [];
    const out = await new Promise(resolve => {
      runInSlices(solvePlan(plan(), DEFAULT_TARGETS, 40), { onDone: resolve, onProgress: n => progress.push(n), sliceMs: 0 });
    });
    expect(out).toEqual(runToEnd(solvePlan(plan(), DEFAULT_TARGETS, 40)));
    expect(progress.length).toBeGreaterThan(5);
    expect([...progress].sort((a, b) => a - b)).toEqual(progress);

    let done = false;
    const cancel = runInSlices(solvePlan(plan(), DEFAULT_TARGETS, 40), { onDone: () => { done = true; }, sliceMs: 0 });
    cancel();
    await new Promise(r => setTimeout(r, 50));
    expect(done).toBe(false);
  });
});


// --- Regression tests for the answers fix pass ----------------------------------

describe('coast keeps one-off sale proceeds received while working (AM-1)', () => {
  // No volatility, 5% return, no inflation or flat tax: $100k pay, $50k spending,
  // working to 80. A $200k sale lands at 42 (plan year 2), after that year's
  // growth, so by the end of 44 (band 4) it has grown two more years:
  // 200,000 × 1.05² = 220,500 more than coasting without it.
  const x = (events: SimInput['events'], tax?: SimInput['tax']) => plan({
    A: { ...plan().A, endAge: 44, annualSpending: 50000, effTaxRate: 0, retireTaxRate: 0, investReturn: 0.05, volatility: 0 },
    infl: 0, events, ...(tax ? { tax } : {}),
    earners: [{ currentAge: 40, income: 100000, retireAge: 80, raisePct: 0, ssEnabled: false, ssClaimAge: 67, ssAnnual: 0, employerMatch: 5000, enabled: true }],
    pools0: { taxable: 100000, pretax: 0, roth: 0, hsa: 0, college: 0 },
    contribByBucket: { taxable: 0, pretax: 10000, roth: 0, hsa: 0, college: 0 },
  });
  const sale = [{ type: 'oneTime', age: 42, amount: 200000, isSale: true }];

  it('flat tax: the sale lifts the coast balance by the sale grown at the return', () => {
    const without = runForecastSim({ ...x([]), coast: true });
    const withSale = runForecastSim({ ...x(sale), coast: true });
    expect(without.bands[4].p50).toBeCloseTo(100000 * Math.pow(1.05, 5), 4); // leftover pay still spent
    expect(withSale.bands[4].p50 - without.bands[4].p50).toBeCloseTo(200000 * 1.05 * 1.05, 4);
  });

  it('bracket tax: the same', () => {
    const tax: SimInput['tax'] = { mode: 'brackets', filing: 'single', stateRate: 0, conversions: null };
    const without = runForecastSim({ ...x([], tax), coast: true });
    const withSale = runForecastSim({ ...x(sale, tax), coast: true });
    expect(withSale.bands[4].p50 - without.bands[4].p50).toBeCloseTo(200000 * 1.05 * 1.05, 4);
  });

  it('non-coast runs are unchanged by the fix: the whole surplus is invested', () => {
    const r = runForecastSim(x(sale));
    // $100k − $10k pre-tax − $50k = $40k surplus + $10k contribution + $5k match, plus the sale at 42.
    let bal = 100000;
    for (let i = 0; i < 5; i++) bal = bal * 1.05 + 55000 + (i === 2 ? 200000 : 0);
    expect(r.bands[4].p50).toBeCloseTo(bal, 4);
  });

  it('solvePlan: a working-year sale lowers the coast balance', () => {
    const a = runToEnd(solvePlan(plan(), DEFAULT_TARGETS, RUNS));
    const b = runToEnd(solvePlan(plan({ events: [{ type: 'oneTime', age: 50, amount: 1_500_000, isSale: true }] }), DEFAULT_TARGETS, RUNS));
    expect(a.coast.status).toBe('ok');
    expect(b.coast.status).toBe('ok');
    expect((b.coast as { amount: number }).amount).toBeLessThan((a.coast as { amount: number }).amount);
  });
});

describe('the lead earner when earner 0 has already retired (AM-2 / AU-2)', () => {
  // Earner 0: 62, retired at 60. Partner: 55, working to 65.
  const x = plan({
    A: { ...plan().A, endAge: 95, annualSpending: 80000 },
    currentAge0: 62,
    earners: [
      { currentAge: 62, income: 0, retireAge: 60, raisePct: 0.02, ssEnabled: true, ssClaimAge: 67, ssAnnual: 30000, employerMatch: 0, enabled: true },
      { currentAge: 55, income: 160000, retireAge: 65, raisePct: 0.02, ssEnabled: true, ssClaimAge: 67, ssAnnual: 25000, employerMatch: 0, enabled: true },
    ],
    pools0: { taxable: 200000, pretax: 700000, roth: 0, hsa: 0, college: 0 },
    contribByBucket: { taxable: 0, pretax: 20000, roth: 0, hsa: 0, college: 0 },
  });
  const r = runToEnd(solvePlan(x, DEFAULT_TARGETS, RUNS));

  it('names the partner as the lead and reports the partner\'s age', () => {
    expect(r.lead).toEqual({ index: 1, currentAge: 55, retireAge: 65 });
    const er = r.earliestRetirement;
    expect(er.status).toBe('ok');
    if (er.status !== 'ok') return;
    expect(er.age).toBe(Math.max(55, 65 + er.shift)); // the partner's planned 65, shifted
    expect(er.partnerAge).toBeNull();
  });

  it('earner 0 working: the lead is earner 0 and the partner age is reported as before', () => {
    const both = plan({ earners: [
      { currentAge: 40, income: 180000, retireAge: 65, raisePct: 0.02, ssEnabled: true, ssClaimAge: 67, ssAnnual: 36000, employerMatch: 12000, enabled: true },
      { currentAge: 38, income: 90000, retireAge: 63, raisePct: 0.02, ssEnabled: true, ssClaimAge: 67, ssAnnual: 20000, employerMatch: 0, enabled: true },
    ] });
    const rb = runToEnd(solvePlan(both, DEFAULT_TARGETS, RUNS));
    expect(rb.lead).toEqual({ index: 0, currentAge: 40, retireAge: 65 });
    const er = rb.earliestRetirement;
    if (er.status !== 'ok') throw new Error('expected an age');
    expect(er.age).toBe(Math.max(40, 65 + er.shift));
    expect(er.partnerAge).toBe(Math.max(38, 63 + er.shift));
  });
});

describe('answers under a spending rule (AM-3 / AU-1 / XR-5)', () => {
  it('share of savings: none of the dial answers are worked out', () => {
    const x = plan({ pools0: { taxable: 50000, pretax: 0, roth: 0, hsa: 0, college: 0 }, withdrawal: { ...DEFAULT_WITHDRAWAL_RULE, kind: 'percentOfPortfolio' } });
    expect(answerRule(x)).toBe('percentOfPortfolio');
    const r = runToEnd(solvePlan(x, DEFAULT_TARGETS, RUNS));
    expect(r.rule).toBe('percentOfPortfolio');
    for (const k of ['safeSpending', 'independence', 'coast', 'earliestRetirement'] as const) expect(r[k]).toEqual({ status: 'notApplicable' });
    expect(r.guardrails).toBeNull();
    // Today's chance is still reported, from the plan as entered.
    expect(r.current.successRate).toBeCloseTo(runForecastSim({ ...x, runs: RUNS, exactSuccess: true }).successRate as number, 12);
  });

  it('share of savings with a floor is treated the same way', () => {
    const r = runToEnd(solvePlan(plan({ withdrawal: { ...DEFAULT_WITHDRAWAL_RULE, kind: 'percentOfPortfolio', percent: { rate: 0.04, floor: 0.8, ceiling: null } } }), DEFAULT_TARGETS, 40));
    expect(r.safeSpending).toEqual({ status: 'notApplicable' });
  });

  it('a scenario row under share of savings shows no safe spending', () => {
    const row = runToEnd(solveScenarioRow(plan({ withdrawal: { ...DEFAULT_WITHDRAWAL_RULE, kind: 'percentOfPortfolio' } }), DEFAULT_TARGETS, RUNS));
    expect(row.safeSpending).toEqual({ status: 'notApplicable' });
    expect(row.rule).toBe('percentOfPortfolio');
  });

  it('guardrails: the answers are worked out (counting on the rule\'s cuts), the card\'s own guardrails are not', () => {
    const r = runToEnd(solvePlan(plan({ withdrawal: { ...DEFAULT_WITHDRAWAL_RULE, kind: 'guardrails' } }), DEFAULT_TARGETS, RUNS));
    expect(r.rule).toBe('guardrails');
    expect(r.safeSpending.status).toBe('ok');
    expect(r.guardrails).toBeNull();
    expect(['ok', 'outOfReach']).toContain(r.independence.status);
  });

  it('steady spending: unchanged (rule fixed, guardrails worked out)', () => {
    const r = runToEnd(solvePlan(plan(), DEFAULT_TARGETS, RUNS));
    expect(r.rule).toBe('fixed');
    expect(r.guardrails).not.toBeNull();
    expect(answerRule(plan({ withdrawal: { ...DEFAULT_WITHDRAWAL_RULE } }))).toBe('fixed');
  });
});

describe('historical flag (AU-10)', () => {
  it('true when past starting years were replayed', () => {
    const r = runToEnd(solvePlan(plan({ returnModel: 'historical' }), DEFAULT_TARGETS, RUNS));
    expect(r.historical).toBe(true);
  });
  it('false when no starting year fits and the sim fell back to random futures', () => {
    // 18 to 120 is 103 years, longer than any run of the 1928–2025 record.
    const x = plan({
      returnModel: 'historical', currentAge0: 18, A: { ...plan().A, endAge: 120 },
      earners: [{ currentAge: 18, income: 180000, retireAge: 65, raisePct: 0.02, ssEnabled: true, ssClaimAge: 67, ssAnnual: 36000, employerMatch: 12000, enabled: true }],
    });
    expect(runForecastSim(x).historical?.fallback).toBe(true);
    const r = runToEnd(solvePlan(x, DEFAULT_TARGETS, 30));
    expect(r.historical).toBe(false);
    expect(r.runs).toBe(30);
  });
});

describe('solve jobs (XR-7: run off the page\'s thread)', () => {
  it('a plan job gives exactly solvePlan\'s answers', () => {
    const job = { kind: 'plan' as const, input: plan(), targets: DEFAULT_TARGETS, runs: 40 };
    expect(runToEnd(jobGenerator(job))).toEqual(runToEnd(solvePlan(plan(), DEFAULT_TARGETS, 40)));
  });

  it('a rows job gives each scenario row in order, yielding the rows finished', () => {
    const inputs = [plan(), withSpending(plan(), 90000)];
    const gen = jobGenerator({ kind: 'rows', inputs, targets: DEFAULT_TARGETS, runs: 40 });
    const seen = new Set<number>();
    let s = gen.next();
    while (!s.done) { seen.add(s.value as number); s = gen.next(); }
    expect([...seen]).toEqual([0, 1]);
    expect(s.value).toEqual(inputs.map(x => runToEnd(solveScenarioRow(x, DEFAULT_TARGETS, 40))));
  });

  it('the worker handler posts throttled progress, then the result; or the error', () => {
    const msgs: SolveMessage[] = [];
    let clock = 0;
    handleSolveJob({ kind: 'plan', input: plan(), targets: DEFAULT_TARGETS, runs: 30 }, m => msgs.push(m), 80, () => (clock += 20));
    const done = msgs[msgs.length - 1];
    expect(done.type).toBe('done');
    expect(done.type === 'done' && done.value).toEqual(runToEnd(solvePlan(plan(), DEFAULT_TARGETS, 30)));
    const prog = msgs.filter(m => m.type === 'progress').map(m => (m as { n: number }).n);
    expect(prog.length).toBeGreaterThan(2);
    expect([...prog].sort((a, b) => a - b)).toEqual(prog);

    const err: SolveMessage[] = [];
    handleSolveJob({ kind: 'plan', input: null as unknown as SimInput, targets: DEFAULT_TARGETS }, m => err.push(m));
    expect(err.map(m => m.type)).toEqual(['error']);
  });
});
