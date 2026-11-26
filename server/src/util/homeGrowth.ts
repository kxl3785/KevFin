// A home's own yearly growth rate, read off its value history: the compound
// annual rate between its value some years ago and its latest value. Pure and
// dependency-free; services/homeGrowth.ts decides which history to feed it.

export interface ValuePoint { date: string; value: number }

export interface TrailingGrowth {
  /** Compound annual growth as a fraction (0.05 = 5% a year). Can be negative. */
  rate: number;
  /** Length of the period actually measured, in years (≤ the window asked for). */
  years: number;
  /** First and last dates of that period (YYYY-MM-DD). */
  from: string;
  to: string;
}

/** The trailing window a home's growth is measured over. */
export const GROWTH_WINDOW_YEARS = 5;
// Under a year of history, one seasonal swing or a single re-estimate would be
// annualised into a rate that says nothing about the home.
export const MIN_GROWTH_YEARS = 1;

const DAY_MS = 86_400_000;
const YEAR_DAYS = 365.25;
const dayNum = (d: string) => Date.parse(d + 'T00:00:00Z') / DAY_MS;
const isoDay = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10);

// The date `years` calendar years before `date`. Feb 29 lands on Feb 28.
function yearsBefore(date: string, years: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const out = new Date(Date.UTC(y - years, m - 1, d));
  if (out.getUTCMonth() !== m - 1) out.setUTCDate(0); // rolled into March → last day of Feb
  return out.toISOString().slice(0, 10);
}

/**
 * Compound annual growth over the last `windowYears` of a value series.
 *
 * The period ends at the newest point. It starts `windowYears` earlier, at a
 * value linearly interpolated between the two points around that date (the
 * same interpolation the net-worth backfill draws the home's curve with). A
 * series that doesn't reach back that far is measured from its first point
 * instead, and `years` says how long that was.
 *
 * Returns null when there is no usable period: fewer than two valid points, or
 * less than `minYears` between the start and the end.
 */
export function trailingGrowth(
  points: ValuePoint[],
  windowYears = GROWTH_WINDOW_YEARS,
  minYears = MIN_GROWTH_YEARS,
): TrailingGrowth | null {
  const pts = points
    .filter(p => /^\d{4}-\d{2}-\d{2}$/.test(p.date) && Number.isFinite(dayNum(p.date)) && Number.isFinite(p.value) && p.value > 0)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (pts.length < 2) return null;

  const end = pts[pts.length - 1];
  const target = yearsBefore(end.date, windowYears);

  let from: string;
  let startValue: number;
  if (pts[0].date >= target) {
    // History is shorter than the window: measure what there is.
    from = pts[0].date;
    startValue = pts[0].value;
  } else {
    // First point after the target date; the one before it is at or before the target.
    const k = pts.findIndex(p => p.date > target);
    const a = pts[k - 1], b = pts[k];
    const f = (dayNum(target) - dayNum(a.date)) / (dayNum(b.date) - dayNum(a.date));
    from = isoDay(dayNum(target));
    startValue = a.value + (b.value - a.value) * f;
  }

  const years = (dayNum(end.date) - dayNum(from)) / YEAR_DAYS;
  if (!(years >= minYears) || !(startValue > 0)) return null;
  const rate = Math.pow(end.value / startValue, 1 / years) - 1;
  if (!Number.isFinite(rate)) return null;
  return { rate, years, from, to: end.date };
}
