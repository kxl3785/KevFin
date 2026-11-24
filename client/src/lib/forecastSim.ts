import { MONTE_CARLO_RUNS } from './forecastConfig.ts';
import { amortizeYear } from './mortgage.ts';
import { federalTax, irmaaTier, payrollTax, bracketTop, type TaxIncome, type TaxHousehold } from './taxCalc.ts';
import { taxParamsFor, irmaaTiersFor, IRMAA_LOOKBACK_YEARS, type FilingStatus, type YearTaxParams, type IrmaaTier } from './taxTables.ts';
import { stepWithdrawalRule, initialRuleState, type WithdrawalRule } from './withdrawalRules.ts';
import { HISTORICAL_RETURNS, type HistoricalYear } from './historicalReturns.ts';

// Pure Monte Carlo retirement projection extracted from pages/Forecast.tsx so it
// can be unit-tested in isolation. Given a year's deterministic flows and random
// investment returns, it simulates many futures and returns percentile bands plus
// the share of runs that stay solvent. No React, no DOM, no I/O.

// Deterministic PRNG so the Monte Carlo is reproducible: the same inputs always
// yield the same bands/success %. Without this, every recompute (e.g. a tab
// switch re-rendering the page) would redraw fresh randoms and the headline
// numbers would visibly wiggle.
export function mulberry32(seed: number) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Standard normal via Box–Muller, drawn from the supplied uniform PRNG.
export function randn(rand: () => number) { let u = 0, v = 0; while (!u) u = rand(); while (!v) v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
export function pctile(sorted: number[], p: number) { return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))]; }
// IRS Uniform Lifetime Table (2022+) distribution periods, ages 72–120. The RMD is
// the pre-tax balance divided by the divisor for the owner's age; 120+ stays at 2.0.
const RMD_DIVISORS: Record<number, number> = {
  72: 27.4, 73: 26.5, 74: 25.5, 75: 24.6, 76: 23.7, 77: 22.9, 78: 22.0, 79: 21.1, 80: 20.2,
  81: 19.4, 82: 18.5, 83: 17.7, 84: 16.8, 85: 16.0, 86: 15.2, 87: 14.4, 88: 13.7, 89: 12.9,
  90: 12.2, 91: 11.5, 92: 10.8, 93: 10.1, 94: 9.5, 95: 8.9, 96: 8.4, 97: 7.8, 98: 7.3, 99: 6.8,
  100: 6.4, 101: 6.0, 102: 5.6, 103: 5.2, 104: 4.9, 105: 4.6, 106: 4.3, 107: 4.1, 108: 3.9,
  109: 3.7, 110: 3.5, 111: 3.4, 112: 3.3, 113: 3.1, 114: 3.0, 115: 2.9, 116: 2.8, 117: 2.7,
  118: 2.5, 119: 2.3, 120: 2.0,
};
// Fraction of the pre-tax balance that must be withdrawn at `age`. Kicks in at 73.
export function rmdFactor(age: number) {
  if (age < 73) return 0;
  return 1 / (RMD_DIVISORS[Math.min(120, Math.floor(age))] ?? 2.0);
}

