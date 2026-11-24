import { runForecastSim, balanceYearsOut, deflateReal, type SimInput, type SimResult } from './forecastSim.ts';

// "What your plan supports": turns the Forecast's success percentage into amounts
// and ages a person can act on. Pure and dependency-free apart from the simulation
// itself; nothing here touches the DOM, the network or any account.
//
// Every answer is a search over runForecastSim with the plan's inputs nudged along
// one dial (spending, the starting investable balance, the retirement age):
//   - safe spending: the highest everyday spending at which the plan still succeeds
//     at least `target` of the time;
//   - guardrails: at that spending, the investable balance below which success
//     falls to `lower` (and the spending that would restore `target` there), and
//     the balance above which it passes `upper` (and the spending that would bring
//     it back down to `target`);
//   - independence number: the investable balance at which stopping work today
//     would still meet `target`;
//   - coast point: whether today's balance, with no new saving, would carry the
//     planned retirement — and the balance that would;
//   - earliest workable retirement age.
//
// COMMON RANDOM NUMBERS. The simulation seeds run s from s alone (runSeed), so every
// candidate below is scored on the SAME market paths. Two candidates then differ
// only by the dial being turned, never by luck of the draw, which makes the
// success rate a step function of the dial that (path by path) only ever moves one
// way — more spending never rescues a path that failed, a bigger balance never
// sinks one that lasted. That is what lets plain bisection converge, and what
// makes the same inputs give the same answers on every call.
//
// RUN COUNT. The page's own forecast uses 400 paths (MONTE_CARLO_RUNS). That is
// coarse near the 95% upper bound: only ~20 paths fail there, and the binomial
// standard error of a 95% reading is √(0.95·0.05/400) ≈ 1.1 points. Measured on a
// typical plan (age 40, $500k saved, $70k spending), re-solving the 95%-success
// spending with 20 different sets of draws moved the answer by a standard
// deviation of ≈$1,400 at 400 paths, ≈$1,100 at 1,000 and ≈$860 at 2,000 (at 85%:
// $1,380 / $780 / $770). 1,000 paths roughly halves the 95% reading's error
// (≈0.7 points) for 2.5× the work; 2,000 buys little more for twice that again,
// and the bracket-tax model costs ~130 ms per 1,000-path run, so the solver uses
// 1,000. Its first 400 paths are exactly the page's 400 (same seeds), so the two
// agree closely — but not exactly, which the card says.
//
// Historical replay ignores `runs` (one path per complete starting year), so there
// the success rate moves in steps of 1/starting-years.
//
// SPENDING RULES. Every answer reads "success" as "never runs out". Under the
// share-of-savings rule (percentOfPortfolio) retired everyday spending is a share
// of whatever is left, so savings never run out on it: the spending, balance and
// age dials stop moving the success rate, and a $0 balance "passes". None of the
// answers would mean what their labels say, so solvePlan works out none of them
// and marks them 'notApplicable' (the card says why). Under guardrails the
// answers still mean something, but each counts on the rule's cuts in bad years:
// safe spending is a STARTING amount, and the card's own spending guardrails
// would sit on top of the rule's, so those are not worked out.
//
// Estimates for planning, not advice.

export const SOLVER_RUNS = 1000;
export const SPEND_STEP = 500;   // safe spending is reported on a $500 grid (today's $)
const BALANCE_ROUND = 1000;      // balances are reported to the nearest $1,000
const SPEND_CAP = 5_000_000;     // above this, spending is "unbounded" for the plan
const BALANCE_CAP = 1e9;         // above this, a balance is "out of reach"

export interface SolveTargets {
  target: number; // the confidence the plan must keep (0.85 = 85% of paths last)
  lower: number;  // guardrail: success falling to this triggers a spending cut
  upper: number;  // guardrail: success passing this allows a raise
}
export const DEFAULT_TARGETS: SolveTargets = { target: 0.85, lower: 0.70, upper: 0.95 };

// Repair stored/typed targets: each in [0.05, 0.99], with lower < target < upper.
export function normalizeTargets(raw: unknown): SolveTargets {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(0.99, Math.max(0.05, v)) : d);
  const target = n(r.target, DEFAULT_TARGETS.target);
  let lower = n(r.lower, DEFAULT_TARGETS.lower), upper = n(r.upper, DEFAULT_TARGETS.upper);
  if (!(lower < target)) lower = Math.max(0.01, target - 0.15);
  if (!(upper > target)) upper = Math.min(0.995, target + (1 - target) / 2);
  return { target, lower, upper };
}

