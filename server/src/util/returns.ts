// Contribution-aware return math: time-weighted return (TWR), money-weighted
// return (XIRR), and annualisation. Pure and dependency-free.
//
// Inputs are dated account VALUES (end-of-day balances, 'YYYY-MM-DD') and dated
// EXTERNAL FLOWS (money the owner moved in or out — deposits and withdrawals,
// never dividends, trades or fees). Flow sign follows the transactions table:
// + = money into the account (a deposit), − = money out (a withdrawal).
//
// Why two numbers:
//  - TWR answers "how did the investments do?" — it strips out the timing and
//    size of deposits, so putting $10k in the day before a crash doesn't make
//    the investments look bad. Benchmarks are TWR-style, so this is the
//    like-for-like comparison.
//  - XIRR (money-weighted) answers "how did MY dollars do?" — the single rate
//    that, compounded daily over the actual dates, turns every dollar in into
//    every dollar out plus what's left. Good timing of deposits raises it.
// With no flows at all both collapse to the simple return V_end / V_start − 1.

export interface Valuation { date: string; value: number }
export interface Flow {
  date: string;
  amount: number;
  // When in its day the flow happens (see timeWeightedReturn). Defaults: money
  // in at the start of the day, money out at the end. 'end' for money in means
  // it arrives already valued at that day's close and earns nothing that day —
  // used when an account joins a combined total at its first recorded balance.
  timing?: 'start' | 'end';
}

const DAY_MS = 86_400_000;
// Money below a cent is treated as zero (avoids dividing by float dust).
const EPS = 0.005;

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY_MS);
}

/**
 * Annualise a cumulative return measured over `days`. Only spans OVER a year are
 * annualised — stretching a few months' return to a yearly rate extrapolates
 * noise — so this is null for spans of 365 days or less, and for a total loss
 * (−100% or worse has no annual equivalent).
 */
export function annualize(periodReturn: number | null, days: number): number | null {
  if (periodReturn == null || !Number.isFinite(periodReturn) || days <= 365 || periodReturn <= -1) return null;
  const r = Math.pow(1 + periodReturn, 365 / days) - 1;
  return Number.isFinite(r) ? r : null;
}

export interface TwrDay { date: string; ret: number }

export interface TwrResult {
  periodReturn: number | null;  // cumulative over the span; null when not measurable
  annualized: number | null;    // only for spans over a year
  startDate: string | null;     // first valuation
  endDate: string | null;
  // The invested span, used for annualising: from the first day money was in
  // the account (the first valuation, or the first deposit into an empty
  // account) to the last valuation. Idle empty days before it don't count.
  days: number;
  // Sub-periods that could not be measured (nothing invested going in and no
  // recorded deposit, yet a value came out) — the money arrived unrecorded.
  unexplained: string[];
  // Per-sub-period returns, for spotting suspicious one-day jumps.
  daily: TwrDay[];
  // ~0 balances treated as a failed sync and skipped (see dropBalanceGlitches).
  glitches: string[];
}

/**
 * A balance of ~0 sitting between two non-zero balances, with no recorded
 * withdrawal that took (at least half of) the money out, is a failed sync —
 * providers send an empty balance now and then and it gets stored as 0 — not
 * a total loss followed by a full recovery. Left in, it would read as −100%
 * and the next day couldn't be linked at all (nothing invested going in), so
 * the return would stay at −100% for good. Those points are dropped: the
 * sub-period simply runs from the last good balance to the next one.
 *
 * Kept: a zero at the start (an empty account before its first deposit), a
 * zero at the end (nothing after it to show it was wrong), and a zero that a
 * recorded withdrawal explains (a real full withdrawal, then a redeposit).
 */
