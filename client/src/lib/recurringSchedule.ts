// When a recurring bill is next expected, and whether its latest charge came in
// above the usual amount. Worked out from the charges behind each item (the
// detector sends its recent history), so the Recurring tab can show a "Next"
// date and flag a bill that went up.

const iso = (y: number, m0: number, d: number) => {
  // Clamp the day to the target month's length (Jan 31 + 1 month → Feb 28/29).
  const last = new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m0, Math.min(d, last))).toISOString().slice(0, 10);
};
const monthIndex = (date: string) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;

// The billing cycle in whole months: 12 for an annual bill, otherwise the median
// gap between the distinct months it was charged in (at least 1). null with a
// single charge and nothing saying it's annual, since there's no cycle to read.
export function billingCycleMonths(dates: string[], annual = false): number | null {
  if (annual) return 12;
  const months = [...new Set(dates.map(monthIndex))].sort((a, b) => a - b);
  if (months.length < 2) return null;
  const gaps = months.slice(1).map((m, i) => m - months[i]).sort((a, b) => a - b);
  const mid = gaps.length >> 1;
  const median = gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
  return Math.max(1, Math.round(median));
}

// The next expected charge: the latest charge's day of the month, one cycle on.
// `late` marks a date more than a week in the past (the charge hasn't shown up,
// or the bill has stopped). null when there's no cycle to go on.
export function nextChargeDate(dates: string[], annual: boolean, today: string): { date: string; late: boolean } | null {
  if (!dates.length) return null;
  const cycle = billingCycleMonths(dates, annual);
  if (cycle == null) return null;
  const last = dates.reduce((a, b) => (b > a ? b : a));
  const y = Number(last.slice(0, 4)), m0 = Number(last.slice(5, 7)) - 1, d = Number(last.slice(8, 10));
  const date = iso(y, m0 + cycle, d);
  const weekAgo = new Date(Date.parse(today + 'T00:00:00Z') - 7 * 86400_000).toISOString().slice(0, 10);
  return { date, late: date < weekAgo };
}

// Whether the latest charge came in clearly above the usual amount. "Usual" is
// the figure the row shows in its Usually column when the caller passes it (so
// the flag and the column agree on screen); otherwise the median of the (up to
// six) charges before the last. Needs two earlier charges to know what "usual"
// is, and flags a rise of at least 10% and at least $2, so ordinary cents-level
// wobble on a utility bill isn't called out.
export const RISE_MIN_PCT = 0.1;
export const RISE_MIN_DOLLARS = 2;
export function lastChargeRise(charges: { date: string; amount: number }[], shownUsual?: number): { usual: number; last: number; pct: number } | null {
  if (charges.length < 3) return null;
  const sorted = charges.slice().sort((a, b) => a.date.localeCompare(b.date));
  const last = Math.abs(sorted[sorted.length - 1].amount);
  const prior = sorted.slice(-7, -1).map(c => Math.abs(c.amount)).sort((a, b) => a - b);
  const mid = prior.length >> 1;
  const median = prior.length % 2 ? prior[mid] : (prior[mid - 1] + prior[mid]) / 2;
  const usual = shownUsual != null && shownUsual > 0 ? shownUsual : median;
  if (!(usual > 0)) return null;
  const pct = (last - usual) / usual;
  return pct >= RISE_MIN_PCT && last - usual >= RISE_MIN_DOLLARS ? { usual, last, pct } : null;
}