// --- Dials --------------------------------------------------------------------
// "Investable" here means the money that can be drawn for spending: taxable,
// pre-tax, Roth and HSA. The 529 (earmarked for college), fixed-rate manual assets
// and home equity stay as they are when a balance is varied.

export function investableOf(input: SimInput): number {
  const p = input.pools0;
  return Math.max(0, p.taxable) + Math.max(0, p.pretax) + Math.max(0, p.roth) + Math.max(0, p.hsa);
}

// The plan with its investable balance set to `b`, keeping today's mix across
// accounts (all of it in the taxable account when there is no mix to keep).
export function withInvestable(input: SimInput, b: number): SimInput {
  const target = Math.max(0, Number.isFinite(b) ? b : 0);
  const p = input.pools0;
  const now = investableOf(input);
  if (now <= 0) return { ...input, pools0: { ...p, taxable: target, pretax: 0, roth: 0, hsa: 0 } };
  const k = target / now;
  return { ...input, pools0: { ...p, taxable: Math.max(0, p.taxable) * k, pretax: Math.max(0, p.pretax) * k, roth: Math.max(0, p.roth) * k, hsa: Math.max(0, p.hsa) * k } };
}

// The plan's everyday spending (today's $): the Annual spending figure times the
// Spending lever. Housing, college, kids yet to come and life events are separate.
export const spendingOf = (input: SimInput) => Math.max(0, input.A.annualSpending * input.spendingAdjust);

export function withSpending(input: SimInput, s: number): SimInput {
  return { ...input, A: { ...input.A, annualSpending: Math.max(0, s) }, spendingAdjust: 1 };
}

// Earners counted by the simulation: earner 0 always, the rest when enabled.
const activeEarners = (input: SimInput) => input.earners.map((e, i) => ({ e, i })).filter(({ e, i }) => i === 0 || e.enabled);
const isWorking = (e: { currentAge: number; retireAge: number }) => e.retireAge > e.currentAge;
export const anyoneWorking = (input: SimInput) => activeEarners(input).some(({ e }) => isWorking(e));

// Everyone still working stops now.
export function stopWorkNow(input: SimInput): SimInput {
  return { ...input, earners: input.earners.map(e => (isWorking(e) ? { ...e, retireAge: e.currentAge } : e)) };
}

// Shift every still-working earner's retirement age by `delta` years together,
// never earlier than today. Earners already retired stay retired.
export function shiftRetirement(input: SimInput, delta: number): SimInput {
  return { ...input, earners: input.earners.map(e => (isWorking(e) ? { ...e, retireAge: Math.max(e.currentAge, e.retireAge + delta) } : e)) };
}

// --- Evaluation ---------------------------------------------------------------
// A candidate is the plan with some dials turned. Results are memoised per
// candidate within one solve, and every simulation is preceded by a `yield` so a
// driver can pause between them (see runInSlices) — one yield = one simulation.

interface Candidate { spend?: number; invest?: number; stopNow?: boolean; coast?: boolean; shift?: number }

export class Evaluator {
  sims = 0;
  readonly runs: number;
  private base: SimInput;
  private memo = new Map<string, SimResult>();
  constructor(base: SimInput, runs = SOLVER_RUNS) { this.base = base; this.runs = runs; }

  build(c: Candidate): SimInput {
    let x: SimInput = { ...this.base, runs: this.runs, exactSuccess: true };
    if (c.stopNow) x = stopWorkNow(x);
    if (c.shift) x = shiftRetirement(x, c.shift);
    if (c.coast) x = { ...x, coast: true };
    if (c.spend != null) x = withSpending(x, c.spend);
    if (c.invest != null) x = withInvestable(x, c.invest);
    return x;
  }

  *sim(c: Candidate): Generator<number, SimResult> {
    const key = JSON.stringify([c.spend ?? null, c.invest ?? null, !!c.stopNow, !!c.coast, c.shift ?? 0]);
    const hit = this.memo.get(key);
    if (hit) return hit;
    yield this.sims;
    const r = runForecastSim(this.build(c));
    this.sims++;
    this.memo.set(key, r);
    return r;
  }

  *rate(c: Candidate): Generator<number, number> {
    const r = yield* this.sim(c);
    const v = r.successRate ?? r.successPct / 100;
    return Number.isFinite(v) ? v : 0;
  }
}

