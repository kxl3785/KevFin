// Windowing maths for the Investments page's performance chart
// (components/PerformanceChart.tsx) and the "Return" headline tile above it.
// The whole history is fetched once; a range is applied here, client-side, so
// switching is instant and the chart and the tile always read the same window.
// Pure and dependency-free (perfWindow.test.ts).

export interface PerfPoint { date: string; value: number }

export type RangeKey = 'YTD' | '1Y' | '3Y' | '5Y' | 'ALL' | 'custom';

// The range selection the chart and the tile share.
export interface PerfRange { range: RangeKey; customFrom: string; customTo: string }
export const DEFAULT_RANGE: PerfRange = { range: 'YTD', customFrom: '', customTo: '' };

export function computeCagr(startVal: number, endVal: number, days: number): number {
  if (startVal <= 0 || endVal <= 0 || days <= 0) return 0;
  return Math.pow(endVal / startVal, 365 / days) - 1;
}

// The [from, to] dates (YYYY-MM-DD) a range covers, given the history's own
// first and last dates. Custom dates fall back to the history's ends.
export function rangeBounds(sel: PerfRange, startDate: string | undefined, endDate: string | undefined, today = new Date().toISOString().slice(0, 10)): [string, string] {
  const end = endDate ?? today;
  if (sel.range === 'custom') return [sel.customFrom || startDate || end, sel.customTo || end];
  if (sel.range === 'ALL') return [startDate ?? '0000-01-01', end];
  if (sel.range === 'YTD') return [`${end.slice(0, 4)}-01-01`, end];
  const back = sel.range === '1Y' ? 365 : sel.range === '3Y' ? 1095 : 1825;
  const d = new Date(end + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - back);
  return [d.toISOString().slice(0, 10), end];
}

export interface Windowed {
  // Percent return since the window's first point: 0 there, 4.7 for +4.7%.
  points: PerfPoint[];
  cagr: number;          // annualised, as a fraction
  totalReturn: number;   // over the window, as a fraction
}

// Re-base one series to 0% at its first point inside [from, to] and recompute
// its return stats for that window, so every range / custom selection is honest.
// Percent points are kept to two decimals (the chart's precision).
export function windowSeries(points: PerfPoint[], from: string, to: string): Windowed | null {
  const pts = points.filter(p => p.date >= from && p.date <= to);
  if (pts.length === 0) return null;
  const base = pts[0].value || 1;
  const rel = pts.map(p => p.value / base);
  const out = pts.map((p, i) => ({ date: p.date, value: Math.round((rel[i] - 1) * 10000) / 100 }));
  const last = rel[rel.length - 1];
  const spanDays = (Date.parse(pts[pts.length - 1].date) - Date.parse(pts[0].date)) / 86_400_000;
  return { points: out, cagr: computeCagr(1, last, spanDays), totalReturn: last - 1 };
}

// The first date a series has inside [from, to], or null when it has none.
export function firstDateIn(points: PerfPoint[], from: string, to: string): string | null {
  for (const p of points) if (p.date >= from && p.date <= to) return p.date;
  return null;
}

// Where several series can be compared from: the LATEST of their first dates
// inside [from, to] (series with no data there are ignored). Re-basing every
// line at this one date means "N pts ahead / behind" measures both over the
// same days; the S&P 500's history can begin a week after your own does, and a
// week of market moves is enough to swing the gap. null when none has data.
export function commonStart(series: PerfPoint[][], from: string, to: string): string | null {
  let start: string | null = null;
  for (const pts of series) {
    const f = firstDateIn(pts, from, to);
    if (f && (!start || f > start)) start = f;
  }
  return start;
}

export interface Comparison {
  start: string;              // the common start both returns are measured from
  mine: Windowed;
  bench: Windowed | null;     // null when the benchmark has nothing in the window
  // true when the benchmark starts later than your own series does in this
  // window, so `mine` is measured from a later date than the range alone gives.
  late: boolean;
}

// Your return and a benchmark's over the same days of [from, to]: both
// re-based at their common start. Without a benchmark (or when it has nothing
// in the window) your series keeps its own start.
export function compareWindow(mine: PerfPoint[], bench: PerfPoint[] | null, from: string, to: string): Comparison | null {
  const own = firstDateIn(mine, from, to);
  if (!own) return null;
  const start = (bench && commonStart([mine, bench], from, to)) || own;
  const m = windowSeries(mine, start, to);
  const b = bench ? windowSeries(bench, start, to) : null;
  // A benchmark that starts after your last point leaves nothing in common.
  if (!m) return { start: own, mine: windowSeries(mine, own, to)!, bench: null, late: false };
  return { start, mine: m, bench: b, late: start > own };
}

// "+4.7%" / "−1.2%" / "0.0%" (true minus sign).
export function fmtReturn(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const v = n * 100;
  const s = Math.abs(v).toFixed(1);
  return s === '0.0' ? '0.0%' : `${v > 0 ? '+' : '−'}${s}%`;
}

// "1.0 pts behind" / "2.3 pts ahead" / "level with": your return against a
// benchmark's over the same window, in percentage points.
export function gapWords(mine: number, bench: number): string {
  const gap = (mine - bench) * 100;
  const n = Math.abs(gap).toFixed(1);
  if (n === '0.0') return 'level with it';
  return `${n} pts ${gap > 0 ? 'ahead' : 'behind'}`;
}

// Percent-return ticks for the chart's y-axis: a round step (1, 2, 2.5, 5 × 10ⁿ
// points) that always includes 0, so the zero line is a labelled tick. The
// domain is the data plus a little headroom, not rounded out to whole steps:
// rounding out let −23%…+84% become an axis of −50%…+100%, a third of it empty.
export function percentTicks(min: number, max: number, target = 5): { domain: [number, number]; ticks: number[] } {
  let lo = Math.min(0, Number.isFinite(min) ? min : 0);
  let hi = Math.max(0, Number.isFinite(max) ? max : 0);
  if (hi - lo < 1) { lo -= 0.5; hi += 0.5; }
  const pad = (hi - lo) * 0.06;
  lo -= lo < 0 ? pad : 0;
  hi += pad;
  const rough = (hi - lo) / Math.max(1, target);
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  // Ticks are the step's multiples inside the domain (0 always is one).
  const first = Math.ceil(lo / step - 1e-9);
  const last = Math.floor(hi / step + 1e-9);
  const ticks: number[] = [];
  // By index, not repeated addition, so 2.5-point steps never drift.
  for (let i = first; i <= last && ticks.length <= 24; i++) ticks.push(Number((i * step).toFixed(6)));
  const round = (n: number) => Number(n.toFixed(6));
  return { domain: [round(lo), round(hi)], ticks };
}

// "+5%" / "0%" / "−5%" / "+2.5%" for an axis tick.
export function fmtTick(v: number): string {
  if (Math.abs(v) < 1e-9) return '0%';
  const s = Number(Math.abs(v).toFixed(1)).toString();
  return `${v > 0 ? '+' : '−'}${s}%`;
}
