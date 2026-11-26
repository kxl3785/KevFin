// Plan versus actual: how recorded net worth has moved since a Forecast was pinned,
// against the median and 10th–90th range that pin projected. Pure; the page passes
// in the pinned baseline (`mon.fcBaseline`) and the net-worth history it already
// loads. Estimates for planning, not advice.
//
// Dates. A forecast band labelled age X holds the balance at the END of the year
// spent at age X — (X − currentAge0 + 1) years after the day the forecast was made
// (see balanceYearsOut in forecastSim.ts). So band i of a pin made on day D sits
// at `D + (i + 1)` years, and the pin's own starting net worth sits at D. D is the
// pin's day at local noon — the same clock as the recorded net worth, which is
// one figure per day dated at local noon (dayToMs) — so on the day of the pin the
// plan reads exactly the pinned net worth, not a few hours' growth past it.
// Between those points the plan is read by straight-line interpolation.
//
// Dollars. Recorded net worth is in the dollars of each day, so the plan is too:
// the bands are kept nominal (no today's-dollars deflation) for this comparison.
//
// Left-out accounts. The forecast can leave accounts or properties out, so its
// starting net worth can differ from the recorded total. The pin stores both, and
// the recorded series is shifted by their difference (as of the pin), so the
// comparison tracks the same set of holdings. If the left-out holdings change in
// value later, that change still shows up in the "actual" line.

export interface PinnedBand { age: number; p50: number; invP50: number; p10?: number; p90?: number }
export interface PinnedBaseline {
  bands: PinnedBand[]; futureNW: number; successPct: number; at: number;
  // Added for plan tracking; older pins don't have them and still load.
  startNW?: number;        // the forecast's starting net worth when pinned
  recordedNW?: number;     // the latest recorded net worth when pinned
}

export const YEAR_MS = 365.25 * 24 * 3600 * 1000;
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

// A new pin of the shown forecast: the median lines the chart overlays (as before)
// plus what plan tracking needs — each band's 10th–90th range and the starting
// net worth, both as forecast and as recorded.
export function makePin(bands: { age: number; p10: number; p50: number; band: number; invP50: number }[], opts: {
  futureNW: number; successPct: number; startNW: number; recordedNW?: number | null; at: number;
}): PinnedBaseline {
  return {
    bands: bands.map(b => ({ age: b.age, p50: b.p50, invP50: b.invP50, p10: b.p10, p90: b.p10 + Math.max(0, b.band) })),
    futureNW: opts.futureNW, successPct: opts.successPct, at: opts.at,
    startNW: fin(opts.startNW) ? opts.startNW : 0,
    ...(fin(opts.recordedNW) ? { recordedNW: opts.recordedNW } : {}),
  };
}

// True when a pin carries what plan tracking needs (pins saved before it don't).
export function canTrack(b: PinnedBaseline | null | undefined): b is PinnedBaseline & { startNW: number } {
  return !!b && fin(b.at) && fin(b.startNW) && Array.isArray(b.bands) && b.bands.length > 0
    && b.bands.every(x => x && fin(x.p50) && fin(x.p10) && fin(x.p90));
}

export interface PlanPoint { t: number; lo: number; med: number; hi: number }

// The day of `t` at local noon (the time recorded days are dated at).
export function dayNoon(t: number): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12).getTime();
}

// The pin's plan as dated points: the start (the pin's day), then one per band.
export function planPoints(b: PinnedBaseline & { startNW: number }): PlanPoint[] {
  const t0 = dayNoon(b.at);
  const out: PlanPoint[] = [{ t: t0, lo: b.startNW, med: b.startNW, hi: b.startNW }];
  b.bands.forEach((x, i) => {
    const lo = x.p10 as number, hi = x.p90 as number;
    out.push({ t: t0 + (i + 1) * YEAR_MS, lo: Math.min(lo, hi), med: x.p50, hi: Math.max(lo, hi) });
  });
  return out;
}

// Date-axis ticks: the first of a month, every `step` months with `step` the
// smallest of 1, 2, 3, 6, 12, 24, 60… that keeps at most `max` ticks between t0 and t1.
// One tick per month at most, so a "Mon 'YY" label never repeats.
export function monthTicks(t0: number, t1: number, max = 6): number[] {
  if (!fin(t0) || !fin(t1) || t1 < t0) return [];
  const a = new Date(t0);
  // The first-of-months from t0 to t1 on months that are a multiple of `step`
  // (so a yearly axis lands on Januaries).
  const ticksFor = (step: number) => {
    const out: number[] = [];
    let y = a.getFullYear(), m = a.getMonth();
    if (new Date(y, m, 1).getTime() < t0) m++;
    while (((y * 12 + m) % step) !== 0) m++;
    for (let d = new Date(y, m, 1); d.getTime() <= t1; d = new Date(d.getFullYear(), d.getMonth() + step, 1)) out.push(d.getTime());
    return out;
  };
  const cap = Math.max(1, max);
  for (const step of [1, 2, 3, 6, 12, 24, 60, 120, 240, 600, 1200]) {
    const out = ticksFor(step);
    if (out.length <= cap) return out;
  }
  return ticksFor(1200).slice(0, cap);
}