// The plan's retirement spending rule, as the answers treat it.
export type AnswerRule = 'fixed' | 'guardrails' | 'percentOfPortfolio';
export function answerRule(input: SimInput): AnswerRule {
  const k = input.withdrawal?.kind;
  return k === 'guardrails' || k === 'percentOfPortfolio' ? k : 'fixed';
}

// --- Searches -----------------------------------------------------------------
// Both assume `ok` is monotone in its argument (true below / false above for
// spending; false below / true above for a balance), which common random numbers
// make true path by path in all but pathological plans. If it isn't, bisection
// still returns a point where `ok` flips — a valid, if not unique, answer.

export type SpendSearch = { status: 'ok'; amount: number } | { status: 'never' } | { status: 'unbounded' };

// The highest k·SPEND_STEP with ok() true, starting near `start` (today's $).
export function* maxSpendWhere(ok: (s: number) => Generator<number, boolean>, start: number): Generator<number, SpendSearch> {
  const cap = Math.floor(SPEND_CAP / SPEND_STEP);
  const k0 = Math.min(cap, Math.max(0, Math.round((Number.isFinite(start) ? start : 0) / SPEND_STEP)));
  let lo: number, hi: number;
  if (yield* ok(k0 * SPEND_STEP)) {
    lo = k0;
    hi = Math.max(k0 * 2, 40); // $20k
    while (yield* ok(hi * SPEND_STEP)) {
      lo = hi;
      if (hi >= cap) return { status: 'unbounded' };
      hi = Math.min(cap, hi * 2);
    }
  } else {
    hi = k0;
    if (k0 === 0) return { status: 'never' };
    lo = Math.floor(k0 / 2);
    while (!(yield* ok(lo * SPEND_STEP))) {
      if (lo === 0) return { status: 'never' };
      hi = lo; lo = Math.floor(lo / 2);
    }
  }
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (yield* ok(mid * SPEND_STEP)) lo = mid; else hi = mid;
  }
  return { status: 'ok', amount: lo * SPEND_STEP };
}

export type BalanceSearch = { status: 'ok'; amount: number } | { status: 'outOfReach' };

// The smallest balance with ok() true, to within max($1,000, 0.5%), rounded up to
// the next $1,000 (so the reported balance itself passes). Starts near `start`.
export function* minBalanceWhere(ok: (b: number) => Generator<number, boolean>, start: number, floorHi = 100_000): Generator<number, BalanceSearch> {
  const s = Math.max(0, Number.isFinite(start) ? start : 0);
  let lo: number, hi: number;
  const startOk = s > 0 && (yield* ok(s));
  if (startOk) {
    hi = s; lo = s / 2;
    while (yield* ok(lo)) {
      hi = lo;
      if (lo < BALANCE_ROUND) {
        if (yield* ok(0)) return { status: 'ok', amount: 0 };
        lo = 0; break;
      }
      lo /= 2;
    }
  } else {
    if (s === 0 && (yield* ok(0))) return { status: 'ok', amount: 0 };
    lo = s; hi = Math.max(s * 2, floorHi);
    while (!(yield* ok(hi))) {
      lo = hi;
      if (hi >= BALANCE_CAP) return { status: 'outOfReach' };
      hi = Math.min(BALANCE_CAP, hi * 2);
    }
  }
  const tol = Math.max(BALANCE_ROUND, hi * 0.005);
  while (hi - lo > tol) {
    const mid = (lo + hi) / 2;
    if (yield* ok(mid)) hi = mid; else lo = mid;
  }
  // Rounding up must not report more than a starting balance already known to pass.
  const up = Math.ceil(hi / BALANCE_ROUND) * BALANCE_ROUND;
  return { status: 'ok', amount: startOk ? Math.min(s, up) : up };
}

// --- The answers --------------------------------------------------------------

