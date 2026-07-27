// Axis scaling helpers for the dashboard charts.
//
// The goal is a y-axis that makes real movement visible. A fixed $100k grid
// step does the opposite at both ends of the range: on a $40k portfolio every
// point sits crushed against the bottom of a single $0–$100k band, and on a
// $2M one a $60k month is a barely-perceptible wiggle inside a 100k-tall cell.
// So the step is derived from the span actually on screen, and the padding is a
// fraction of that span rather than of the absolute balance.

/** Round `rough` up to the nearest 1 / 2 / 2.5 / 5 × 10ⁿ — the steps that read
 *  as "round money" on an axis. */
export function niceStep(rough: number): number {
  if (!(rough > 0) || !Number.isFinite(rough)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  const mult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return mult * mag;
}

export interface AxisScale {
  domain: [number, number];
  ticks: number[];
  step: number;
}

/**
 * A rounded domain plus the tick values that land on it.
 *
 * @param min         smallest value that will be drawn
 * @param max         largest value that will be drawn
 * @param zeroBased   pin the low end to 0 (stacked areas need a $0 baseline)
 * @param targetTicks roughly how many intervals to aim for
 */
export function axisScale(
  min: number,
  max: number,
  { zeroBased = false, targetTicks = 5 }: { zeroBased?: boolean; targetTicks?: number } = {},
): AxisScale {
  // Empty/garbage input still has to produce a drawable axis.
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { domain: [0, 1], ticks: [0, 1], step: 1 };
  if (min > max) [min, max] = [max, min];
  if (zeroBased) min = Math.min(0, min);

  // A dead-flat series (one snapshot, or no change yet) has no span to scale
  // to — open a window around the value so it doesn't divide by zero below.
  if (max === min) {
    const pad = Math.max(Math.abs(max) * 0.1, 1);
    max += pad;
    if (!zeroBased) min -= pad;
  }

  // Breathing room as a share of the visible span, so the line never touches
  // the frame and the zoom stays honest at any portfolio size.
  const pad = (max - min) * 0.08;
  const lo = zeroBased ? min : min - pad;
  const hi = max + pad;

  const step = niceStep((hi - lo) / Math.max(1, targetTicks));
  const start = zeroBased ? 0 : Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;

  const ticks: number[] = [];
  // Accumulate by index rather than by repeated addition — 2.5e4-style steps
  // otherwise drift into 74999.99999 and print as the wrong round number.
  const count = Math.round((end - start) / step);
  for (let i = 0; i <= count && ticks.length <= 24; i++) ticks.push(start + i * step);

  return { domain: [start, end], ticks, step };
}

/**
 * Compact money for an axis tick — "$1.25M", "$750k", "$0", "-$40k".
 * Decimals come from the step, so a $250k grid reads 1.25M / 1.50M rather than
 * collapsing both to "1.3M".
 */
export function fmtAxisMoney(v: number, step = 1): string {
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  if (a < 0.5) return '$0'; // exact zero, and anything that rounds to it
  const unit = a >= 1_000_000 ? 1_000_000 : a >= 1_000 ? 1_000 : 1;
  const suffix = unit === 1_000_000 ? 'M' : unit === 1_000 ? 'k' : '';

  // Enough decimals to render the step exactly (0.25 → 2, 0.5 → 1, 1 → 0).
  let d = 0;
  const s = Math.abs(step) / unit;
  while (d < 2 && Math.abs(s * 10 ** d - Math.round(s * 10 ** d)) > 1e-9) d++;

  return `${sign}$${(a / unit).toFixed(unit === 1 ? 0 : d)}${suffix}`;
}

/**
 * X-axis ticks for a date series: at most `maxTicks` dates whose labels are all
 * distinct. Recharts picks ticks by index, so a dense series happily renders
 * "26-03" twice in a row; bucketing by the label first makes that impossible.
 */
export function dateTicks(dates: string[], maxTicks = 7): { ticks: string[]; label: (d: string) => string } {
  const label = pickDateLabeller(dates);
  if (dates.length === 0) return { ticks: [], label };

  // First date of each distinct label — one tick per month/quarter/year.
  const firsts: string[] = [];
  let prev = '';
  for (const d of dates) {
    const l = label(d);
    if (l !== prev) { firsts.push(d); prev = l; }
  }

  if (firsts.length <= maxTicks) return { ticks: firsts, label };
  // Thin evenly, always keeping the first and last bucket.
  const out: string[] = [];
  for (let i = 0; i < maxTicks; i++) {
    out.push(firsts[Math.round((i * (firsts.length - 1)) / (maxTicks - 1))]);
  }
  return { ticks: [...new Set(out)], label };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Granularity follows the window: months for up to ~2 years, then years. Dates
// are plain 'YYYY-MM-DD' calendar strings — sliced, never Date-parsed, so no
// timezone can shift a label into the neighbouring month.
function pickDateLabeller(dates: string[]): (d: string) => string {
  if (dates.length === 0) return d => d;
  const first = dates[0], last = dates[dates.length - 1];
  const months =
    (Number(last.slice(0, 4)) - Number(first.slice(0, 4))) * 12 +
    (Number(last.slice(5, 7)) - Number(first.slice(5, 7)));

  if (months > 24) return d => d.slice(0, 4);
  return d => `${MONTHS[Number(d.slice(5, 7)) - 1] ?? '?'} ’${d.slice(2, 4)}`;
}