export function dropBalanceGlitches(valuations: Valuation[], flows: Flow[]): { vals: Valuation[]; dropped: string[] } {
  const vals = [...valuations]
    .filter(v => Number.isFinite(v.value))
    .sort((a, b) => a.date.localeCompare(b.date));
  // Index of the last non-zero balance, so "is there a good one after this?" is O(1).
  let lastGood = -1;
  vals.forEach((v, i) => { if (v.value > EPS) lastGood = i; });
  const kept: Valuation[] = [];
  const dropped: string[] = [];
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    const prev = kept[kept.length - 1];
    if (prev && Math.abs(v.value) <= EPS && prev.value > EPS && i < lastGood) {
      const out = flows
        .filter(f => Number.isFinite(f.amount) && f.amount < 0 && f.date > prev.date && f.date <= v.date)
        .reduce((s, f) => s - f.amount, 0);
      if (out < prev.value / 2) { dropped.push(v.date); continue; }
    }
    kept.push(v);
  }
  return { vals: kept, dropped };
}

/**
 * Time-weighted return by daily linking.
 *
 * Sort the valuations V_0..V_n by date. Sub-period i runs from the end of day
 * d_{i−1} to the end of day d_i; a flow belongs to sub-period i when its date
 * falls in (d_{i−1}, d_i]. Flows dated on or before d_0 are already inside V_0,
 * and flows after d_n are outside the window — both are ignored.
 *
 * Timing convention inside a sub-period (stated because it matters on the day
 * a flow lands): money IN is treated as arriving at the START of its day (it
 * is invested and earns that day's move), money OUT as leaving at the END of
 * its day (it was invested all day and earned the move before it left):
 *
 *     r_i = (V_i + Out_i) / (V_{i−1} + In_i) − 1
 *
 * where In_i ≥ 0 is the sum of deposits and Out_i ≥ 0 the size of withdrawals.
 * (A flow can override its timing: an 'end'-timed deposit is subtracted from
 * the numerator instead, a 'start'-timed withdrawal from the denominator.)
 * This keeps both edge cases well defined: a first deposit into an empty
 * account (denominator = the deposit) and a full withdrawal (numerator = the
 * amount taken out). TWR = Π(1 + r_i) − 1.
 *
 * A sub-period whose denominator is ~0 (nothing invested, nothing deposited)
 * is skipped; if value nonetheless appeared it is listed in `unexplained`.
 * Failed-sync zero balances are dropped first (dropBalanceGlitches).
 */
export function timeWeightedReturn(valuations: Valuation[], flows: Flow[]): TwrResult {
  const { vals, dropped: glitches } = dropBalanceGlitches(valuations, flows);
  const empty: TwrResult = {
    periodReturn: null, annualized: null, startDate: vals[0]?.date ?? null,
    endDate: vals[vals.length - 1]?.date ?? null, days: 0, unexplained: [], daily: [], glitches,
  };
  if (vals.length < 2) return empty;
  const startDate = vals[0].date;
  const endDate = vals[vals.length - 1].date;
  const days = daysBetween(startDate, endDate);
  if (days <= 0) return { ...empty, days: 0 };

  const sortedFlows = flows
    .filter(f => Number.isFinite(f.amount) && Math.abs(f.amount) >= EPS)
    .sort((a, b) => a.date.localeCompare(b.date));

  let growth = 1;
  let measured = 0;
  let investedFrom: string | null = null;  // start of the invested span
  const unexplained: string[] = [];
  const daily: TwrDay[] = [];
  let fi = 0;
  // Skip flows on or before the first valuation day (already in V_0).
  while (fi < sortedFlows.length && sortedFlows[fi].date <= startDate) fi++;

  for (let i = 1; i < vals.length; i++) {
    let inflow = 0;   // added to the money invested going in (start of day)
    let outflow = 0;  // added back to the value coming out (end of day)
    let firstIn: string | null = null;
    while (fi < sortedFlows.length && sortedFlows[fi].date <= vals[i].date) {
      const f = sortedFlows[fi];
      const timing = f.timing ?? (f.amount > 0 ? 'start' : 'end');
      if (timing === 'start') { inflow += f.amount; if (f.amount > 0 && !firstIn) firstIn = f.date; } else outflow -= f.amount;
      fi++;
    }
    const denom = vals[i - 1].value + inflow;
    const numer = vals[i].value + outflow;
    if (denom <= EPS) {
      // Nothing was invested going into this sub-period. If something came out
      // the other side, money arrived that no recorded deposit explains.
      if (Math.abs(numer) > EPS) unexplained.push(vals[i].date);
      continue;
    }
    const r = numer / denom - 1;
    if (!Number.isFinite(r)) continue;
    // The first measured sub-period starts the invested span: at the previous
    // balance if money was already in, else on the first deposit into the
    // empty account.
    if (investedFrom == null) investedFrom = vals[i - 1].value > EPS ? vals[i - 1].date : (firstIn ?? vals[i - 1].date);
    growth *= 1 + r;
    measured++;
    daily.push({ date: vals[i].date, ret: r });
  }

  if (measured === 0 || !Number.isFinite(growth)) {
    return { ...empty, startDate, endDate, days, unexplained, daily };
  }
  const periodReturn = growth - 1;
  const investedDays = investedFrom ? daysBetween(investedFrom, endDate) : days;
  return { periodReturn, annualized: annualize(periodReturn, investedDays), startDate, endDate, days: investedDays, unexplained, daily, glitches };
}