export interface Guardrail { balance: number; spending: number | null }
// An answer the active spending rule makes meaningless (see SPENDING RULES above).
export type NotApplicable = { status: 'notApplicable' };
export interface PlanAnswersResult {
  runs: number;
  targets: SolveTargets;
  rule: AnswerRule;
  // True when the base simulation replayed past starting years (historical mode
  // with at least one starting year that fits); false for random futures,
  // including historical mode's fallback to them.
  historical: boolean;
  // The earner whose retirement the age and coast answers move and name: the
  // first counted earner still working (earner 0 unless already retired). Null
  // when nobody is still working.
  lead: { index: number; currentAge: number; retireAge: number } | null;
  // Today's plan as the solver scores it (SOLVER_RUNS paths).
  current: { spending: number; investable: number; successRate: number };
  safeSpending: SpendSearch | NotApplicable;
  // Null when there is no safe spending to guard, or under a spending rule (which
  // raises and cuts spending itself). `lower` null: even with nothing invested
  // success stays above the lower bound; `upper` null: no balance (up to the cap)
  // lifts it past the upper bound.
  guardrails: { lower: Guardrail | null; upper: Guardrail | null } | null;
  independence: { status: 'ok'; amount: number; progress: number } | { status: 'outOfReach' } | NotApplicable;
  coast: { status: 'retired' } | { status: 'ok'; amount: number; coasting: boolean } | { status: 'outOfReach' } | NotApplicable;
  earliestRetirement:
    | { status: 'retired' }
    | { status: 'ok'; age: number; shift: number; partnerAge: number | null }
    | { status: 'never' }
    | NotApplicable;
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

// A rough count of simulations a full solve takes, for the progress bar (the
// actual count depends on where the answers fall).
export const ESTIMATED_SIMS = 75;

export function* solvePlan(base: SimInput, targetsIn: SolveTargets = DEFAULT_TARGETS, runs = SOLVER_RUNS): Generator<number, PlanAnswersResult> {
  const t = normalizeTargets(targetsIn);
  const ev = new Evaluator(base, runs);
  const spend0 = spendingOf(base);
  const inv0 = investableOf(base);
  const atLeast = (c: Candidate, p: number) => function* (): Generator<number, boolean> { return (yield* ev.rate(c)) >= p - 1e-12; };

  const rule = answerRule(base);
  const leadIdx = base.earners.findIndex((e, i) => (i === 0 || e.enabled) && isWorking(e));
  const lead = leadIdx >= 0 ? base.earners[leadIdx] : null;
  const leadInfo = lead ? { index: leadIdx, currentAge: lead.currentAge, retireAge: lead.retireAge } : null;

  const baseSim = yield* ev.sim({});
  const historical = !!baseSim.historical && !baseSim.historical.fallback;
  const current = { spending: spend0, investable: inv0, successRate: yield* ev.rate({}) };

  // Share of savings: nothing to search for (see SPENDING RULES above).
  if (rule === 'percentOfPortfolio') {
    const na: NotApplicable = { status: 'notApplicable' };
    return { runs: ev.runs, targets: t, rule, historical, lead: leadInfo, current, safeSpending: na, guardrails: null, independence: na, coast: na, earliestRetirement: na };
  }

  // a. Safe spending at today's balance.
  const safeSpending = yield* maxSpendWhere(s => atLeast({ spend: s }, t.target)(), spend0);

  // b. Guardrails around that spending (not under a spending rule: it moves
  // spending itself, and two sets of guardrails would contradict each other).
  let guardrails: PlanAnswersResult['guardrails'] = null;
  if (safeSpending.status === 'ok' && rule === 'fixed') {
    const S = safeSpending.amount;
    const spendAt = function* (b: number): Generator<number, number | null> {
      const r = yield* maxSpendWhere(s => atLeast({ spend: s, invest: b }, t.target)(), S);
      return r.status === 'ok' ? r.amount : null;
    };
    let lower: Guardrail | null = null, upper: Guardrail | null = null;
    // Lower: the smallest balance still at or above the lower bound. If even $0
    // clears it (income and Social Security carry the plan), there is no floor.
    const lo = yield* minBalanceWhere(b => atLeast({ spend: S, invest: b }, t.lower)(), inv0);
    if (lo.status === 'ok' && lo.amount > 0) lower = { balance: lo.amount, spending: yield* spendAt(lo.amount) };
    const up = yield* minBalanceWhere(b => atLeast({ spend: S, invest: b }, t.upper)(), inv0);
    if (up.status === 'ok') upper = { balance: up.amount, spending: yield* spendAt(up.amount) };
    guardrails = { lower, upper };
  }

  // c. Independence number: stop working now, keep today's spending.
  const ind = yield* minBalanceWhere(b => atLeast({ stopNow: true, invest: b }, t.target)(), inv0, Math.max(100_000, spend0 * 25));
  const independence: PlanAnswersResult['independence'] = ind.status === 'ok'
    ? { status: 'ok', amount: ind.amount, progress: ind.amount > 0 ? Math.max(0, inv0 / ind.amount) : 1 }
    : { status: 'outOfReach' };

  // c'. Coast point: no new saving from today, retiring as planned.
  let coast: PlanAnswersResult['coast'];
  if (!anyoneWorking(base)) coast = { status: 'retired' };
  else {
    const c = yield* minBalanceWhere(b => atLeast({ coast: true, invest: b }, t.target)(), inv0);
    coast = c.status === 'ok' ? { status: 'ok', amount: c.amount, coasting: inv0 >= c.amount } : { status: 'outOfReach' };
  }

  // d. Earliest workable retirement age (every working earner shifted together).
  // The age reported is the lead earner's (see PlanAnswersResult.lead).
  let earliestRetirement: PlanAnswersResult['earliestRetirement'];
  if (!lead) earliestRetirement = { status: 'retired' };
  else {
    const dMin = lead.currentAge - lead.retireAge;                       // < 0: stop now
    const dMax = Math.max(0, base.A.endAge - lead.retireAge);            // work to the plan's end
    const ok = (d: number) => atLeast({ shift: d }, t.target)();
    // Bisect on the shift between a failing `lo` and a passing `hi`; today's plan
    // (shift 0) is the first probe, so the search goes earlier or later from there.
    let shift: number | null;
    let lo: number, hi: number;
    if (yield* ok(0)) {
      if (yield* ok(dMin)) { shift = dMin; lo = hi = dMin; }
      else { lo = dMin; hi = 0; shift = 0; }
    } else if (!(yield* ok(dMax))) { shift = null; lo = hi = 0; }
    else { lo = 0; hi = dMax; shift = dMax; }
    if (shift != null) {
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (yield* ok(mid)) hi = mid; else lo = mid;
      }
      shift = hi;
      const partner = base.earners.find((e, i) => i > 0 && e.enabled && isWorking(e) && e !== lead);
      earliestRetirement = {
        status: 'ok', shift,
        age: Math.max(lead.currentAge, lead.retireAge + shift),
        partnerAge: partner ? Math.max(partner.currentAge, partner.retireAge + shift) : null,
      };
    } else earliestRetirement = { status: 'never' };
  }