// Seed for Monte Carlo run `s`. Hashing the run index (murmur3 finalizer) gives each
// run an independent stream: mulberry32 advances its state by a constant per draw, so
// seeds that differ by a multiple of that constant (e.g. seed + s*0x6d2b79f5) would be
// shifted copies of ONE stream and the runs would be correlated. A per-run stream also
// means run s's draws don't shift when the horizon (draws per run) changes.
export function runSeed(s: number) {
  let h = (0x9e3779b9 ^ Math.imul(s + 1, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

// One year's wage, employer-match and Social Security flows, shared by the forward
// projection and the back-projection so they can't drift. `i` is the year offset from
// today (negative in the past) and `f` the inflation factor for it.
//   - % income events compound on earner 0's base; $ events adjust earner 0's wage by a
//     dollar amount that grows with earner 0's own raise (so a "−60k part time" stays
//     proportional to the wage it adjusts). Earner 0's wage floors at 0.
//   - contribShare: the fraction of base income (all enabled earners, each at its own
//     raise) still being earned this year. Contributions scale by it, so they taper
//     when one earner retires while the other works. Falls back to on/off when there
//     is no base income at all (contributions set but incomes 0).
//   - employerN: each earner's match stops when THAT earner stops working.
//   - wageScale (historical backtest only, else 1): multiplies wages and the match so
//     pay keeps the same buying-power path as in the plan when the replayed years'
//     inflation differs from the plan's (see makeYears in runForecastSim).
function earnerFlowsAt(earners: SimEarner[], events: SimEvent[], age0: number, i: number, f: number, wageScale = 1) {
  const incomeEvents = events.filter(e => e.type === 'income' && e.age <= age0);
  const pctMult = incomeEvents.filter(e => e.isPct).reduce((m, e) => m * (1 + e.amount / 100), 1);
  const dollarRaises = incomeEvents.filter(e => !e.isPct).reduce((t, e) => t + e.amount, 0);

  let grossN = 0, ssN = 0, employerN = 0, anyWorking = false, workingBase = 0, totalBase = 0;
  const wages: number[] = []; // each working earner's gross wage (payroll tax is per earner)
  earners.forEach((e, idx) => {
    const on = idx === 0 ? true : e.enabled;
    if (!on) return;
    const eAge = e.currentAge + i;
    // Income grows at its OWN raise rate, independent of inflation — for
    // fields without cost-of-living adjustments, wages can lag prices. (Spending
    // still inflates, so real take-home erodes unless the raise keeps up.)
    const raise = Math.pow(1 + (e.raisePct ?? 0.02), i);
    totalBase += e.income * raise;
    if (eAge < e.retireAge) {
      const w = (idx === 0 ? Math.max(0, e.income * raise * pctMult + dollarRaises * raise) : e.income * raise) * wageScale;
      grossN += w;
      wages.push(w);
      workingBase += e.income * raise;
      // Employer match: free money into pre-tax while this earner works. Not
      // cash income, not a deduction — added to the pool by the caller, outside `net`.
      employerN += (e.employerMatch ?? 0) * raise * wageScale;
      anyWorking = true;
    }
    // Social Security keeps its inflation COLA.
    if (e.ssEnabled && eAge >= e.ssClaimAge) ssN += e.ssAnnual * f;
  });
  const contribShare = totalBase > 0 ? Math.min(1, workingBase / totalBase) : (anyWorking ? 1 : 0);
  return { grossN, ssN, employerN, anyWorking, contribShare, wages };
}

// Equity glide path (opt-in). Equity exposure falls linearly from
// GLIDE_EQUITY_START (today) to GLIDE_EQUITY_END by the primary earner's
// retirement, then holds. The remaining sleeve earns a modest bond return
// (inflation + GLIDE_BOND_REAL) at ~zero modeled volatility, so both the mean
// return and the spread shrink as retirement approaches.
export const GLIDE_EQUITY_START = 0.9;
export const GLIDE_EQUITY_END = 0.5;
const GLIDE_BOND_REAL = 0.01;

export interface Pools { taxable: number; pretax: number; roth: number; hsa: number; college: number }

// Only the assumption fields the simulation reads (structural — the page's larger
// Assumptions object is assignable to this).
export interface SimAssumptions {
  endAge: number;
  annualSpending: number;
  eduInflation: number;
  collegeStartAge: number; collegeYears: number; collegeCostPerYear: number;
  gradStartAge: number; gradYears: number; gradCostPerYear: number; gradCoverage: number;
  effTaxRate: number;
  investReturn: number; volatility: number;
  realEstateGrowth: number;
  retireTaxRate: number;
}
export interface SimEvent { type: string; age: number; amount: number; untilAge?: number; everyYears?: number; isPct?: boolean; isSale?: boolean }
// isSale (one-time events only): the amount is a one-off cash inflow (a sale /
// windfall — e.g. a business sale) rather than a one-off cost.

// Explicit real-estate model. When provided, each property's value appreciates while
// its mortgage amortizes down (equity = value − balance), and the housing cash outflow
// (P&I until payoff, plus tax/insurance/HOA growing at their own rates) is charged
// each year. Omit it to keep the legacy behavior: grow `baseRE` (equity) at
// `realEstateGrowth` with no housing outflow.
//   sellable — this property's equity may be drawn as a last resort in retirement
//   (downsize / reverse mortgage). Equity from non-sellable properties stays in net
//   worth but can never cover a shortfall.
export interface SimProperty { value: number; balance: number; ratePct: number; monthlyPI: number; sellable: boolean }
export interface SimRealEstate {
  properties: SimProperty[];
  propertyTaxAnnual: number; insuranceAnnual: number; hoaAnnual: number; // today's $/yr (aggregate)
  rentalIncomeAnnual: number;                                            // income generated, e.g. rent
  taxGrowth: number; insuranceGrowth: number; hoaGrowth: number;          // annual growth rates
  rentalGrowth: number;
}
export interface SimEarner {
  enabled?: boolean; currentAge: number; income: number; retireAge: number;
  raisePct?: number; ssEnabled?: boolean; ssClaimAge: number; ssAnnual: number;
  // Employer 401(k)/403(b) match or profit-sharing, today's $/yr. Lands
  // straight in the pre-tax pool while this earner works: it is NOT the
  // employee's cash (never charged against household income) and NOT their tax
  // deduction. Grows with the earner's raise, like the salary it's a % of.
  // (Named employerMatch, not `employer` — old persisted page state carries a
  // stale never-editable `employer` default that must not start counting.)
  employerMatch?: number;
}

export interface SimInput {
  A: SimAssumptions;
  currentAge0: number;
  infl: number;
  costPerKid: number;
  kidIndependentAge: number;
  kidAges: number[];
  events: SimEvent[];
  earners: SimEarner[];
  pools0: Pools;
  contribByBucket: Pools;
  baseRE: number;
  // Manual assets/liabilities carrying a fixed annual rate (fraction, e.g. 0.045).
  // Held out of the volatile investment pools and grown steadily at each entry's
  // own rate; a negative value is a liability whose balance compounds. Positive
  // entries are spendable — they can fund retirement shortfalls (cash/bonds/CDs).
  // Omit or leave empty for none (unchanged behavior).
  manualAssets?: { value: number; rate: number }[];
  hsaLast: boolean;
  collegeOn: boolean;
  gradOn: boolean;
  spendingAdjust: number;
  realEstate?: SimRealEstate; // explicit home value + mortgage + carrying costs (see above)
  tapHomeEquity?: boolean; // draw home equity as a last resort once liquid pools are exhausted (retirement only)
  glidePath?: boolean;     // de-risk: glide equity exposure down with age, scaling both return and volatility
  tax?: SimTaxSettings;    // omit (or mode 'flat') for the flat effective rates — the original model
  // Return model (see "Historical backtest" below). Omit for 'montecarlo', the original.
  returnModel?: 'montecarlo' | 'historical';
  historicalStockShare?: number;              // historical mode, glide path off: share in stocks (default 1)
  historicalStarts?: number[];                // historical mode: run only these starting years (chunked runs)
  historicalData?: readonly HistoricalYear[]; // historical mode: the series (default HISTORICAL_RETURNS; tests inject)
  // Retirement spending rule (withdrawalRules.ts). Omit or kind 'fixed' for the original.
  withdrawal?: WithdrawalRule;
  // Solver-only switches (lib/forecastSolve.ts); all omitted on the page's own sims.
  //   coast: no new saving from today — per-account contributions and the employer
  //     match stop, and pay left over after spending while anyone still works is
  //     spent rather than invested. Wages still cover that year's costs. One-off
  //     sale proceeds and rent received in those years are not pay: they are kept.
  //   seedOffset: shifts the Monte Carlo seeds (run s uses runSeed(s + seedOffset)),
  //     to measure how much a success reading moves with a different set of draws.
  //   exactSuccess: also return the unrounded success share (SimResult.successRate).
  coast?: boolean;
  seedOffset?: number;
  exactSuccess?: boolean;
  runs?: number;       // defaults to MONTE_CARLO_RUNS
  yearNow?: number;    // defaults to the current calendar year (only labels the bands)
  startAge?: number;   // first age plotted; < currentAge0 adds a modeled back-projection (see backcastHistory)
}

// --- Bracket tax model (opt-in) ---------------------------------------------
// With mode 'brackets' each simulated year's tax comes from taxCalc.ts instead of
// the flat effective rates (effTaxRate / retireTaxRate, which are then unused):
//   - federal income tax on wages less pre-tax 401(k)/HSA contributions, the
//     taxable share of Social Security, pre-tax withdrawals and required
//     distributions, Roth conversions, and realised gains on taxable-account
//     withdrawals (TAXABLE_GAIN_SHARE of each dollar withdrawn is assumed gain);
//   - employee payroll tax on wages; a flat state rate on federal taxable income
//     excluding Social Security; the 10% penalty on pre-tax draws before 60;
//   - Medicare income surcharges (IRMAA) for each household member 65+, priced
//     from the MAGI two years earlier (none in the first two plan years, which
//     have no modelled look-back income).
// Withdrawals are grossed up so spending is still met after tax. Interest and
// dividends earned inside the taxable account are not taxed year by year.
export const TAXABLE_GAIN_SHARE = 0.5;
export interface SimConversionSettings {
  // Earner 0's ages, inclusive. A null/absent start means "earner 0's retirement
  // age", resolved inside the run from input.earners — so a what-if retirement age
  // (the page's lever, the solver's shifts) moves the window with it. The end is
  // never before the start.
  startAge?: number | null; endAge: number;
  bracketRate: number;              // convert up to the top of this ordinary bracket (e.g. 0.22)
  irmaaCap: boolean;                // also stop before the next Medicare surcharge tier
}
export interface SimTaxSettings {
  mode: 'flat' | 'brackets';
  filing: FilingStatus;
  stateRate: number;                // flat state income-tax rate (fraction)
  conversions?: SimConversionSettings | null;
}
// One year of the bracket model on one simulated path (nominal dollars).
export interface SimTaxYear {
  age: number; year: number; status: FilingStatus;
  // The price level this record's amounts are stated at (what turns them into
  // today's dollars; see restateFlow). Always the plan's (1 + infl)^(age − currentAge0):
  // a replayed historical year is the plan's tax year scaled by that path's price
  // ratio (see makeYears), so its record is restated to plan dollars, where the
  // published tables (taxYearDetail) apply exactly.
  priceLevel: number;
  age65Count: number; medicareCount: number;
  irmaaWatch: boolean;  // someone is 63+, so this year's income sets Medicare premiums
  wages: number;        // taxable wages (after pre-tax contributions)
  grossWages: number[]; // each working earner's gross wage
  socialSecurity: number;
  rmd: number; pretaxDraw: number; conversion: number;
  gains: number;        // realised gains on taxable-account withdrawals
  fedTax: number;       // federal income tax incl. NIIT
  stateTax: number; payroll: number; penalty: number;
  irmaaCost: number;    // surcharges charged this year (from MAGI two years back)
  magi: number;
}
export interface SimTaxResult {
  // Year-by-year detail of the run whose ending net worth is the median.
  medianPath: SimTaxYear[];
  // Median across runs of lifetime federal income tax: nominal, and with each
  // year deflated to today's dollars. In the historical backtest the nominal sum
  // restates each year at the PLAN's inflation, like the bands.
  lifetimeFedTax: number; lifetimeFedTaxReal: number;
  // Historical backtest only: the starting year the median path replays.
  medianStartYear?: number;
}

// Per-year precomputed inputs of the bracket model (see runForecastSim).
interface BracketYear {
  year: number; tp: YearTaxParams; hh: TaxHousehold;
  // Historical backtest: the year's price level relative to the plan's (1 in Monte
  // Carlo). `tp` is already scaled by it; IRMAA tiers stay in plan dollars and are
  // compared with MAGI ÷ k, and records are stored ÷ k (plan dollars).
  k: number; planF: number;
  medicareCount: number; irmaaWatch: boolean;
  irmaaNow: IrmaaTier[]; irmaaAhead: IrmaaTier[];
  grossWages: number[]; taxWages: number; payroll: number; netPre: number; penaltyRate: number;
}

export interface SimBand {
  age: number; year: number;
  p10: number; p50: number; band: number;
  invP10: number; invP50: number; invBand: number;
  re: number; income: number; spending: number;
}
// --- Historical backtest (opt-in) --------------------------------------------
// With returnModel 'historical' the runs are not random: there is one per starting
// year S with a complete run of history for the plan's horizon (S … S + years − 1
// all inside the data). Plan year i earns year S + i's actual returns, mixed
// through the glide path (equity share in S&P 500 total return, the rest in
// 10-year Treasuries; with the glide path off, `historicalStockShare` in stocks),
// and prices that year's flows with the actual inflation through the END of that
// year, less one year of plan inflation (see makeYears), so real spending keeps
// the Monte Carlo timing whatever the replayed inflation was. The tax tables follow
// the same price level. Each path's balances are then restated at the PLAN's inflation, so its bands
// deflate to today's dollars exactly as Monte Carlo bands do. If no starting year
// fits, the Monte Carlo runs instead and `historical.fallback` is set; nothing
// loops or wraps the data.
//
// Per path (when historical mode or a non-fixed spending rule is on):
export interface SimPathStat {
  ranOutAge: number | null;      // age in the year money first ran short; null = lasted
  deepestCut: number;            // largest cut to flexible spending while solvent (0.15 = 15%; 0 = never cut)
  lowestSpendReal: number | null; // lowest flexible spending in a retired year, today's $ (null = never retired in the plan)
  endInvReal: number;            // investable savings at the plan's end, today's $
  endNWReal: number;             // net worth at the plan's end, today's $
}
export interface SimHistoricalStart extends SimPathStat { startYear: number }
export interface SimHistorical {
  horizonYears: number;
  starts: SimHistoricalStart[];     // the starting years run (all complete ones, or `historicalStarts`)
  completeStarts: number[];         // every starting year with a complete run of data
  fallback: boolean;                // true → no starting year fits; the bands are Monte Carlo
}
export interface SimResult {
  bands: SimBand[]; successPct: number; tax?: SimTaxResult;
  successRate?: number;             // unrounded share of solvent runs (0–1); only with exactSuccess
  paths?: SimPathStat[];            // per run (see SimPathStat); absent with the default settings
  historical?: SimHistorical;       // historical mode only
}

// Every dollar amount of a year's tax tables scaled by `k` (historical backtest: the
// replayed price level over the plan's). Scaling them all — the amounts the law
// holds fixed too — makes a replayed tax year exactly the plan's year in k-times
// dollars: tax(k·income; k·tables) = k·tax(income; tables), so real tax does not
// creep with the replayed inflation and the page can rebuild a year from the
// published tables in plan dollars.
function scaleTaxParams(tp: YearTaxParams, k: number): YearTaxParams {
  if (k === 1) return tp;
  return {
    ...tp, growth: tp.growth * k,
    brackets: tp.brackets.map(b => ({ ...b, from: b.from * k })),
    standardDeduction: tp.standardDeduction * k, additional65: tp.additional65 * k,
    ltcgZeroMax: tp.ltcgZeroMax * k, ltcgFifteenMax: tp.ltcgFifteenMax * k,
    niitThreshold: tp.niitThreshold * k, ssBase: tp.ssBase * k, ssSecond: tp.ssSecond * k,
    senior: tp.senior ? { ...tp.senior, perPerson: tp.senior.perPerson * k, phaseOutStart: tp.senior.phaseOutStart * k } : null,
    payroll: { ...tp.payroll, wageBase: tp.payroll.wageBase * k, addlThreshold: tp.payroll.addlThreshold * k },
  };
}

// Starting years with a complete run of `horizonYears` years of data, oldest first.
export function completeHistoricalStarts(horizonYears: number, data: readonly HistoricalYear[] = HISTORICAL_RETURNS): number[] {
  if (!data.length || !(horizonYears >= 1)) return [];
  // Every year S … S + horizon − 1 must be present (a gap in the series disqualifies
  // the starts that would span it).
  const have = new Set(data.map(h => h.year));
  const first = Math.min(...have), last = Math.max(...have);
  const out: number[] = [];
  for (let y = first; y + horizonYears - 1 <= last; y++) {
    let ok = true;
    for (let k = 0; k < horizonYears && ok; k++) ok = have.has(y + k);
    if (ok) out.push(y);
  }
  return out;
}

export function runForecastSim(input: SimInput): SimResult {
  const {
    A, currentAge0, infl, costPerKid, kidIndependentAge,
    kidAges, events, earners, pools0, contribByBucket, baseRE,
    hsaLast, collegeOn, gradOn, spendingAdjust,
  } = input;
  const tapHomeEquity = input.tapHomeEquity ?? false;
  const glidePath = input.glidePath ?? false;
  const RUNS = input.runs ?? MONTE_CARLO_RUNS;
  const yearNow = input.yearNow ?? new Date().getFullYear();
  const coast = input.coast ?? false;
  const seedOffset = Number.isFinite(input.seedOffset) ? Math.floor(input.seedOffset as number) : 0;

  const years = Math.max(1, A.endAge - currentAge0 + 1);

  // Bracket tax model settings (null → the original flat-rate model, untouched).
  const taxIn = input.tax && input.tax.mode === 'brackets' ? input.tax : null;
  const stateRate = taxIn && Number.isFinite(taxIn.stateRate) ? Math.min(1, Math.max(0, taxIn.stateRate)) : 0;
  // Conversion window, with a blank start resolved to earner 0's retirement age in
  // THIS input (so levers and solver shifts move it) and the end kept ≥ the start.
  const conv = (() => {
    const c = taxIn?.conversions;
    if (!c) return null;
    const startAge = c.startAge ?? earners[0]?.retireAge ?? currentAge0;
    return { ...c, startAge, endAge: Math.max(startAge, c.endAge) };
  })();

  // Per-year equity exposure for the glide path (1 = fully invested when off).
  const glideToAge = earners[0]?.retireAge ?? A.endAge;
  const equityFracAt = (age0: number) => {
    if (!glidePath) return 1;
    if (glideToAge <= currentAge0 || age0 >= glideToAge) return GLIDE_EQUITY_END;
    if (age0 <= currentAge0) return GLIDE_EQUITY_START;
    const t = (age0 - currentAge0) / (glideToAge - currentAge0);
    return GLIDE_EQUITY_START + t * (GLIDE_EQUITY_END - GLIDE_EQUITY_START);
  };
  const bondReturn = infl + GLIDE_BOND_REAL;
  // Existing kids' costs are already baked into observed spending, so we only
  // model the *drop* as each ages out (empty-nest). Future "have a kid" events
  // instead *add* the per-kid cost while the child is dependent.
  const kidDrop = (i: number) => kidAges.reduce((s, k) => s + (k < kidIndependentAge && k + i >= kidIndependentAge ? costPerKid : 0), 0);
  const recurringAt = (age0: number) => events.filter(e => e.type === 'recurring' && age0 >= e.age && age0 <= (e.untilAge ?? A.endAge)).reduce((t, e) => t + e.amount, 0);
  // Repeat purchases: hit every `everyYears` from `age` to `untilAge` (e.g. a car).
  const repeatAt = (age0: number) => events.filter(e => e.type === 'recurringEvery' && (e.everyYears ?? 0) > 0
    && age0 >= e.age && age0 <= (e.untilAge ?? A.endAge) && (age0 - e.age) % (e.everyYears as number) === 0)
    .reduce((t, e) => t + e.amount, 0);
  // One-off costs / big purchases land in the single year they occur. Sales
  // (isSale) are one-off cash inflows (a windfall) rather than costs.
  const oneTimeAt = (age0: number) => events.filter(e => e.type === 'oneTime' && !e.isSale && e.age === age0).reduce((t, e) => t + e.amount, 0);
  const oneTimeSaleAt = (age0: number) => events.filter(e => e.type === 'oneTime' && e.isSale && e.age === age0).reduce((t, e) => t + e.amount, 0);
  // A future kid's current age in projection year i (negative until born).
  const futureKidAgeAt = (e: SimEvent, i: number) => (currentAge0 + i) - e.age;

  // --- Real-estate projection (deterministic) --------------------------------
  // When an explicit model is supplied, the home value appreciates while each
  // mortgage amortizes down; equity = value − Σbalance. The housing cash outflow
  // (P&I until payoff + carrying costs) is charged below as part of `net`. Without
  // it, reYears stays null and the legacy baseRE-growth path is used.
  const reIn = input.realEstate;
  const reYears = reIn ? (() => {
    let balances = reIn.properties.map(p => p.balance);
    return Array.from({ length: years }, (_, i) => {
      let equity = 0, sellableEquity = 0, pAndI = 0;
      balances = balances.map((bal, pi) => {
        const p = reIn.properties[pi];
        const value = p.value * Math.pow(1 + A.realEstateGrowth, i + 1); // end-of-year value
        const r = amortizeYear(bal, p.ratePct, p.monthlyPI);
        pAndI += r.interest + r.principal; // actual cash paid (0 once paid off)
        const eq = Math.max(0, value - r.endBalance);
        equity += eq;
        if (p.sellable) sellableEquity += eq; // only opted-in properties can cover shortfalls
        return r.endBalance;
      });
      const carry = reIn.propertyTaxAnnual * Math.pow(1 + reIn.taxGrowth, i)
        + reIn.insuranceAnnual * Math.pow(1 + reIn.insuranceGrowth, i)
        + reIn.hoaAnnual * Math.pow(1 + reIn.hoaGrowth, i);
      const rentalIncome = reIn.rentalIncomeAnnual * Math.pow(1 + reIn.rentalGrowth, i);
      return { equity, sellableEquity, outflow: pAndI + carry, rentalIncome };
    });
  })() : null;

  // --- Manual assets/liabilities (deterministic, fixed-rate) -----------------
  // Each entry compounds at its own rate, independent of the market. We precompute
  // two end-of-year trajectories (no drawdown baked in): the net signed value
  // (assets − liabilities), which feeds net worth, and the spendable ceiling
  // (positive entries only), which a retiree can draw against. Drawdowns are
  // tracked per-run as a cumulative tap, mirroring the real-estate model.
  const manual = input.manualAssets ?? [];
  const manualNetByYear = Array.from({ length: years }, (_, i) =>
    manual.reduce((t, m) => t + m.value * Math.pow(1 + m.rate, i + 1), 0));
  const manualSpendableByYear = Array.from({ length: years }, (_, i) =>
    manual.reduce((t, m) => t + (m.value > 0 ? m.value * Math.pow(1 + m.rate, i + 1) : 0), 0));

  // Flexible spending (what a spending rule may trim or raise): the everyday
  // spending less the cost of kids who are dependent today — kids, college,
  // housing and life events are never cut.
  const kidsDependentNow = kidAges.filter(k => k < kidIndependentAge).length;
  const flexBase = Math.max(0, A.annualSpending * spendingAdjust - costPerKid * kidsDependentNow);

  // --- Deterministic per-year flows (today's $ → nominal via inflation) ------
  // Income, contributions, taxes, spending and education are all deterministic;
  // only investment growth (and thus solvency) is random. Precompute once.
  // `hist` (historical backtest only): F[i] = the replayed years' cumulative
  // inflation before plan year i. A year's flows are paid after its growth, and
  // its end balance is deflated by F[i + 1], so a flow priced at f costs f / F[i + 1]
  // in real terms. Monte Carlo prices at (1 + infl)^i and so charges
  // 1 / (1 + infl) of a year's real spending; pricing a replayed year at
  // F[i + 1] / (1 + infl) charges the same, whatever that year's actual inflation
  // (pricing at F[i] made spending cheaper in exactly the high-inflation years).
  // Equal to (1 + infl)^i when every replayed year had the plan's inflation.
  // Wages are scaled by f / (1 + infl)^i so they keep the plan's buying-power path,
  // college keeps its premium over general inflation, and the tax tables are scaled
  // by the same ratio (scaleTaxParams). Home values, carrying costs and fixed-rate
  // assets still follow the plan's own rates.
  const makeYears = (hist: { F: number[] } | null) => Array.from({ length: years }, (_, i) => {
    const planF = Math.pow(1 + infl, i);
    const f = hist ? hist.F[i + 1] / Math.max(1e-9, 1 + infl) : planF; // general inflation
    const k = hist && planF > 0 ? f / planF : 1; // this path's price level over the plan's
    const age0 = currentAge0 + i;
    const flows = hist
      ? earnerFlowsAt(earners, events, age0, i, f, k)
      : earnerFlowsAt(earners, events, age0, i, f);
    const { grossN, ssN, anyWorking, contribShare, wages } = flows;
    const employerN = coast ? 0 : flows.employerN; // coast: the match stops too

    // Per-account contributions (today's $ → nominal), scaled by the share of base
    // income still being earned (0 once nobody works). Coast: none.
    const cf = coast ? 0 : f * contribShare;
    let preN = contribByBucket.pretax * cf, rothN = contribByBucket.roth * cf, hsaN = contribByBucket.hsa * cf,
      c529N = contribByBucket.college * cf, taxN = contribByBucket.taxable * cf;
    // Can't contribute more than you earn.
    const totalContrib = preN + rothN + hsaN + c529N + taxN;
    if (grossN <= 0) { preN = rothN = hsaN = c529N = taxN = 0; }
    else if (totalContrib > grossN) { const sc = grossN / totalContrib; preN *= sc; rothN *= sc; hsaN *= sc; c529N *= sc; taxN *= sc; }

    // Added cost of future kids while they're dependent (not in baseline spending).
    const futureKidCost = events.filter(e => e.type === 'kid').reduce((s, e) => {
      const a = futureKidAgeAt(e, i); return s + (a >= 0 && a < kidIndependentAge ? costPerKid : 0);
    }, 0);
    const spendN = (Math.max(0, A.annualSpending * spendingAdjust - kidDrop(i)) + futureKidCost + recurringAt(age0)) * f;
    const oneTimeN = (oneTimeAt(age0) + repeatAt(age0)) * f;
    // One-off cash inflows (asset/business sales). Treated as after-tax proceeds.
    const windfallN = oneTimeSaleAt(age0) * f;

    // Education for every child — current kids plus future-kid events.
    const kidAgesNow = [...kidAges.map(k => k + i), ...events.filter(e => e.type === 'kid').map(e => futureKidAgeAt(e, i))];
    let eduReal = 0;
    for (const a of kidAgesNow) {
      if (collegeOn && a >= A.collegeStartAge && a < A.collegeStartAge + A.collegeYears) eduReal += A.collegeCostPerYear;
      if (gradOn && a >= A.gradStartAge && a < A.gradStartAge + A.gradYears) eduReal += A.gradCostPerYear * A.gradCoverage;
    }
    const collegeNom = hist
      ? eduReal * f * Math.pow((1 + A.eduInflation) / Math.max(1e-9, 1 + infl), i)
      : eduReal * Math.pow(1 + A.eduInflation, i);
    // This year's planned flexible spending (nominal), ≤ the base spending line.
    const flexN = Math.min(Math.max(0, A.annualSpending * spendingAdjust - kidDrop(i)), flexBase) * f;

    // Pre-tax & HSA contributions are deductible; Roth/taxable/529 come from take-home.
    // Once nobody is working, the only income is Social Security — tax it at the
    // (lower) retirement rate rather than the working effective rate.
    const taxableIncome = Math.max(0, grossN - preN - hsaN + 0.85 * ssN);
    const tax = (anyWorking ? A.effTaxRate : A.retireTaxRate) * taxableIncome;
    // Housing cash outflow (mortgage P&I until payoff + tax/insurance/HOA). Nominal
    // already (P&I is fixed; carrying costs grow at their own rates), so it isn't
    // multiplied by `f`. Mortgage P&I is safe to charge here because the budget
    // excludes it from seeded spending.
    const housingOutflow = reYears ? reYears[i].outflow : 0;
    const housingIncome = reYears ? reYears[i].rentalIncome : 0; // rent, treated as cash income
    const net = grossN + ssN + windfallN + housingIncome - tax - (preN + hsaN + rothN + c529N + taxN) - spendN - oneTimeN - housingOutflow;

    // Bracket model: the year's deterministic tax inputs. Income tax itself is
    // settled inside each run, once that run's withdrawals are known; payroll tax
    // depends only on wages, so it is taken here.
    let bx: BracketYear | null = null;
    if (taxIn) {
      const year = yearNow + i;
      const tp = scaleTaxParams(taxParamsFor(year, taxIn.filing, infl), k);
      // Household members (earner 0 always, earner 1 when enabled) and their ages this year.
      const ages = earners.filter((e, idx) => idx === 0 || e.enabled).map(e => e.currentAge + i);
      const n65 = ages.filter(a => a >= 65).length;
      // Payroll tax: HSA contributions (made through payroll, a cafeteria plan) are
      // free of Social Security and Medicare tax, unlike 401(k) deferrals; each
      // working earner's wage carries its share of them.
      const ficaWages = hsaN > 0 && grossN > 0 ? wages.map(w => Math.max(0, w - hsaN * (w / grossN))) : wages;
      const payroll = payrollTax(ficaWages, tp);
      bx = {
        year, tp, k, planF,
        // One return: a single filer has at most one 65+ person on it.
        hh: { status: taxIn.filing, age65Count: Math.min(n65, taxIn.filing === 'joint' ? 2 : 1) },
        medicareCount: n65,
        // Income at 63+ sets Medicare premiums from 65 (two-year look-back).
        irmaaWatch: ages.some(a => a + IRMAA_LOOKBACK_YEARS >= 65),
        irmaaNow: irmaaTiersFor(year, taxIn.filing, infl),
        irmaaAhead: irmaaTiersFor(year + IRMAA_LOOKBACK_YEARS, taxIn.filing, infl),
        grossWages: wages,
        taxWages: Math.max(0, grossN - preN - hsaN),
        payroll,
        // The year's cash flow before income tax (the flat `net` without its tax, less payroll tax).
        netPre: grossN + ssN + windfallN + housingIncome - payroll - (preN + hsaN + rothN + c529N + taxN) - spendN - oneTimeN - housingOutflow,
        penaltyRate: age0 < 60 ? 0.10 : 0,
      };
    }
    return { bx, f, age0, net, anyWorking, pretaxAdd: preN, employerAdd: employerN, rothAdd: rothN, hsaAdd: hsaN, c529Add: c529N, taxableAdd: taxN, collegeNom, oneTimeN, windfallN, grossN, ssN, spendN, flexN, housingOutflow, housingIncome };
  });
  const yr = makeYears(null);

  // --- One simulated path -----------------------------------------------------
  // Shared by the Monte Carlo runs and the historical backtest. `yrs` holds the
  // path's deterministic flows, `nextReturn` the year's portfolio return (called
  // exactly once per year, in order), `balDefl(i)` the inflation factor that turns
  // the end of plan year i into today's dollars, and `toPlan(i)` (historical only)
  // restates that year's balances at the plan's inflation for the bands.
  type YearFlows = ReturnType<typeof makeYears>[number];
  const rule = input.withdrawal && input.withdrawal.kind !== 'fixed' ? input.withdrawal : null;
  const runPath = (yrs: YearFlows[], nextReturn: (age0: number) => number, balDefl: (i: number) => number, toPlan: ((i: number) => number) | null) => {
    let taxable = pools0.taxable, pretax = pools0.pretax, roth = pools0.roth, hsa = pools0.hsa, c529 = pools0.college;
    // Legacy path grows `re` each year from baseRE; modeled path reads deterministic
    // equity from reYears and tracks a per-run cumulative tap (last-resort drawdown).
    let re = baseRE, tappedCum = 0, manualTapped = 0, solvent = true;
    const magiHist: number[] = [], recs: SimTaxYear[] = [];
    let lifeN = 0, lifeR = 0;
    const nwRow: number[] = [], invRow: number[] = [];
    // Spending-rule memory and the path's statistics (SimPathStat).
    let ruleState = initialRuleState();
    let ranOutAge: number | null = null, minFactor = 1, lowestSpendReal: number | null = null, endInv = 0, endNW = 0;
    for (let i = 0; i < years; i++) {
      const d = yrs[i];
      const g = 1 + nextReturn(d.age0);
      taxable *= g; pretax *= g; roth *= g; hsa *= g; c529 *= g;
      let reEquity: number;
      if (reYears) reEquity = Math.max(0, reYears[i].equity - tappedCum);
      else { re *= (1 + A.realEstateGrowth); reEquity = re; }

      // Contributions in (each account's amount lands in its bucket). The
      // employer match rides along into pre-tax without touching `net`.
      pretax += d.pretaxAdd + d.employerAdd; roth += d.rothAdd; hsa += d.hsaAdd; c529 += d.c529Add; taxable += d.taxableAdd;

      // Retirement spending rule: once nobody works, the rule sets this year's
      // flexible spending from the savings on hand; `ruleDelta` is how much less
      // (or, if negative, more) than planned is spent. 0 with the default 'fixed'.
      let ruleDelta = 0;
      if (!d.anyWorking) {
        let spend = d.flexN;
        if (rule) {
          const savings = Math.max(0, taxable) + Math.max(0, pretax) + Math.max(0, roth) + Math.max(0, hsa)
            + Math.max(0, manualSpendableByYear[i] - manualTapped);
          const step = stepWithdrawalRule(rule, ruleState, d.flexN, savings);
          ruleState = step.state; spend = step.spend; ruleDelta = d.flexN - spend;
        }
        if (solvent) {
          if (d.flexN > 0) minFactor = Math.min(minFactor, spend / d.flexN);
          const real = spend / d.f; // flows are priced at the start of the year
          lowestSpendReal = lowestSpendReal == null ? real : Math.min(lowestSpendReal, real);
        }
      }
      const wasSolvent = solvent;

      if (!d.bx) {
        // Required Minimum Distributions out of pre-tax (forced, taxed, to taxable).
        if (d.age0 >= 73 && pretax > 0) { const rmd = pretax * rmdFactor(d.age0); pretax -= rmd; taxable += rmd * (1 - A.retireTaxRate); }

        // College: 529 first, then add the remainder to this year's cash need.
        let net = rule ? d.net + ruleDelta : d.net;
        if (d.collegeNom > 0) { const fromC529 = Math.min(c529, d.collegeNom); c529 -= fromC529; net -= (d.collegeNom - fromC529); }

        if (net >= 0) {
          // Coast: a working year's leftover PAY is spent, not invested. One-off
          // sale proceeds and rent are not pay, so they are still kept (up to the
          // year's surplus — they are counted first when the surplus is split).
          taxable += coast && d.anyWorking ? Math.min(net, d.windfallN + d.housingIncome) : net;
        } else {
          // Fund the shortfall in tax-efficient order. HSA reserved for last
          // (or moved up if "spend HSA last" is unchecked).
          let need = -net;
          const drawFlat = (bal: number) => { const t = Math.min(bal, need); need -= t; return bal - t; };
          const drawTaxed = (bal: number, rate: number) => { const grossNeed = need / (1 - rate); const t = Math.min(bal, grossNeed); need -= t * (1 - rate); return bal - t; };
          const penalty = d.age0 < 60 ? 0.10 : 0; // ~59½ early-withdrawal penalty
          // Cash-like manual assets (bonds/CDs/cash) come first — most liquid, untaxed.
          const manualAvail = Math.max(0, manualSpendableByYear[i] - manualTapped);
          if (manualAvail > 0) { const t = Math.min(manualAvail, need); need -= t; manualTapped += t; }
          taxable = drawFlat(taxable);
          if (!hsaLast && need > 0) hsa = drawFlat(hsa); // tax-free, used before pre-tax
          if (need > 0) pretax = drawTaxed(pretax, A.retireTaxRate + penalty);
          if (need > 0) roth = drawFlat(roth);
          if (hsaLast && need > 0) hsa = drawFlat(hsa);
          // Last resort: once every liquid account is drained, an opted-in retiree can
          // sell/tap real-estate equity (downsize / reverse mortgage — treated as untaxed
          // within the primary-residence exclusion) before the run is called insolvent.
          // Per property: only the equity of properties marked sellable is available
          // (legacy baseRE path uses the global tapHomeEquity flag instead).
          const sellable = reYears ? Math.max(0, reYears[i].sellableEquity - tappedCum) : (tapHomeEquity ? reEquity : 0);
          if (sellable > 0 && !d.anyWorking && need > 0) {
            const drawn = Math.min(sellable, need); need -= drawn; reEquity -= drawn;
            if (reYears) tappedCum += drawn; else re = reEquity; // persist the draw across years
          }
          if (need > 1e-6) solvent = false; // ran out of money this year
        }
      } else {
        // --- Bracket tax model (see SimTaxSettings) ---
        const bxy = d.bx, tp = bxy.tp, hh = bxy.hh;
        // Required distribution: the whole amount lands as cash; its tax is part
        // of this year's bill below.
        let rmd = 0;
        if (d.age0 >= 73 && pretax > 0) { rmd = pretax * rmdFactor(d.age0); pretax -= rmd; }
        let cash = rule ? bxy.netPre + rmd + ruleDelta : bxy.netPre + rmd;
        // College: 529 first, then the remainder is a cash need.
        if (d.collegeNom > 0) { const fromC529 = Math.min(c529, d.collegeNom); c529 -= fromC529; cash -= (d.collegeNom - fromC529); }
        // Medicare surcharges for members 65+, priced from MAGI two years back.
        let irmaaCost = 0;
        if (bxy.medicareCount > 0 && i >= IRMAA_LOOKBACK_YEARS) {
          // (MAGI is kept in plan dollars, like the tiers; the surcharge is paid in this year's.)
          irmaaCost = irmaaTier(magiHist[i - IRMAA_LOOKBACK_YEARS], bxy.irmaaNow).annualPerPerson * bxy.medicareCount * bxy.k;
          cash -= irmaaCost;
        }
        const inc: TaxIncome = { wages: bxy.taxWages, pretaxWithdrawals: rmd, conversions: 0, interest: 0, qualified: 0, socialSecurity: d.ssN };
        let pretaxDrawn = 0, gains = 0, paid = 0;
        // Everything owed on income `x`: federal (incl. NIIT), the flat state rate on
        // federal taxable income less taxable Social Security, and the early penalty.
        const owe = (x: TaxIncome, pd: number) => {
          const r = federalTax(x, hh, tp);
          const st = stateRate * Math.max(0, r.taxableIncome - r.taxableSocialSecurity);
          const pen = bxy.penaltyRate * pd;
          return { fed: r.total, state: st, pen, total: r.total + st + pen, magi: r.agi, ordinaryTaxable: r.ordinaryTaxable };
        };
        // Settle the year. Pay what is owed from the year's cash; when short, draw
        // in the same order as the flat model. A draw from pre-tax (ordinary income)
        // or taxable (part gain) raises the bill, so repeat until it stops moving —
        // a fixed point, reached quickly because each extra dollar of tax is less
        // than a dollar. This is the gross-up that keeps spending met after tax.
        for (let it = 0; it < 60; it++) {
          const o = owe(inc, pretaxDrawn);
          cash -= o.total - paid; paid = o.total;
          if (cash > -0.005) break;
          let need = -cash, fromTaxable = 0, fromPretax = 0;
          const take = (bal: number) => Math.min(Math.max(0, bal), need);
          const manualAvail = Math.max(0, manualSpendableByYear[i] - manualTapped);
          if (manualAvail > 0) { const t = Math.min(manualAvail, need); need -= t; manualTapped += t; }
          { const t = take(taxable); taxable -= t; need -= t; fromTaxable = t; }
          if (!hsaLast && need > 0) { const t = take(hsa); hsa -= t; need -= t; }
          if (need > 0) { const t = take(pretax); pretax -= t; need -= t; fromPretax = t; }
          if (need > 0) { const t = take(roth); roth -= t; need -= t; }
          if (hsaLast && need > 0) { const t = take(hsa); hsa -= t; need -= t; }
          // Last resort, as in the flat model: sellable home equity once retired.
          const sellable = reYears ? Math.max(0, reYears[i].sellableEquity - tappedCum) : (tapHomeEquity ? reEquity : 0);
          if (sellable > 0 && !d.anyWorking && need > 0) {
            const drawn = Math.min(sellable, need); need -= drawn; reEquity -= drawn;
            if (reYears) tappedCum += drawn; else re = reEquity;
          }
          cash = -need;
          gains += TAXABLE_GAIN_SHARE * fromTaxable; inc.qualified = gains;
          pretaxDrawn += fromPretax; inc.pretaxWithdrawals = rmd + pretaxDrawn;
          if (need > 1e-6) { solvent = false; break; } // ran out of money this year
        }
        // Coast: leftover pay is spent; sale proceeds, rent and a forced RMD are kept
        // (as in the flat branch above).
        if (cash > 0) taxable += coast && d.anyWorking ? Math.min(cash, d.windfallN + d.housingIncome + rmd) : cash;

        // Roth conversion (opt-in): move pre-tax to Roth up to the top of the chosen
        // bracket (and, optionally, the edge of the current Medicare surcharge tier),
        // paying its tax from the taxable account. The amount shrinks when that
        // account cannot cover the tax.
        let conversion = 0;
        if (conv && solvent && d.age0 >= conv.startAge && d.age0 <= conv.endAge && pretax > 1) {
          const top = bracketTop(tp.brackets, conv.bracketRate);
          const base = owe(inc, pretaxDrawn);
          let magiCap = Infinity;
          if (conv.irmaaCap && bxy.irmaaWatch) {
            const t = irmaaTier(base.magi / bxy.k, bxy.irmaaAhead);
            if (t.ceiling != null) magiCap = t.ceiling * bxy.k;
          }
          // Tax on converting X, paid from the taxable account. That withdrawal is
          // itself part gain, so settle the (fast-converging) loop on it too.
          const trial = (X: number) => {
            let w = 0, o = base;
            for (let k = 0; k < 40; k++) {
              o = owe({ ...inc, conversions: X, qualified: gains + TAXABLE_GAIN_SHARE * w }, pretaxDrawn);
              const wNew = Math.max(0, o.total - paid);
              const done = Math.abs(wNew - w) < 0.01;
              w = wNew;
              if (done) break;
            }
            return { w, o };
          };
          const fits = (X: number) => {
            const { w, o } = trial(X);
            return (top == null || o.ordinaryTaxable <= top + 0.01) && o.magi <= magiCap + 0.01 && w <= taxable + 0.01;
          };
          // Upper bound: each converted dollar raises MAGI by at least a dollar, and
          // ordinary taxable income by at least a dollar once the deduction is used.
          let hi = pretax;
          if (top != null) hi = Math.min(hi, Math.max(0, top - base.ordinaryTaxable) + tp.standardDeduction + 2 * tp.additional65 + 2 * (tp.senior?.perPerson ?? 0) + 1);
          if (Number.isFinite(magiCap)) hi = Math.min(hi, Math.max(0, magiCap - base.magi));
          const roomNow = (top == null || base.ordinaryTaxable < top) && base.magi < magiCap;
          let X = 0;
          if (roomNow && hi > 1) {
            if (fits(hi)) X = hi;
            else {
              let lo = 0;
              for (let k = 0; k < 60 && hi - lo > 1; k++) { const mid = (lo + hi) / 2; if (fits(mid)) lo = mid; else hi = mid; }
              X = lo;
            }
          }
          if (X > 1) {
            const { w } = trial(X);
            conversion = X; pretax -= X; roth += X;
            taxable = Math.max(0, taxable - w); paid += w;
            inc.conversions = X; gains += TAXABLE_GAIN_SHARE * w; inc.qualified = gains;
          }
        }

        const fin = owe(inc, pretaxDrawn);
        const k = bxy.k;
        magiHist[i] = fin.magi / k;
        // Flows are priced at the start of the year (f = (1+infl)^i, or F[i+1]/(1+infl)
        // in the backtest, whose nominal sum is restated at the plan's inflation).
        lifeN += toPlan ? fin.fed * Math.pow(1 + infl, i) / d.f : fin.fed;
        lifeR += fin.fed / d.f;
        // Stored in plan dollars (÷ k; exact no-op in Monte Carlo), see SimTaxYear.priceLevel.
        recs.push({
          age: d.age0, year: bxy.year, status: hh.status, priceLevel: bxy.planF, age65Count: hh.age65Count, medicareCount: bxy.medicareCount, irmaaWatch: bxy.irmaaWatch,
          wages: bxy.taxWages / k, grossWages: k === 1 ? bxy.grossWages : bxy.grossWages.map(w => w / k), socialSecurity: d.ssN / k,
          rmd: rmd / k, pretaxDraw: pretaxDrawn / k, conversion: conversion / k, gains: gains / k,
          fedTax: fin.fed / k, stateTax: fin.state / k, payroll: bxy.payroll / k, penalty: fin.pen / k, irmaaCost: irmaaCost / k, magi: fin.magi / k,
        });
      }

      // Manual sleeve: its net value (assets − liabilities) less what's been tapped.
      // Added raw — a net-liability position legitimately drags net worth negative.
      const manualNet = manualNetByYear[i] - manualTapped;
      const inv = Math.max(0, taxable) + Math.max(0, pretax) + Math.max(0, roth) + Math.max(0, hsa) + Math.max(0, c529) + manualNet;
      if (wasSolvent && !solvent) ranOutAge = d.age0;
      if (toPlan) { const k = toPlan(i); nwRow.push((inv + reEquity) * k); invRow.push(inv * k); }
      else { nwRow.push(inv + reEquity); invRow.push(inv); }
      if (i === years - 1) { endInv = inv; endNW = inv + reEquity; }
    }
    const dEnd = balDefl(years - 1);
    const stat: SimPathStat = {
      ranOutAge,
      // Rounded to 1e-12 so a single 10% trim reads as exactly 0.1 (1 − 0.9 is
      // 0.09999999999999998 in floating point) for the "10% or more" thresholds.
      deepestCut: Math.max(0, Math.round((1 - minFactor) * 1e12) / 1e12),
      lowestSpendReal,
      endInvReal: dEnd > 0 ? endInv / dEnd : 0,
      endNWReal: dEnd > 0 ? endNW / dEnd : 0,
    };
    return { solvent, nwRow, invRow, recs, lifeN, lifeR, stat };
  };

  // --- Runs: Monte Carlo draws, or one path per historical starting year -----
  const nw: number[][] = Array.from({ length: years }, () => []);
  const invv: number[][] = Array.from({ length: years }, () => []);
  let successCount = 0, runCount = 0;
  // Bracket model only: each run's year-by-year tax records and lifetime federal tax.
  const taxPaths: SimTaxYear[][] = [];
  const lifeNom: number[] = [], lifeReal: number[] = [];
  const stats: SimPathStat[] = [];
  const collect = (r: ReturnType<typeof runPath>) => {
    r.nwRow.forEach((v, i) => nw[i].push(v));
    r.invRow.forEach((v, i) => invv[i].push(v));
    if (r.solvent) successCount++;
    runCount++;
    if (taxIn) { taxPaths.push(r.recs); lifeNom.push(r.lifeN); lifeReal.push(r.lifeR); }
    stats.push(r.stat);
  };

  let historical: SimHistorical | undefined;
  if (input.returnModel === 'historical') {
    const data = input.historicalData ?? HISTORICAL_RETURNS;
    const byYear = new Map(data.map(h => [h.year, h]));
    const completeStarts = completeHistoricalStarts(years, data);
    const wanted = input.historicalStarts ? completeStarts.filter(y => input.historicalStarts!.includes(y)) : completeStarts;
    const share = Math.min(1, Math.max(0, Number.isFinite(input.historicalStockShare) ? input.historicalStockShare as number : 1));
    const starts: SimHistoricalStart[] = [];
    for (const S of wanted) {
      const h = Array.from({ length: years }, (_, i) => byYear.get(S + i) as HistoricalYear);
      // F[i]: cumulative actual inflation before plan year i (F[0] = 1).
      const F = [1];
      for (let i = 0; i < years; i++) F.push(F[i] * (1 + h[i].inflation));
      let i = 0;
      const nextReturn = (age0: number) => {
        const eq = glidePath ? equityFracAt(age0) : share;
        const y = h[i++];
        return eq * y.stocks + (1 - eq) * y.bonds;
      };
      const r = runPath(makeYears({ F }), nextReturn, k => F[k + 1],
        k => (F[k + 1] > 0 ? Math.pow(1 + infl, k + 1) / F[k + 1] : 0));
      collect(r);
      starts.push({ startYear: S, ...r.stat });
    }
    // No complete starting year at all → Monte Carlo instead (flagged). A caller that
    // asked for specific starts outside the complete set simply gets none run.
    historical = { horizonYears: years, starts, completeStarts, fallback: completeStarts.length === 0 };
  }
  if (!historical || historical.fallback) {
    for (let s = 0; s < RUNS; s++) {
      // Fixed per-run seed → reproducible draws that depend only on the inputs (see runSeed).
      const rand = mulberry32(runSeed(s + seedOffset));
      // Glide path (when off, eq = 1 → mean = investReturn, vol = volatility).
      const nextReturn = (age0: number) => {
        const eq = equityFracAt(age0);
        return (bondReturn + eq * (A.investReturn - bondReturn)) + (eq * A.volatility) * randn(rand);
      };
      collect(runPath(yr, nextReturn, k => Math.pow(1 + infl, k + 1), null));
    }
  }

  // (Zero runs only happens for a historical call restricted to starts that don't fit.)
  const pc = (sorted: number[], p: number) => (sorted.length ? pctile(sorted, p) : 0);
  const bands = nw.map((arr, i) => {
    const sNw = [...arr].sort((x, y) => x - y);
    const sInv = [...invv[i]].sort((x, y) => x - y);
    const p10 = pc(sNw, 0.1), p90 = pc(sNw, 0.9);
    const ip10 = pc(sInv, 0.1), ip90 = pc(sInv, 0.9);
    const d = yr[i];
    return {
      age: d.age0, year: yearNow + i,
      p10, p50: pc(sNw, 0.5), band: Math.max(0, p90 - p10),
      invP10: ip10, invP50: pc(sInv, 0.5), invBand: Math.max(0, ip90 - ip10),
      // Real estate grows deterministically, so it's the same across all runs.
      re: Math.round(reYears ? reYears[i].equity : baseRE * Math.pow(1 + A.realEstateGrowth, i + 1)),
      // Spending shown to the user includes the housing outflow so the line reflects
      // the true cash going out (the mortgage P&I drops at payoff).
      // Income includes one-off sale proceeds (a spike) and any rental income.
      income: Math.round(d.grossN + d.ssN + d.windfallN + d.housingIncome), spending: Math.round(d.spendN + d.collegeNom + d.oneTimeN + d.housingOutflow),
    };
  });
  const successPct = Math.round(successCount / Math.max(1, runCount) * 100);
  // Extra outputs only when their features are on, so the default result is unchanged.
  const extra: Pick<SimResult, 'paths' | 'historical' | 'successRate'> = {};
  if (input.exactSuccess) extra.successRate = runCount > 0 ? successCount / runCount : 0;
  if (historical || rule) extra.paths = stats;
  if (historical) extra.historical = historical;
  if (!taxIn) return { bands, successPct, ...extra };
  // The "median path": the run whose ending net worth is the median (same
  // percentile rule as the bands), so its tax years tell one coherent story.
  const last = nw[years - 1];
  const order = last.map((_, s) => s).sort((x, y) => last[x] - last[y]);
  const mid = order[Math.min(order.length - 1, Math.max(0, Math.floor(0.5 * (order.length - 1))))];
  const med = (arr: number[]) => (arr.length ? pctile([...arr].sort((x, y) => x - y), 0.5) : 0);
  const tax: SimTaxResult = { medianPath: taxPaths[mid] ?? [], lifetimeFedTax: med(lifeNom), lifetimeFedTaxReal: med(lifeReal) };
  // Runs are collected in starting-year order, so run `mid` replays starts[mid].
  if (historical && !historical.fallback && historical.starts[mid]) tax.medianStartYear = historical.starts[mid].startYear;
  return { bands, successPct, tax, ...extra };
}

// --- Reading the bands (END-of-year convention) ----------------------------
// A band labeled age X holds the balance at the END of the year spent at age X
// (after that year's growth and flows). That is `X − currentAge0 + 1` years from
// today; today's own balances are the end of age currentAge0 − 1 (0 years out).
// Flows (income / spending) are the year's cash flows, priced at the START of the
// year (inflation factor (1+infl)^(X − currentAge0)), so they sit one year less out.
export const balanceYearsOut = (bandAge: number, currentAge0: number) => bandAge - currentAge0 + 1;
export const flowYearsOut = (bandAge: number, currentAge0: number) => bandAge - currentAge0;

// Deflate a nominal value `yearsOut` years from today back to today's purchasing
// power at `infl` inflation. Pair with balanceYearsOut / flowYearsOut.
export const deflateReal = (v: number, yearsOut: number, infl: number) => v / Math.pow(1 + infl, yearsOut);

// A flow priced at a simulated path's own price level (e.g. SimTaxYear.priceLevel,
// `yearsOut` years from today, start of year) in the page's units: today's dollars
// divide by that price level; future dollars are restated at the PLAN's inflation
// (× (1 + infl)^yearsOut / priceLevel), the basis the bands use. In Monte Carlo the
// price level IS (1 + infl)^yearsOut, so this equals deflateReal (today's dollars)
// or the value itself (future dollars); only historical replays differ.
export function restateFlow(v: number, priceLevel: number, yearsOut: number, infl: number, realDollars: boolean): number {
  if (!(priceLevel > 0) || !Number.isFinite(priceLevel)) return realDollars ? deflateReal(v, yearsOut, infl) : v;
  if (realDollars) return v / priceLevel;
  const planF = Math.pow(1 + infl, yearsOut);
  return planF === priceLevel ? v : v * (planF / priceLevel);
}

// Median of a pinned baseline at `age` (nominal), falling back to the baseline's
// own final-year median when the horizon has since moved past its last band. Lets
// the pin-vs-now delta compare like with like (same age, same deflator).
export function baselineMedianAt(
  baseline: { bands: { age: number; p50: number }[]; futureNW: number }, age: number,
): number {
  return baseline.bands.find(b => b.age === age)?.p50 ?? baseline.futureNW;
}

// The band holding the balance on REACHING `age` (e.g. the first day of retirement):
// the end of age − 1. Null means "today's balances" (age is now or in the past).
// An age beyond the horizon falls back to the final band — so deflate by the
// returned band's own age, not by `age`.
export function bandOnReaching(bands: SimBand[], currentAge0: number, age: number): SimBand | null {
  if (age <= currentAge0) return null;
  return bands.find(b => b.age === age - 1) ?? (bands.length ? bands[bands.length - 1] : null);
}

// Modeled back-projection of the years before today, so the Forecast X-axis can
// extend left and past life events (a home/car bought a few years ago, a kid) sit
// in context. It steps the deterministic median backward from today's known
// balances — reversing the expected investment growth and that year's net savings,
// and discounting real-estate equity at its growth rate. There's no Monte Carlo in
// the past, so each point is a single line (band collapses to the median). Returns
// oldest→newest for ages [startAge, currentAge0 − 1]; empty when startAge ≥ currentAge0.
export function backcastHistory(input: SimInput, startAge: number): SimBand[] {
  const {
    A, currentAge0, infl, costPerKid, kidIndependentAge,
    kidAges, events, earners, pools0, contribByBucket, baseRE, spendingAdjust,
  } = input;
  const yearNow = input.yearNow ?? new Date().getFullYear();
  const count = currentAge0 - startAge;
  if (count <= 0) return [];
  // Fixed-rate manual sleeve, discounted into the past at each entry's own rate
  // (assets − liabilities). No drawdown is modeled in the back-projection.
  const manual = input.manualAssets ?? [];
  const reIn = input.realEstate;
  const r = A.investReturn;

  const recurringAt = (age0: number) => events.filter(e => e.type === 'recurring' && age0 >= e.age && age0 <= (e.untilAge ?? A.endAge)).reduce((t, e) => t + e.amount, 0);
  const repeatAt = (age0: number) => events.filter(e => e.type === 'recurringEvery' && (e.everyYears ?? 0) > 0
    && age0 >= e.age && age0 <= (e.untilAge ?? A.endAge) && (age0 - e.age) % (e.everyYears as number) === 0).reduce((t, e) => t + e.amount, 0);
  const oneTimeAt = (age0: number) => events.filter(e => e.type === 'oneTime' && !e.isSale && e.age === age0).reduce((t, e) => t + e.amount, 0);
  const oneTimeSaleAt = (age0: number) => events.filter(e => e.type === 'oneTime' && e.isSale && e.age === age0).reduce((t, e) => t + e.amount, 0);
  const kidDrop = (i: number) => kidAges.reduce((s, k) => s + (k < kidIndependentAge && k + i >= kidIndependentAge ? costPerKid : 0), 0);

  // Deterministic flow at a (past) age: income, spending, the housing outflow, and
  // the resulting savings (income − tax − spend − one-time − housing). Mirrors the
  // forward flow's terms, evaluated at a negative year offset.
  const flowAt = (age0: number) => {
    const i = age0 - currentAge0; // negative in the past
    const f = Math.pow(1 + infl, i);
    const { grossN, ssN, employerN, anyWorking, contribShare } = earnerFlowsAt(earners, events, age0, i, f);
    const cf = f * contribShare;
    let preN = contribByBucket.pretax * cf, hsaN = contribByBucket.hsa * cf;
    if (grossN <= 0) { preN = 0; hsaN = 0; }
    const spendN = (Math.max(0, A.annualSpending * spendingAdjust - kidDrop(i)) + recurringAt(age0)) * f;
    const oneTimeN = (oneTimeAt(age0) + repeatAt(age0)) * f;
    const windfallN = oneTimeSaleAt(age0) * f;
    const tax = (anyWorking ? A.effTaxRate : A.retireTaxRate) * Math.max(0, grossN - preN - hsaN + 0.85 * ssN);
    // Past housing: P&I is fixed nominal (assume the loan was already in place);
    // carrying costs scale back at their growth rates.
    const housingOutflow = reIn
      ? reIn.properties.reduce((t, p) => t + p.monthlyPI * 12, 0)
        + reIn.propertyTaxAnnual * Math.pow(1 + reIn.taxGrowth, i)
        + reIn.insuranceAnnual * Math.pow(1 + reIn.insuranceGrowth, i)
        + reIn.hoaAnnual * Math.pow(1 + reIn.hoaGrowth, i)
      : 0;
    const housingIncome = reIn ? reIn.rentalIncomeAnnual * Math.pow(1 + reIn.rentalGrowth, i) : 0;
    // The employer match entered investable without being cash income, so it
    // counts toward `saved` (what the year added to the pools) but is left out
    // of the displayed income line, mirroring the forward model.
    const saved = grossN + ssN + windfallN + housingIncome - tax - spendN - oneTimeN - housingOutflow + employerN;
    return { income: grossN + ssN + windfallN + housingIncome, spending: spendN + oneTimeN + housingOutflow, saved };
  };

  // Step backward from today's totals. Each band carries END-of-that-year
  // values, matching the forward bands (whose point at age N is the value after
  // year N's growth and flows) — so the point at age currentAge0−1 is exactly
  // today's balances and the line meets "Today" without a two-year kink.
  let inv = pools0.taxable + pools0.pretax + pools0.roth + pools0.hsa + pools0.college;
  const out: SimBand[] = [];
  for (let j = 1; j <= count; j++) {
    const age0 = currentAge0 - j;
    const f = flowAt(age0);
    const reEquity = Math.max(0, baseRE * Math.pow(1 + A.realEstateGrowth, age0 + 1 - currentAge0)); // discount equity into the past
    const manualPast = manual.reduce((t, m) => t + m.value * Math.pow(1 + m.rate, age0 + 1 - currentAge0), 0);
    const invPast = inv + manualPast;
    out.push({
      age: age0, year: yearNow + (age0 - currentAge0),
      p10: invPast + reEquity, p50: invPast + reEquity, band: 0,
      invP10: invPast, invP50: invPast, invBand: 0,
      re: Math.round(reEquity),
      income: Math.round(f.income), spending: Math.round(f.spending),
    });
    // The age0 year grew investments by r and added its savings; reverse both
    // to get the balance at its start (= the next older point's end-of-year).
    inv = (inv - f.saved) / (1 + r);
  }
  return out.reverse(); // oldest → newest
}