// The plan at time `t` (straight line between dated points; held flat outside them).
export function planAt(points: PlanPoint[], t: number): PlanPoint | null {
  if (!points.length || !fin(t)) return null;
  if (t <= points[0].t) return { ...points[0], t };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], c = points[i];
    if (t <= c.t) {
      const f = c.t > a.t ? (t - a.t) / (c.t - a.t) : 1;
      const mix = (u: number, v: number) => u + (v - u) * f;
      return { t, lo: mix(a.lo, c.lo), med: mix(a.med, c.med), hi: mix(a.hi, c.hi) };
    }
  }
  return { ...points[points.length - 1], t };
}

// 'YYYY-MM-DD' → local noon that day (noon avoids daylight-saving edge cases).
export function dayToMs(day: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day ?? '');
  if (!m) return null;
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12).getTime();
  return Number.isFinite(t) ? t : null;
}

export interface ActualPoint { t: number; nw: number }

// Recorded net worth from the pin's day onward, oldest first, shifted for left-out
// holdings (see above) and thinned to at most `maxPoints` (always keeping the last).
export function actualSince(b: PinnedBaseline & { startNW: number }, history: { date: string; net_worth: number }[], maxPoints = 240): ActualPoint[] {
  const offset = fin(b.recordedNW) ? b.recordedNW - b.startNW : 0;
  const pinDay = new Date(b.at); pinDay.setHours(0, 0, 0, 0);
  const pts = (history ?? [])
    .map(h => ({ t: dayToMs(h?.date), nw: h?.net_worth }))
    .filter((p): p is ActualPoint => p.t != null && fin(p.nw) && p.t >= pinDay.getTime())
    .map(p => ({ t: p.t, nw: p.nw - offset }))
    .sort((x, y) => x.t - y.t);
  // One point per day (the history can repeat a day).
  const byDay: ActualPoint[] = [];
  for (const p of pts) { if (byDay.length && byDay[byDay.length - 1].t === p.t) byDay[byDay.length - 1] = p; else byDay.push(p); }
  const n = Math.max(2, Math.floor(maxPoints));
  if (byDay.length <= n) return byDay;
  const step = (byDay.length - 1) / (n - 1);
  return Array.from({ length: n }, (_, i) => byDay[Math.round(i * step)]);
}

export interface PlanVsActual {
  rows: { t: number; lo: number; band: number; med: number; actual?: number }[];
  latest: {
    t: number; actual: number; med: number; lo: number; hi: number;
    diff: number;                    // actual − plan median (+ ahead, − behind)
    diffPct: number;                 // diff ÷ plan median (0 when the median is ≤ 0)
    position: 'ahead' | 'behind' | 'onPlan';
    inRange: boolean;                // inside the pin's 10th–90th range
  } | null;
  pinnedAt: number;
}

// Within this share of the plan median, today reads as "on plan".
export const ON_PLAN_BAND = 0.005;

// --- Wording ---------------------------------------------------------------------
// What the Forecast's "Today against your plan" tile and its detail panel say,
// from the pin and the recorded history. `money` is the page's formatter (it
// masks figures in privacy mode); `date` formats a day ("Mar 3").
export type TrackStatus =
  | { kind: 'none' }                                    // nothing pinned
  | { kind: 'untracked'; pinnedAt: number }             // pinned before tracking existed
  | { kind: 'waiting'; pinnedAt: number }               // nothing recorded since the pin yet
  | {
    kind: 'tracking'; pinnedAt: number;
    position: 'ahead' | 'behind' | 'onPlan';
    glyph: string;            // ▲ ▼ ●
    headline: string;         // "Ahead of plan by $38,200"
    pct: string;              // "+4.3%" ('' when on plan)
    range: 'inside' | 'outside';
    asOf: number;
    summary: string;          // the full sentence (for screen readers and the panel)
  };