/**
 * Days whose one-day return looks like money moving rather than markets moving:
 * |r| above `threshold` that is NOT undone by a neighbouring day. A deposit
 * whose posting date and balance date disagree by a day produces a big drop
 * followed by a matching rise — linking cancels that out, so the pair is not
 * flagged. A lone jump that stays is most likely an unrecorded deposit or
 * withdrawal and is returned.
 */
export function suspiciousJumps(daily: TwrDay[], threshold = 0.2): TwrDay[] {
  const out: TwrDay[] = [];
  for (let i = 0; i < daily.length; i++) {
    const r = daily[i].ret;
    if (Math.abs(r) <= threshold) continue;
    const prev = i > 0 ? (1 + daily[i - 1].ret) * (1 + r) - 1 : r;
    const next = i < daily.length - 1 ? (1 + r) * (1 + daily[i + 1].ret) - 1 : r;
    if (Math.abs(prev) > threshold && Math.abs(next) > threshold) out.push(daily[i]);
  }
  return out;
}

export interface CashFlow { date: string; amount: number }

/**
 * Solve Σ cf_k · (1 + R)^(−t_k / T) = 0 for R, where t_k is days from the first
 * cash flow and T the total span in days — i.e. R is the money-weighted return
 * over the WHOLE span (not yet annualised). Solving per-span rather than per-year
 * keeps short spans well conditioned (a 3-day +5% would be a ~10^6 % annual rate).
 *
 * Newton's method from R = 0 first; if it fails to converge or leaves the valid
 * range (R > −1), fall back to bisection over a scanned bracket. Returns null —
 * never a guess — when there's no sign change (all flows one direction), the span
 * is zero, or no root is found.
 */
