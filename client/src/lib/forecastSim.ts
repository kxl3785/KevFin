import { MONTE_CARLO_RUNS } from './forecastConfig.ts';
import { amortizeYear } from './mortgage.ts';

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
// IRS-style RMD: roughly 1/(remaining life expectancy). Kicks in at 73.
export function rmdFactor(age: number) { return age >= 73 ? 1 / Math.max(2, 27.4 - (age - 73)) : 0; }

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
export interface SimEvent { type: string; age: number; amount: number; untilAge?: number; everyYears?: number; isPct?: boolean }

// Explicit real-estate model. When provided, the home value appreciates while each
// mortgage amortizes down (equity = value − Σbalance), and the housing cash outflow
// (P&I until payoff, plus tax/insurance/HOA growing at their own rates) is charged
// each year. Omit it to keep the legacy behavior: grow `baseRE` (equity) at
// `realEstateGrowth` with no housing outflow.
export interface SimMortgage { balance: number; ratePct: number; monthlyPI: number }
export interface SimRealEstate {
  value: number;            // current total home value (today's $)
  mortgages: SimMortgage[];
  propertyTaxAnnual: number; insuranceAnnual: number; hoaAnnual: number; // today's $/yr
  taxGrowth: number; insuranceGrowth: number; hoaGrowth: number;          // annual growth rates
}
export interface SimEarner {
  enabled?: boolean; currentAge: number; income: number; retireAge: number;
  raisePct?: number; ssEnabled?: boolean; ssClaimAge: number; ssAnnual: number;
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
  hsaLast: boolean;
  collegeOn: boolean;
  gradOn: boolean;
  spendingAdjust: number;
  realEstate?: SimRealEstate; // explicit home value + mortgage + carrying costs (see above)
  tapHomeEquity?: boolean; // draw home equity as a last resort once liquid pools are exhausted (retirement only)
  glidePath?: boolean;     // de-risk: glide equity exposure down with age, scaling both return and volatility
  runs?: number;       // defaults to MONTE_CARLO_RUNS
  yearNow?: number;    // defaults to the current calendar year (only labels the bands)
  startAge?: number;   // first age plotted; < currentAge0 adds a modeled back-projection (see backcastHistory)
}