export function trackStatus(data: PlanVsActual | null, baseline: PinnedBaseline | null | undefined, money: (n: number) => string, date: (t: number) => string): TrackStatus {
  if (!baseline) return { kind: 'none' };
  if (!canTrack(baseline) || !data) return { kind: 'untracked', pinnedAt: baseline.at };
  const L = data.latest;
  if (!L) return { kind: 'waiting', pinnedAt: data.pinnedAt };
  const p = Math.abs(L.diffPct * 100);
  const pctTxt = p >= 10 ? Math.round(p).toString() : p.toFixed(1);
  const headline = L.position === 'onPlan' ? 'Right on plan'
    : L.position === 'ahead' ? `Ahead of plan by ${money(Math.abs(L.diff))}` : `Behind plan by ${money(Math.abs(L.diff))}`;
  const pct = L.position === 'onPlan' ? '' : `${L.diff >= 0 ? '+' : '−'}${pctTxt}%`;
  const range = L.inRange ? 'inside' : 'outside';
  const summary = `${headline}${pct ? ` (${pct})` : ''} as of ${date(L.t)}: net worth ${money(L.actual)} against a plan median of ${money(L.med)}. `
    + `That is ${range} the plan’s likely range of ${money(L.lo)} to ${money(L.hi)}.`;
  return {
    kind: 'tracking', pinnedAt: data.pinnedAt, position: L.position,
    glyph: L.position === 'onPlan' ? '●' : L.position === 'ahead' ? '▲' : '▼',
    headline, pct, range, asOf: L.t, summary,
  };
}

// The tile's short lines: a toned headline and a muted detail line.
export function trackTileText(s: TrackStatus, date: (t: number) => string): { head: string; detail: string } {
  switch (s.kind) {
    case 'none': return { head: 'No plan pinned', detail: 'Pin this forecast to track against it' };
    case 'untracked': return { head: 'Not tracked yet', detail: `Pinned ${date(s.pinnedAt)}, before tracking existed · pin again to track` };
    case 'waiting': return { head: `Plan pinned ${date(s.pinnedAt)}`, detail: 'First reading after the next daily update' };
    default: return {
      head: `${s.glyph} ${s.headline}`,
      detail: `${s.pct ? `${s.pct} · ` : ''}${s.range} the likely range · pinned ${date(s.pinnedAt)}`,
    };
  }
}

// Chart rows from the pin to a year past the latest point, and the latest reading.
export function planVsActual(b: PinnedBaseline | null | undefined, history: { date: string; net_worth: number }[] | null | undefined, now = Date.now()): PlanVsActual | null {
  if (!canTrack(b)) return null;
  const points = planPoints(b);
  const actual = actualSince(b, history ?? []);
  const lastActualT = actual.length ? actual[actual.length - 1].t : b.at;
  const t0 = points[0].t;
  const end = Math.min(points[points.length - 1].t, Math.max(now, lastActualT) + YEAR_MS);
  // Plan rows about monthly, plus a row on every actual date so both lines join up.
  const ts = new Set<number>();
  const span = Math.max(0, end - t0);
  const steps = Math.max(1, Math.min(240, Math.ceil(span / (YEAR_MS / 12))));
  for (let i = 0; i <= steps; i++) ts.add(Math.round(t0 + (span * i) / steps));
  const actualByT = new Map(actual.map(p => [p.t, p.nw]));
  for (const p of actual) ts.add(p.t);
  const rows = [...ts].sort((x, y) => x - y).map(t => {
    const p = planAt(points, t) as PlanPoint;
    const row: PlanVsActual['rows'][number] = { t, lo: p.lo, band: Math.max(0, p.hi - p.lo), med: p.med };
    const a = actualByT.get(t);
    if (a != null) row.actual = a;
    return row;
  });
  let latest: PlanVsActual['latest'] = null;
  if (actual.length) {
    const last = actual[actual.length - 1];
    const p = planAt(points, last.t) as PlanPoint;
    const diff = last.nw - p.med;
    const diffPct = p.med > 0 ? diff / p.med : 0;
    const onPlan = p.med > 0 && Math.abs(diffPct) < ON_PLAN_BAND;
    latest = {
      t: last.t, actual: last.nw, med: p.med, lo: p.lo, hi: p.hi, diff, diffPct,
      position: onPlan ? 'onPlan' : diff >= 0 ? 'ahead' : 'behind',
      // "On plan" is never also "outside the likely range": close to the pin the
      // range is narrower than the on-plan tolerance.
      inRange: onPlan || (last.nw >= p.lo - 0.5 && last.nw <= p.hi + 0.5),
    };
  }
  return { rows, latest, pinnedAt: b.at };
}
