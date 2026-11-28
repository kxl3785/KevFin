// Pure helpers behind the History chart's drag-to-measure: given the chart's
// points (oldest first) and the two points under the pointer, how net worth and
// each switched-on part moved between them, and how the comparison index moved.
// Kept free of React so the sign, rounding and zero-start edges are tested.
//
// What the figure is: a change in net worth, which includes money paid in or
// taken out. It is not an investment return, so nothing here calls it one.

import { fmtMoney, fmtDate, MINUS } from './format.ts';

export interface MeasurePoint {
  date: string;
  accounts_total: number;
  real_estate_total: number;
  net_worth: number;
  /** The comparison index, rescaled by the Dashboard to start at net worth. */
  index?: number | null;
}

export interface SpanChange {
  start: number;
  end: number;
  /** end − start, to the cent (float subtraction can leave ...0000001 tails). */
  amount: number;
  /** Fraction of the starting value (0.0128 = 1.28%); null when the start is zero or negative. */
  pct: number | null;
}

export interface Measurement {
  /** Always earlier → later, whichever way the pointer moved. */
  startIndex: number;
  endIndex: number;
  startDate: string;
  endDate: string;
  netWorth: SpanChange;
  /** Null for a part that is switched off (the Dashboard passes it as zeroes). */
  accounts: SpanChange | null;
  realEstate: SpanChange | null;
  /** The comparison index's own percentage move over the same dates, or null. */
  indexPct: number | null;
}

const cents = (n: number) => Math.round(n * 100) / 100;

export function spanChange(start: number, end: number): SpanChange {
  const amount = cents(end - start);
  // A percentage of a zero or negative base means nothing (−$10k → +$5k is not
  // "−150%"), so only a positive start gets one — the same rule as the KPI chips.
  return { start, end, amount, pct: start > 0 ? (end - start) / start : null };
}

/**
 * The index line is drawn as close × factor, with factor = the range's first net
 * worth ÷ the first close, so the two start together. The factor cancels in a
 * ratio: index[b] / index[a] = close[b] / close[a], the index's own move (its
 * closes are dividend-adjusted, so a total return). That holds for a negative
 * factor too; a zero factor (net worth started at $0) or a missing value leaves
 * nothing true to say, so it's null then.
 */
export function indexChange(a: number | null | undefined, b: number | null | undefined): number | null {
  if (typeof a !== 'number' || typeof b !== 'number' || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (a === 0 || a * b <= 0) return null;
  return b / a - 1;
}

/**
 * The measurement between points `i` and `j` (either order). Null when they are
 * the same point or either is out of range, so a click never measures nothing.
 */
export function measureSpan(
  points: MeasurePoint[],
  i: number,
  j: number,
  opts: { showAccounts: boolean; showRealEstate: boolean; hasIndex: boolean },
): Measurement | null {
  if (!Number.isInteger(i) || !Number.isInteger(j) || i === j) return null;
  const lo = Math.min(i, j), hi = Math.max(i, j);
  if (lo < 0 || hi >= points.length) return null;
  const a = points[lo], b = points[hi];
  return {
    startIndex: lo,
    endIndex: hi,
    startDate: a.date,
    endDate: b.date,
    netWorth: spanChange(a.net_worth, b.net_worth),
    accounts: opts.showAccounts ? spanChange(a.accounts_total, b.accounts_total) : null,
    realEstate: opts.showRealEstate ? spanChange(a.real_estate_total, b.real_estate_total) : null,
    indexPct: opts.hasIndex ? indexChange(a.index, b.index) : null,
  };
}

/** Which way a change reads: by the whole dollars shown, so "$0" is never green or red. */
export function direction(amount: number): 'up' | 'down' | 'flat' {
  const r = Math.round(amount);
  return r > 0 ? 'up' : r < 0 ? 'down' : 'flat';
}

/** "+1.28%" / "−0.40%" / "0.00%" (no sign on a move that rounds to nothing). */
export function fmtPctChange(p: number): string {
  const body = (Math.abs(p) * 100).toFixed(2);
  if (Number(body) === 0) return '0.00%';
  return `${p < 0 ? MINUS : '+'}${body}%`;
}

/** "+$12,340 (1.28%)", or "+$12,340" alone when there's no percentage. */
export function fmtSpanChange(c: SpanChange): string {
  const money = fmtMoney(c.amount, { sign: true });
  return c.pct == null ? money : `${money} (${fmtPctChange(c.pct).replace(/^\+/, '')})`;
}

/** "Mar 3, 2025 – Jun 9, 2026"; the year once when both ends share it. */
export function fmtSpanDates(m: Pick<Measurement, 'startDate' | 'endDate'>): string {
  const sameYear = m.startDate.slice(0, 4) === m.endDate.slice(0, 4);
  return `${fmtDate(m.startDate, { year: !sameYear })} – ${fmtDate(m.endDate)}`;
}

/** The whole measurement as one sentence, for the screen-reader announcement. */
export function describeMeasurement(m: Measurement, indexLabel?: string): string {
  const parts: string[] = [
    `Net worth changed ${fmtSpanChange(m.netWorth)} from ${fmtDate(m.startDate)} to ${fmtDate(m.endDate)}.`,
  ];
  // A lone switched-on part is the net worth itself, so it's only listed beside the other.
  if (m.accounts && m.realEstate) {
    parts.push(`Accounts and assets ${fmtSpanChange(m.accounts)}; home equity ${fmtSpanChange(m.realEstate)}.`);
  }
  if (indexLabel && m.indexPct != null) parts.push(`${indexLabel} ${fmtPctChange(m.indexPct)} over the same dates.`);
  parts.push('Includes deposits and withdrawals.');
  return parts.join(' ');
}
