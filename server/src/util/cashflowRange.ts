// The date span a cash-flow range covers. The rolling keys ('1m', '3m', '6m',
// 'ytd', '12m') reach back from the current month and run to today; a calendar
// month ('YYYY-MM', picked in the Budget tab's month picker) covers just that
// month, so it has an end as well as a start. Anything else is all time.
// Bounds are ISO dates ('YYYY-MM-DD') compared as strings; `end` is inclusive.
export interface RangeBounds { start: string | null; end: string | null; label: string }

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function rangeBounds(range: string, now = new Date()): RangeBounds {
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  const iso = (dt: Date) => dt.toISOString().slice(0, 10);
  const month = MONTH_RE.exec(range);
  if (month) {
    const yy = Number(month[1]), mm = Number(month[2]);
    const label = new Date(Date.UTC(yy, mm - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    // Day 0 of the next month is this month's last day.
    return { start: iso(new Date(Date.UTC(yy, mm - 1, 1))), end: iso(new Date(Date.UTC(yy, mm, 0))), label };
  }
  switch (range) {
    case '1m': return { start: iso(new Date(Date.UTC(y, m, 1))), end: null, label: 'This month' };
    case '3m': return { start: iso(new Date(Date.UTC(y, m - 2, 1))), end: null, label: 'Last 3 months' };
    case '6m': return { start: iso(new Date(Date.UTC(y, m - 5, 1))), end: null, label: 'Last 6 months' };
    case 'ytd': return { start: iso(new Date(Date.UTC(y, 0, 1))), end: null, label: 'Year to date' };
    case '12m': return { start: iso(new Date(Date.UTC(y, m - 11, 1))), end: null, label: 'Last 12 months' };
    default: return { start: null, end: null, label: 'All time' };
  }
}

// Whether an ISO date falls inside the bounds.
export function inRange(date: string, b: Pick<RangeBounds, 'start' | 'end'>): boolean {
  return (!b.start || date >= b.start) && (!b.end || date <= b.end);
}
