// Labels for the Investments performance boxes: WHICH timeframe a return covers.
// Dates are 'YYYY-MM-DD' strings, parsed as UTC so the label never shifts a day
// (or a month, on the 1st) with the viewer's timezone.

export type PerfRange = 'YTD' | '1Y' | '3Y' | '5Y' | 'ALL' | 'custom';

// A series that starts within this many days of the window start is treated as
// covering the whole window (weekends/holidays mean the first data point is
// rarely exactly on `from`).
const LATE_START_DAYS = 7;
// Below a year a CAGR is an extrapolation of a partial-year return, so the
// boxes show the period return instead. The same slack as above keeps a "1Y"
// series whose first point lands a few days after the window start on CAGR.
const MIN_CAGR_DAYS = 365 - LATE_START_DAYS;

const DAY_MS = 86_400_000;
const utc = (d: string) => Date.parse(d + 'T00:00:00Z');

// "Mar 2021"
export function fmtMonthYear(d: string): string {
  return new Date(utc(d)).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

// "Mar 5, 2021" — exact dates for tooltips.
export function fmtFullDate(d: string): string {
  return new Date(utc(d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

// Whole days between two dates (can be negative).
export function daysBetween(a: string, b: string): number {
  return (utc(b) - utc(a)) / DAY_MS;
}

// True when [start, end] is too short for an annualized figure to be meaningful.
export function isShortSpan(start: string, end: string): boolean {
  return daysBetween(start, end) < MIN_CAGR_DAYS;
}

// Suffix text for a windowed return: "YTD", "over 3 yrs", "since Mar 2021",
// "Jan 2023 – Jun 2024". `from` is the resolved window start and `seriesStart`
// is where THIS series' data actually begins inside the window.
export function periodLabel(range: PerfRange, from: string, to: string, seriesStart: string): string {
  // A young fund/account doesn't cover the whole window, so say where it began.
  if (daysBetween(from, seriesStart) > LATE_START_DAYS) return `since ${fmtMonthYear(seriesStart)}`;
  switch (range) {
    case 'YTD': return 'YTD';
    case '1Y': return 'over 1 yr';
    case '3Y': return 'over 3 yrs';
    case '5Y': return 'over 5 yrs';
    case 'ALL': return `since ${fmtMonthYear(from)}`;
    case 'custom': {
      const a = fmtMonthYear(from), b = fmtMonthYear(to);
      return a === b ? `in ${a}` : `${a} – ${b}`;
    }
  }
}
