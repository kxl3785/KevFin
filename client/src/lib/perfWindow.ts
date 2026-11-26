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
// points) that always includes 0, so the zero line is a labelled tick.
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
  const start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  const count = Math.round((end - start) / step);
  // By index, not repeated addition, so 2.5-point steps never drift.
  for (let i = 0; i <= count && ticks.length <= 24; i++) ticks.push(Number((start + i * step).toFixed(6)));
  return { domain: [start, end], ticks };
}

// "+5%" / "0%" / "−5%" / "+2.5%" for an axis tick.
export function fmtTick(v: number): string {
  if (Math.abs(v) < 1e-9) return '0%';
  const s = Number(Math.abs(v).toFixed(1)).toString();
  return `${v > 0 ? '+' : '−'}${s}%`;
}