  return { runs: ev.runs, targets: t, rule, historical, lead: leadInfo, current, safeSpending, guardrails, independence, coast, earliestRetirement };
}

// --- Scenario comparison --------------------------------------------------------
export interface ScenarioRow {
  successRate: number;
  medianEndReal: number;          // median net worth at the plan's end, today's $
  safeSpending: SpendSearch | NotApplicable; // a starting amount under guardrails; n/a under share of savings
  retireAge: number;              // earner 0's planned retirement age
  rule: AnswerRule;
}

export function* solveScenarioRow(input: SimInput, targetsIn: SolveTargets = DEFAULT_TARGETS, runs = SOLVER_RUNS): Generator<number, ScenarioRow> {
  const t = normalizeTargets(targetsIn);
  const ev = new Evaluator(input, runs);
  const r = yield* ev.sim({});
  const last = r.bands.length ? r.bands[r.bands.length - 1] : null;
  const medianEndReal = last ? deflateReal(last.p50, balanceYearsOut(last.age, input.currentAge0), input.infl) : 0;
  const rule = answerRule(input);
  const safeSpending: ScenarioRow['safeSpending'] = rule === 'percentOfPortfolio' ? { status: 'notApplicable' }
    : yield* maxSpendWhere(s => (function* (): Generator<number, boolean> { return (yield* ev.rate({ spend: s })) >= t.target - 1e-12; })(), spendingOf(input));
  return {
    successRate: clamp01(r.successRate ?? r.successPct / 100),
    medianEndReal: Number.isFinite(medianEndReal) ? medianEndReal : 0,
    safeSpending,
    retireAge: input.earners[0]?.retireAge ?? 0,
    rule,
  };
}

// --- Jobs -----------------------------------------------------------------------
// A solve as plain data, so it can run on a background thread (see solveDriver.ts
// and forecastSolve.worker.ts) or on the page's own thread with runInSlices. The
// same code runs either way, with the same seeds, so the answers match exactly.
// A 'plan' job's generator yields the simulations done so far; a 'rows' job's
// yields the rows finished so far.