export function solveSpanRate(
  cashflows: CashFlow[],
  opts: { skipNewton?: boolean } = {}, // test hook: exercise the bisection path alone
): { rate: number; days: number } | null {
  const cfs = cashflows
    .filter(c => Number.isFinite(c.amount) && Math.abs(c.amount) >= EPS)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (cfs.length < 2) return null;
  if (!cfs.some(c => c.amount > 0) || !cfs.some(c => c.amount < 0)) return null;
  const first = cfs[0].date;
  const T = daysBetween(first, cfs[cfs.length - 1].date);
  if (T <= 0) return null;
  const ts = cfs.map(c => daysBetween(first, c.date) / T);
  const scale = cfs.reduce((s, c) => s + Math.abs(c.amount), 0);

  const npv = (R: number) => cfs.reduce((s, c, k) => s + c.amount * Math.pow(1 + R, -ts[k]), 0);
  const dnpv = (R: number) => cfs.reduce((s, c, k) => s - ts[k] * c.amount * Math.pow(1 + R, -ts[k] - 1), 0);
  const ok = (R: number) => Number.isFinite(R) && R > -1 && Math.abs(npv(R)) <= 1e-7 * scale;

  // Newton.
  let R = 0;
  for (let it = 0; it < (opts.skipNewton ? 0 : 100); it++) {
    const f = npv(R);
    const d = dnpv(R);
    if (!Number.isFinite(f) || !Number.isFinite(d) || d === 0) break;
    let next = R - f / d;
    if (next <= -1) next = (R - 1) / 2; // stay inside the domain: halfway to −1
    if (!Number.isFinite(next)) break;
    if (Math.abs(next - R) < 1e-12) { R = next; break; }
    R = next;
  }
  if (!opts.skipNewton && ok(R)) return { rate: R, days: T };

  // Bisection fallback over a scanned bracket.
  const grid = [-0.9999, -0.99, -0.9, -0.75, -0.5, -0.25, -0.1, 0, 0.1, 0.25, 0.5, 1, 2, 5, 10, 100, 1000, 1e5];
  for (let g = 0; g < grid.length - 1; g++) {
    let lo = grid[g], hi = grid[g + 1];
    let flo = npv(lo), fhi = npv(hi);
    if (!Number.isFinite(flo) || !Number.isFinite(fhi)) continue;
    if (flo === 0) return { rate: lo, days: T };
    if (flo * fhi > 0) continue;
    for (let it = 0; it < 300; it++) {
      const mid = (lo + hi) / 2;
      const fm = npv(mid);
      if (fm === 0 || (hi - lo) / 2 < 1e-13) { lo = hi = mid; break; }
      if (flo * fm < 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
    }
    const root = (lo + hi) / 2;
    if (ok(root)) return { rate: root, days: T };
  }
  return null;
}

/** Classic annual XIRR (actual/365), as a spreadsheet's XIRR() returns it. */
export function xirr(cashflows: CashFlow[]): number | null {
  const s = solveSpanRate(cashflows);
  if (!s) return null;
  const annual = Math.pow(1 + s.rate, 365 / s.days) - 1;
  return Number.isFinite(annual) ? annual : null;
}

export interface MwrResult {
  periodReturn: number | null;  // money-weighted return over the invested span
  annualized: number | null;    // only for spans over a year
  days: number;                 // the invested span (first to last cash flow)
}

/**
 * Money-weighted return from the investor's point of view: the starting value
 * counts as money put in on d_0, each deposit as money put in, each withdrawal
 * as money taken out, and the ending value as money taken out on d_n. Flows are
 * windowed exactly like the TWR: (d_0, d_n].
 *
 * The span runs from the first non-zero cash flow, so an account that starts
 * empty is measured from its first deposit rather than penalised for idle days.
 */
export function moneyWeightedReturn(valuations: Valuation[], flows: Flow[]): MwrResult {
  const vals = [...valuations]
    .filter(v => Number.isFinite(v.value))
    .sort((a, b) => a.date.localeCompare(b.date));
  const none: MwrResult = { periodReturn: null, annualized: null, days: 0 };
  if (vals.length < 2) return none;
  const start = vals[0], end = vals[vals.length - 1];
  if (daysBetween(start.date, end.date) <= 0) return none;

  const cfs: CashFlow[] = [{ date: start.date, amount: -start.value }];
  for (const f of flows) {
    if (f.date > start.date && f.date <= end.date) cfs.push({ date: f.date, amount: -f.amount });
  }
  cfs.push({ date: end.date, amount: end.value });

  const s = solveSpanRate(cfs);
  if (!s) return none;
  return { periodReturn: s.rate, annualized: annualize(s.rate, s.days), days: s.days };
}
