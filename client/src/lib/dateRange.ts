// Chart range windows for the dashboard.
//
// Date.setMonth() overflows when the current day doesn't exist in the target
// month: on March 31, setMonth(month - 1) lands on "February 31", which the
// runtime rolls forward to March 3 — so the "1M" button showed a 28-day window,
// and "3M" on May 31 showed two months and change. Every shift here clamps to
// the last valid day of the target month instead.

export type RangeKey = '1M' | '3M' | '6M' | 'YTD' | '1Y' | '3Y' | '5Y' | 'ALL';
export const RANGES: RangeKey[] = ['1M', '3M', '6M', 'YTD', '1Y', '3Y', '5Y', 'ALL'];

const daysIn = (year: number, monthIdx: number) => new Date(year, monthIdx + 1, 0).getDate();

/** `from` shifted back `months` whole months, clamped to the target month's end. */
export function monthsBefore(from: Date, months: number): Date {
  const day = from.getDate();
  const out = new Date(from);
  out.setDate(1); // park on a day every month has, so the month shift can't roll over
  out.setMonth(out.getMonth() - months);
  out.setDate(Math.min(day, daysIn(out.getFullYear(), out.getMonth())));
  return out;
}

// Snapshots are plain local calendar dates, so format from local components —
// toISOString() would shift the cutoff a day for anyone west of UTC.
function iso(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Earliest 'YYYY-MM-DD' to include for a given range ('' = no lower bound). */
export function rangeCutoff(range: RangeKey, now: Date = new Date()): string {
  switch (range) {
    case 'ALL': return '';
    case 'YTD': return `${now.getFullYear()}-01-01`;
    case '1M': return iso(monthsBefore(now, 1));
    case '3M': return iso(monthsBefore(now, 3));
    case '6M': return iso(monthsBefore(now, 6));
    // Year shifts hit the same trap on Feb 29 — go through the month path so a
    // leap day clamps to Feb 28 rather than rolling into March.
    case '1Y': return iso(monthsBefore(now, 12));
    case '3Y': return iso(monthsBefore(now, 36));
    case '5Y': return iso(monthsBefore(now, 60));
  }
}