export type SolveJob =
  | { kind: 'plan'; input: SimInput; targets: SolveTargets; runs?: number }
  | { kind: 'rows'; inputs: SimInput[]; targets: SolveTargets; runs?: number };
export type SolveJobResult<J extends SolveJob> = J extends { kind: 'plan' } ? PlanAnswersResult : ScenarioRow[];

export function jobGenerator(job: SolveJob): Generator<number, PlanAnswersResult | ScenarioRow[]> {
  if (job.kind === 'plan') return solvePlan(job.input, job.targets, job.runs ?? SOLVER_RUNS);
  return (function* (): Generator<number, ScenarioRow[]> {
    const out: ScenarioRow[] = [];
    for (let i = 0; i < job.inputs.length; i++) {
      const g = solveScenarioRow(job.inputs[i], job.targets, job.runs ?? SOLVER_RUNS);
      for (;;) {
        const s = g.next();
        if (s.done) { out.push(s.value); break; }
        yield i;
      }
    }
    return out;
  })();
}

// Messages from the background thread to the page.
export type SolveMessage =
  | { type: 'progress'; n: number }
  | { type: 'done'; value: PlanAnswersResult | ScenarioRow[] }
  | { type: 'error'; message: string };

// Run a job to the end, posting progress at most every `everyMs` (and whenever a
// 'rows' job finishes a row), then the result — or the error. The background
// thread's whole message handler; pure apart from `post` and the clock.
export function handleSolveJob(job: SolveJob, post: (m: SolveMessage) => void, everyMs = 80, now: () => number = Date.now): void {
  try {
    const gen = jobGenerator(job);
    let last = now(), lastN = -1;
    for (;;) {
      const s = gen.next();
      if (s.done) { post({ type: 'done', value: s.value }); return; }
      const t = now();
      if (s.value !== lastN && (t - last >= everyMs || job.kind === 'rows')) { last = t; lastN = s.value; post({ type: 'progress', n: s.value }); }
    }
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
}

// --- Drivers --------------------------------------------------------------------

// Run a solver generator to completion synchronously (tests, small jobs).
export function runToEnd<T>(gen: Generator<number, T>): T {
  for (;;) { const s = gen.next(); if (s.done) return s.value; }
}

// Run a solver generator in slices of about `sliceMs`, yielding to the browser in
// between (setTimeout 0) so the page stays responsive. `onProgress(sims)` reports
// the simulations done so far. Returns a cancel function; `onDone` is not called
// after a cancel.
export function runInSlices<T>(gen: Generator<number, T>, opts: {
  onDone: (v: T) => void; onProgress?: (sims: number) => void; onError?: (e: unknown) => void; sliceMs?: number;
}): () => void {
  let cancelled = false, timer: ReturnType<typeof setTimeout> | null = null, sims = 0;
  const slice = opts.sliceMs ?? 24;
  const step = () => {
    timer = null;
    if (cancelled) return;
    const t0 = Date.now();
    try {
      for (;;) {
        const s = gen.next();
        if (s.done) { if (!cancelled) opts.onDone(s.value); return; }
        sims = s.value;
        if (Date.now() - t0 >= slice) break;
      }
    } catch (e) { if (!cancelled) opts.onError?.(e); return; }
    opts.onProgress?.(sims);
    timer = setTimeout(step, 0);
  };
  timer = setTimeout(step, 0);
  return () => { cancelled = true; if (timer) clearTimeout(timer); };
}

// --- Cache ------------------------------------------------------------------------
// Answers keyed by a hash of everything that feeds them, so flipping back to a
// plan already solved shows its answers at once. Small and in-memory only.

// FNV-1a over the JSON text (32-bit, hex). Collisions only cost a wrong cache hit
// between two plans with the same hash, which at this cache size is negligible.
export function hashInputs(value: unknown): string {
  let s: string;
  try { s = JSON.stringify(value) ?? ''; } catch { s = ''; }
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0') + ':' + s.length.toString(36);
}

export class AnswerCache<T> {
  private m = new Map<string, T>();
  private max: number;
  constructor(max = 16) { this.max = Math.max(1, max); }
  get(k: string): T | undefined {
    const v = this.m.get(k);
    if (v !== undefined) { this.m.delete(k); this.m.set(k, v); }
    return v;
  }
  set(k: string, v: T) {
    this.m.delete(k); this.m.set(k, v);
    while (this.m.size > this.max) this.m.delete(this.m.keys().next().value as string);
  }
}
