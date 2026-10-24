// Quarterly-report availability window.
//
// The on-demand report button is deliberately ephemeral: it surfaces for only a
// few days right after a calendar quarter closes, reports on that just-ended
// quarter, then disappears until the next one. This keeps it a small seasonal
// moment rather than permanent UI chrome. All math is in UTC so it matches the
// snapshot dates (`net_worth_snapshots.date`, written from `toISOString()`).

// How many days into the new quarter the button stays visible ("a day or two").
export const REPORT_WINDOW_DAYS = 3;

export interface ReportWindow {
  open: boolean;            // is the button visible right now?
  quarter: number;          // reported (just-ended) quarter, 1–4
  year: number;             // that quarter's calendar year
  quarterLabel: string;     // e.g. "Q2 2026"
  periodStart: string;      // inclusive, YYYY-MM-DD
  periodEnd: string;        // inclusive, YYYY-MM-DD
  windowEndsAt: string | null; // ISO instant the window closes, or null when closed
}

const pad = (n: number) => String(n).padStart(2, '0');

// The report always describes the most recently *completed* quarter, i.e. the
// one before the quarter `now` falls in. `open` is true only during the first
// REPORT_WINDOW_DAYS days of a new quarter.
export function getReportWindow(now: Date): ReportWindow {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();       // 0–11
  const d = now.getUTCDate();

  const inWindow = m % 3 === 0 && d <= REPORT_WINDOW_DAYS;

  // Previous quarter relative to `now`.
  const currentQ = Math.floor(m / 3);   // 0–3
  let rqIdx = currentQ - 1;             // reported quarter index, 0–3
  let ry = y;
  if (rqIdx < 0) { rqIdx = 3; ry = y - 1; }

  const startMonth0 = rqIdx * 3;        // 0-based first month of the quarter
  const endMonth0 = rqIdx * 3 + 2;      // 0-based last month of the quarter
  const lastDay = new Date(Date.UTC(ry, endMonth0 + 1, 0)).getUTCDate();

  return {
    open: inWindow,
    quarter: rqIdx + 1,
    year: ry,
    quarterLabel: `Q${rqIdx + 1} ${ry}`,
    periodStart: `${ry}-${pad(startMonth0 + 1)}-01`,
    periodEnd: `${ry}-${pad(endMonth0 + 1)}-${pad(lastDay)}`,
    windowEndsAt: inWindow
      ? new Date(Date.UTC(y, m, REPORT_WINDOW_DAYS, 23, 59, 59)).toISOString()
      : null,
  };
}

// The 'YYYY-MM' month keys the quarter spans, for aggregating monthly figures.
export function quarterMonthKeys(w: Pick<ReportWindow, 'quarter' | 'year'>): string[] {
  const startMonth0 = (w.quarter - 1) * 3;
  return [0, 1, 2].map(i => `${w.year}-${pad(startMonth0 + i + 1)}`);
}

// --- period figures ----------------------------------------------------------
//
// Pure snapshot math for the report's headline numbers, kept here (dependency-
// free) so the period/YoY edge cases are unit-testable.

export interface SnapshotPoint { date: string; net_worth: number; real_estate_total?: number }

// A baseline snapshot must sit within this many days of the date it stands in
// for (period start / one year before period end), or it isn't used.
export const BASELINE_TOLERANCE_DAYS = 7;

export function addDaysIso(iso: string, days: number): string {
  return new Date(new Date(iso + 'T00:00:00Z').getTime() + days * 86400_000).toISOString().slice(0, 10);
}

export interface PeriodFigures {
  endSnap: SnapshotPoint | null;    // balances the hero value comes from
  startSnap: SnapshotPoint | null;  // baseline for the "this quarter" change
  change: number | null;
  changePct: number | null;         // fraction
  yoyPct: number | null;            // fraction; null when no snapshot ~1 year back
  yoySnap: SnapshotPoint | null;
}

