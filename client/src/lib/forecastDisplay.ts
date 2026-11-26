import { MINUS } from './format.ts';
import { axisScale } from './axis.ts';

// Display helpers for the Forecast page: how figures are written (in the
// year-by-year table and in the number boxes), which table rows are shown, how
// far up the chart's y-axis goes and where the milestone pins sit. Pure and
// presentation-only — nothing here changes a simulated number.

// --- Money, three significant figures ------------------------------------------
// "$228k", "$1.08M", "$12.5M", "$950" — for the year-by-year table, where whole
// dollars made every column a wall of digits. Trailing zeros are dropped ("$97k",
// "$1M"), and a value that rounds up to the next unit moves to it ("$1M", never
// "$1000k").
export function fmtMoneyShort(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const units: [number, string][] = [[1e9, 'B'], [1e6, 'M'], [1e3, 'k']];
  let body = '';
  if (abs < 999.5) body = String(Math.round(abs));
  else {
    // Pick the unit, then round to 3 significant figures; a round-up past 1000
    // (999,999 → "1000k") steps to the next unit.
    let i = units.findIndex(([v]) => abs >= v);
    if (i < 0) i = units.length - 1; // 999.5 … 999.99 rounds to "$1k"
    let scaled = abs / units[i][0];
    const round3 = (x: number) => (x >= 100 ? Math.round(x) : x >= 10 ? Math.round(x * 10) / 10 : Math.round(x * 100) / 100);
    let r = round3(scaled);
    if (r >= 1000 && i > 0) { i -= 1; scaled = abs / units[i][0]; r = round3(scaled); }
    body = String(r) + units[i][1];
  }
  const sign = n < 0 && body !== '0' ? MINUS : '';
  return `${sign}$${body}`;
}

// --- Number boxes ------------------------------------------------------------------
// While a box is being edited it holds plain digits (the model value × `mul`,
// to two decimals); otherwise it shows the value written out: money with a $ and
// thousands separators, a percentage with its %, anything else (ages, years,
// counts) as the bare number — never with a $ or separators.
export type InputKind = 'money' | 'percent' | 'plain';

export function inputEditText(value: number, mul = 1): string {
  return String(Math.round(value * mul * 100) / 100);
}

export function inputDisplayText(value: number, mul = 1, kind: InputKind = 'plain'): string {
  const n = Math.round(value * mul * 100) / 100;
  if (kind === 'money') {
    const body = Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
    return `${n < 0 ? MINUS : ''}$${body}`;
  }
  if (kind === 'percent') return `${n < 0 ? MINUS : ''}${Math.abs(n)}%`;
  return n < 0 ? `${MINUS}${Math.abs(n)}` : String(n);
}

// --- Year-by-year table rows -----------------------------------------------------
// Indices of the yearly bands shown at `interval`: every interval-th year from
// today, the final year, and always the retirement year (a 5- or 10-year step
// would otherwise skip it).
export function tableRowIndices(ages: number[], interval: number, retireAge: number): number[] {
  const step = Math.max(1, Math.round(interval) || 1);
  const out: number[] = [];
  ages.forEach((age, i) => {
    if (i % step === 0 || i === ages.length - 1 || age === retireAge) out.push(i);
  });
  return out;
}

// --- Chart y-axis cap --------------------------------------------------------------
// The 10th–90th band fans out fast: at 90 its top can be several times the
// median, and an axis that fits it squeezes the median into the bottom third.
// When the band's top goes past `factor` × the median's highest point, the axis
// stops there (rounded to a tidy tick) and the band is clipped; the caller notes
// where the range really reaches. Null = no cap needed, keep the automatic axis.
export interface YCap { domain: [number, number]; ticks: number[] }
export function capYAxis(opts: { medianMax: number; rangeMax: number; min: number; factor?: number }): YCap | null {
  const { medianMax, rangeMax, min } = opts;
  const factor = opts.factor ?? 1.25;
  if (!(medianMax > 0) || !Number.isFinite(rangeMax) || !Number.isFinite(min)) return null;
  // A $0 floor (the band's areas stack from it), unless the low end dips below.
  const s = axisScale(Math.min(0, min), medianMax * factor, { zeroBased: min >= 0 });
  if (rangeMax <= s.domain[1]) return null; // the whole band already fits
  return { domain: s.domain, ticks: s.ticks };
}

// --- Milestone pins ----------------------------------------------------------------
// Pins sit on a lane under the plot at their age's x, but two pins can't overlap:
// each is pushed right of its neighbour by at least `gap` px, then the row is
// pushed back left from `hi` if it ran off the end (and never left of `lo`).
// `xs` must be sorted ascending; returns the drawn x for each.
export function layoutPins(xs: number[], gap: number, lo: number, hi: number): number[] {
  const out = xs.map(x => Math.min(hi, Math.max(lo, x)));
  for (let i = 1; i < out.length; i++) out[i] = Math.max(out[i], out[i - 1] + gap);
  if (out.length && out[out.length - 1] > hi) {
    out[out.length - 1] = hi;
    for (let i = out.length - 2; i >= 0; i--) out[i] = Math.min(out[i], out[i + 1] - gap);
  }
  // A row too long for the lane: spread evenly rather than stack past the start.
  if (out.length && out[0] < lo) {
    const span = out.length > 1 ? (hi - lo) / (out.length - 1) : 0;
    return out.map((_, i) => lo + i * span);
  }
  return out;
}
