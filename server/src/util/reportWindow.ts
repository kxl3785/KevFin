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
export function quarterMonthKeys(w: ReportWindow): string[] {
  const startMonth0 = (w.quarter - 1) * 3;
  return [0, 1, 2].map(i => `${w.year}-${pad(startMonth0 + i + 1)}`);
}