// `history` must be ascending by date.
//  - End: the last snapshot on/before the period end (so a report opened a few
//    days into the next quarter doesn't report post-quarter balances). Falls back
//    to the latest snapshot only when nothing predates the period end.
//  - Start: the prior quarter's close (last snapshot before the period start) if
//    it is within BASELINE_TOLERANCE_DAYS of the start, else the first snapshot on
//    or after the start. The caller prints the date used.
//  - YoY: the snapshot closest to (end − 365 days), only if within the tolerance;
//    otherwise null — a short history must not be passed off as a 1-year figure.
export function computePeriodFigures(history: SnapshotPoint[], w: Pick<ReportWindow, 'periodStart' | 'periodEnd'>): PeriodFigures {
  let endSnap: SnapshotPoint | null = null;
  for (const s of history) if (s.date <= w.periodEnd) endSnap = s;
  if (!endSnap && history.length) endSnap = history[history.length - 1];

  let startSnap: SnapshotPoint | null = null;
  if (endSnap) {
    let prior: SnapshotPoint | null = null;
    for (const s of history) if (s.date < w.periodStart) prior = s;
    const earliestOk = addDaysIso(w.periodStart, -BASELINE_TOLERANCE_DAYS);
    startSnap = prior && prior.date >= earliestOk
      ? prior
      : history.find(s => s.date >= w.periodStart) ?? null;
    if (startSnap && startSnap.date >= endSnap.date) startSnap = null;
  }

  const change = endSnap && startSnap ? endSnap.net_worth - startSnap.net_worth : null;
  const changePct = change != null && startSnap && startSnap.net_worth ? change / startSnap.net_worth : null;

  let yoySnap: SnapshotPoint | null = null;
  if (endSnap) {
    const target = new Date(addDaysIso(endSnap.date, -365) + 'T00:00:00Z').getTime();
    let bestGap = Infinity;
    for (const s of history) {
      if (s.date >= endSnap.date || !s.net_worth) continue;
      const gap = Math.abs(new Date(s.date + 'T00:00:00Z').getTime() - target) / 86400_000;
      if (gap <= BASELINE_TOLERANCE_DAYS && gap < bestGap) { yoySnap = s; bestGap = gap; }
    }
  }
  const yoyPct = endSnap && yoySnap ? (endSnap.net_worth - yoySnap.net_worth) / yoySnap.net_worth : null;

  return { endSnap, startSnap, change, changePct, yoyPct, yoySnap };
}

// --- outlook horizon (for the AI market-view prompt) ------------------------

const LONG_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];

export interface OutlookHorizon {
  generatedOn: string;   // "October 24, 2026"
  restOfYear: string;    // "the remainder of 2026 (Q4)"
  nextPeriod: string;    // "early 2027"
}

// The forward-looking periods relative to the real generation date, so a report
// generated in any quarter asks about the right horizon.
export function outlookHorizon(now: Date): OutlookHorizon {
  const y = now.getUTCFullYear();
  const q = Math.floor(now.getUTCMonth() / 3) + 1;
  return {
    generatedOn: `${LONG_MONTHS[now.getUTCMonth()]} ${now.getUTCDate()}, ${y}`,
    restOfYear: q === 4 ? `the remainder of ${y} (Q4)` : `the remainder of ${y} (Q${q} through Q4)`,
    nextPeriod: `early ${y + 1}`,
  };
}

// The observation (date-sorted or not) closest to `target` within the tolerance,
// or null. Used for per-account start/end balances.
export function nearestObservation<T extends { date: string }>(obs: T[], target: string, tolDays = BASELINE_TOLERANCE_DAYS): T | null {
  const t = new Date(target + 'T00:00:00Z').getTime();
  let best: T | null = null, bestGap = Infinity;
  for (const o of obs) {
    const gap = Math.abs(new Date(o.date + 'T00:00:00Z').getTime() - t) / 86400_000;
    if (gap <= tolDays && gap < bestGap) { best = o; bestGap = gap; }
  }
  return best;
}

// The window for the quarter before `w`'s (for "vs. last quarter" comparisons).
export function priorWindow(w: ReportWindow): Pick<ReportWindow, 'quarter' | 'year' | 'quarterLabel' | 'periodStart' | 'periodEnd'> {
  const q = w.quarter === 1 ? 4 : w.quarter - 1;
  const y = w.quarter === 1 ? w.year - 1 : w.year;
  const startMonth0 = (q - 1) * 3;
  const lastDay = new Date(Date.UTC(y, startMonth0 + 3, 0)).getUTCDate();
  return {
    quarter: q, year: y, quarterLabel: `Q${q} ${y}`,
    periodStart: `${y}-${pad(startMonth0 + 1)}-01`,
    periodEnd: `${y}-${pad(startMonth0 + 3)}-${pad(lastDay)}`,
  };
}