export interface SimBand {
  age: number; year: number;
  p10: number; p50: number; band: number;
  invP10: number; invP50: number; invBand: number;
  re: number; income: number; spending: number;
}
export interface SimResult { bands: SimBand[]; successPct: number }

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

  const years = Math.max(1, A.endAge - currentAge0 + 1);

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
  // One-off costs / big purchases land in the single year they occur.
  const oneTimeAt = (age0: number) => events.filter(e => e.type === 'oneTime' && e.age === age0).reduce((t, e) => t + e.amount, 0);
  // A future kid's current age in projection year i (negative until born).
  const futureKidAgeAt = (e: SimEvent, i: number) => (currentAge0 + i) - e.age;

  // --- Real-estate projection (deterministic) --------------------------------
  // When an explicit model is supplied, the home value appreciates while each
  // mortgage amortizes down; equity = value − Σbalance. The housing cash outflow
  // (P&I until payoff + carrying costs) is charged below as part of `net`. Without
  // it, reYears stays null and the legacy baseRE-growth path is used.
  const reIn = input.realEstate;
  const reYears = reIn ? (() => {
    let balances = reIn.mortgages.map(m => m.balance);
    return Array.from({ length: years }, (_, i) => {
      const value = reIn.value * Math.pow(1 + A.realEstateGrowth, i + 1); // end-of-year value
      let pAndI = 0;
      balances = balances.map((bal, mi) => {
        const r = amortizeYear(bal, reIn.mortgages[mi].ratePct, reIn.mortgages[mi].monthlyPI);
        pAndI += r.interest + r.principal; // actual cash paid (0 once paid off)
        return r.endBalance;
      });
      const balance = balances.reduce((a, b) => a + b, 0);
      const carry = reIn.propertyTaxAnnual * Math.pow(1 + reIn.taxGrowth, i)
        + reIn.insuranceAnnual * Math.pow(1 + reIn.insuranceGrowth, i)
        + reIn.hoaAnnual * Math.pow(1 + reIn.hoaGrowth, i);
      return { equity: Math.max(0, value - balance), outflow: pAndI + carry };
    });
  })() : null;

  // --- Deterministic per-year flows (today's $ → nominal via inflation) ------
  // Income, contributions, taxes, spending and education are all deterministic;
  // only investment growth (and thus solvency) is random. Precompute once.
  const yr = Array.from({ length: years }, (_, i) => {
    const f = Math.pow(1 + infl, i);                          // general inflation
    const age0 = currentAge0 + i;
    // Income changes: % raises compound on base income; $ raises add on top.
    const incomeEvents = events.filter(e => e.type === 'income' && e.age <= age0);
    const pctMult = incomeEvents.filter(e => e.isPct).reduce((m, e) => m * (1 + e.amount / 100), 1);
    const dollarRaises = incomeEvents.filter(e => !e.isPct).reduce((t, e) => t + e.amount, 0);

    let grossN = 0, ssN = 0, anyWorking = false;
    earners.forEach((e, idx) => {
      const on = idx === 0 ? true : e.enabled;
      if (!on) return;
      const eAge = e.currentAge + i;
      // Income grows at its OWN raise rate, independent of inflation — for
      // fields without cost-of-living adjustments, wages can lag prices. (Spending
      // still inflates, so real take-home erodes unless the raise keeps up.)
      const raise = Math.pow(1 + (e.raisePct ?? 0.02), i);
      if (eAge < e.retireAge) { grossN += (idx === 0 ? e.income * raise * pctMult + dollarRaises : e.income * raise); anyWorking = true; }
      // Social Security keeps its inflation COLA.
      if (e.ssEnabled && eAge >= e.ssClaimAge) ssN += e.ssAnnual * f;
    });

    // Per-account contributions (today's $ → nominal), only while someone earns.
    const cf = anyWorking ? f : 0;
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

    // Education for every child — current kids plus future-kid events.
    const kidAgesNow = [...kidAges.map(k => k + i), ...events.filter(e => e.type === 'kid').map(e => futureKidAgeAt(e, i))];
    let eduReal = 0;
    for (const a of kidAgesNow) {
      if (collegeOn && a >= A.collegeStartAge && a < A.collegeStartAge + A.collegeYears) eduReal += A.collegeCostPerYear;
      if (gradOn && a >= A.gradStartAge && a < A.gradStartAge + A.gradYears) eduReal += A.gradCostPerYear * A.gradCoverage;
    }
    const collegeNom = eduReal * Math.pow(1 + A.eduInflation, i);

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
    const net = grossN + ssN - tax - (preN + hsaN + rothN + c529N + taxN) - spendN - oneTimeN - housingOutflow;
    return { f, age0, net, anyWorking, pretaxAdd: preN, rothAdd: rothN, hsaAdd: hsaN, c529Add: c529N, taxableAdd: taxN, collegeNom, oneTimeN, grossN, ssN, spendN, housingOutflow };
  });

  // --- Monte Carlo over investment returns ----------------------------------
  const nw: number[][] = Array.from({ length: years }, () => []);
  const invv: number[][] = Array.from({ length: years }, () => []);
  let successCount = 0;

  // Fixed seed → reproducible draws, so the result depends only on the inputs.
  const rand = mulberry32(0x9e3779b9);
  for (let s = 0; s < RUNS; s++) {
    let taxable = pools0.taxable, pretax = pools0.pretax, roth = pools0.roth, hsa = pools0.hsa, c529 = pools0.college;
    // Legacy path grows `re` each year from baseRE; modeled path reads deterministic
    // equity from reYears and tracks a per-run cumulative tap (last-resort drawdown).
    let re = baseRE, tappedCum = 0, solvent = true;
    for (let i = 0; i < years; i++) {
      const d = yr[i];
      // Glide path (when off, eq = 1 → mean = investReturn, vol = volatility).
      const eq = equityFracAt(d.age0);
      const ret = (bondReturn + eq * (A.investReturn - bondReturn)) + (eq * A.volatility) * randn(rand);
      const g = 1 + ret;
      taxable *= g; pretax *= g; roth *= g; hsa *= g; c529 *= g;
      let reEquity: number;
      if (reYears) reEquity = Math.max(0, reYears[i].equity - tappedCum);
      else { re *= (1 + A.realEstateGrowth); reEquity = re; }

      // Contributions in (each account's amount lands in its bucket).
      pretax += d.pretaxAdd; roth += d.rothAdd; hsa += d.hsaAdd; c529 += d.c529Add; taxable += d.taxableAdd;

      // Required Minimum Distributions out of pre-tax (forced, taxed, to taxable).
      if (d.age0 >= 73 && pretax > 0) { const rmd = pretax * rmdFactor(d.age0); pretax -= rmd; taxable += rmd * (1 - A.retireTaxRate); }

      // College: 529 first, then add the remainder to this year's cash need.
      let net = d.net;
      if (d.collegeNom > 0) { const fromC529 = Math.min(c529, d.collegeNom); c529 -= fromC529; net -= (d.collegeNom - fromC529); }

      if (net >= 0) {
        taxable += net;
      } else {
        // Fund the shortfall in tax-efficient order. HSA reserved for last
        // (or moved up if "spend HSA last" is unchecked).
        let need = -net;
        const drawFlat = (bal: number) => { const t = Math.min(bal, need); need -= t; return bal - t; };
        const drawTaxed = (bal: number, rate: number) => { const grossNeed = need / (1 - rate); const t = Math.min(bal, grossNeed); need -= t * (1 - rate); return bal - t; };
        const penalty = d.age0 < 60 ? 0.10 : 0; // ~59½ early-withdrawal penalty
        taxable = drawFlat(taxable);
        if (!hsaLast && need > 0) hsa = drawFlat(hsa); // tax-free, used before pre-tax
        if (need > 0) pretax = drawTaxed(pretax, A.retireTaxRate + penalty);
        if (need > 0) roth = drawFlat(roth);
        if (hsaLast && need > 0) hsa = drawFlat(hsa);
        // Last resort: once every liquid account is drained, an opted-in retiree can
        // tap home equity (downsize / reverse mortgage — treated as untaxed within
        // the primary-residence exclusion) before the run is called insolvent. This
        // also lets the net-worth band reflect a failing run instead of being
        // propped up by an untouched house.
        if (tapHomeEquity && !d.anyWorking && need > 0) {
          const drawn = Math.min(reEquity, need); need -= drawn; reEquity -= drawn;
          if (reYears) tappedCum += drawn; else re = reEquity; // persist the draw across years
        }
        if (need > 1e-6) solvent = false; // ran out of money this year
      }

      const inv = Math.max(0, taxable) + Math.max(0, pretax) + Math.max(0, roth) + Math.max(0, hsa) + Math.max(0, c529);
      nw[i].push(inv + reEquity); invv[i].push(inv);
    }
    if (solvent) successCount++;
  }

  const bands = nw.map((arr, i) => {
    const sNw = [...arr].sort((x, y) => x - y);
    const sInv = [...invv[i]].sort((x, y) => x - y);
    const p10 = pctile(sNw, 0.1), p90 = pctile(sNw, 0.9);
    const ip10 = pctile(sInv, 0.1), ip90 = pctile(sInv, 0.9);
    const d = yr[i];
    return {
      age: d.age0, year: yearNow + i,
      p10, p50: pctile(sNw, 0.5), band: Math.max(0, p90 - p10),
      invP10: ip10, invP50: pctile(sInv, 0.5), invBand: Math.max(0, ip90 - ip10),
      // Real estate grows deterministically, so it's the same across all runs.
      re: Math.round(reYears ? reYears[i].equity : baseRE * Math.pow(1 + A.realEstateGrowth, i + 1)),
      // Spending shown to the user includes the housing outflow so the line reflects
      // the true cash going out (the mortgage P&I drops at payoff).
      income: Math.round(d.grossN + d.ssN), spending: Math.round(d.spendN + d.collegeNom + d.oneTimeN + d.housingOutflow),
    };
  });
  return { bands, successPct: Math.round(successCount / RUNS * 100) };
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
  const reIn = input.realEstate;
  const r = A.investReturn;

  const recurringAt = (age0: number) => events.filter(e => e.type === 'recurring' && age0 >= e.age && age0 <= (e.untilAge ?? A.endAge)).reduce((t, e) => t + e.amount, 0);
  const repeatAt = (age0: number) => events.filter(e => e.type === 'recurringEvery' && (e.everyYears ?? 0) > 0
    && age0 >= e.age && age0 <= (e.untilAge ?? A.endAge) && (age0 - e.age) % (e.everyYears as number) === 0).reduce((t, e) => t + e.amount, 0);
  const oneTimeAt = (age0: number) => events.filter(e => e.type === 'oneTime' && e.age === age0).reduce((t, e) => t + e.amount, 0);
  const kidDrop = (i: number) => kidAges.reduce((s, k) => s + (k < kidIndependentAge && k + i >= kidIndependentAge ? costPerKid : 0), 0);

  // Deterministic flow at a (past) age: income, spending, the housing outflow, and
  // the resulting savings (income − tax − spend − one-time − housing). Mirrors the
  // forward flow's terms, evaluated at a negative year offset.
  const flowAt = (age0: number) => {
    const i = age0 - currentAge0; // negative in the past
    const f = Math.pow(1 + infl, i);
    const incomeEvents = events.filter(e => e.type === 'income' && e.age <= age0);
    const pctMult = incomeEvents.filter(e => e.isPct).reduce((m, e) => m * (1 + e.amount / 100), 1);
    const dollarRaises = incomeEvents.filter(e => !e.isPct).reduce((t, e) => t + e.amount, 0);
    let grossN = 0, ssN = 0, anyWorking = false;
    earners.forEach((e, idx) => {
      if (!(idx === 0 || e.enabled)) return;
      const eAge = e.currentAge + i;
      const raise = Math.pow(1 + (e.raisePct ?? 0.02), i);
      if (eAge < e.retireAge) { grossN += (idx === 0 ? e.income * raise * pctMult + dollarRaises : e.income * raise); anyWorking = true; }
      if (e.ssEnabled && eAge >= e.ssClaimAge) ssN += e.ssAnnual * f;
    });
    const cf = anyWorking ? f : 0;
    let preN = contribByBucket.pretax * cf, hsaN = contribByBucket.hsa * cf;
    if (grossN <= 0) { preN = 0; hsaN = 0; }
    const spendN = (Math.max(0, A.annualSpending * spendingAdjust - kidDrop(i)) + recurringAt(age0)) * f;
    const oneTimeN = (oneTimeAt(age0) + repeatAt(age0)) * f;
    const tax = (anyWorking ? A.effTaxRate : A.retireTaxRate) * Math.max(0, grossN - preN - hsaN + 0.85 * ssN);
    // Past housing: P&I is fixed nominal (assume the loan was already in place);
    // carrying costs scale back at their growth rates.
    const housingOutflow = reIn
      ? reIn.mortgages.reduce((t, m) => t + m.monthlyPI * 12, 0)
        + reIn.propertyTaxAnnual * Math.pow(1 + reIn.taxGrowth, i)
        + reIn.insuranceAnnual * Math.pow(1 + reIn.insuranceGrowth, i)
        + reIn.hoaAnnual * Math.pow(1 + reIn.hoaGrowth, i)
      : 0;
    const saved = grossN + ssN - tax - spendN - oneTimeN - housingOutflow;
    return { income: grossN + ssN, spending: spendN + oneTimeN + housingOutflow, saved };
  };

  // Step backward from today's totals.
  let inv = pools0.taxable + pools0.pretax + pools0.roth + pools0.hsa + pools0.college;
  const out: SimBand[] = [];
  for (let j = 1; j <= count; j++) {
    const age0 = currentAge0 - j;
    // The year that just ended (ages age0 → age0+1) grew investments by r and added
    // its savings; reverse both to get the balance at the start of that year.
    const f = flowAt(age0);
    inv = (inv - f.saved) / (1 + r);
    const reEquity = Math.max(0, baseRE * Math.pow(1 + A.realEstateGrowth, age0 - currentAge0)); // discount equity into the past
    out.push({
      age: age0, year: yearNow + (age0 - currentAge0),
      p10: inv + reEquity, p50: inv + reEquity, band: 0,
      invP10: inv, invP50: inv, invBand: 0,
      re: Math.round(reEquity),
      income: Math.round(f.income), spending: Math.round(f.spending),
    });
  }
  return out.reverse(); // oldest → newest
}
