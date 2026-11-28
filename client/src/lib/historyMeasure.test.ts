import { describe, it, expect } from 'vitest';
import {
  measureSpan, spanChange, indexChange, direction, fmtPctChange, fmtSpanChange, fmtSpanDates,
  describeMeasurement, type MeasurePoint,
} from './historyMeasure.ts';

const pt = (date: string, acc: number, re: number, index?: number | null): MeasurePoint =>
  ({ date, accounts_total: acc, real_estate_total: re, net_worth: acc + re, index });
const both = { showAccounts: true, showRealEstate: true, hasIndex: true };

const POINTS = [
  pt('2025-03-03', 600_000, 364_000, 964_000),
  pt('2025-09-01', 610_000, 370_000, 1_000_000),
  pt('2026-06-09', 612_340, 364_000, 1_060_000),
];

describe('measureSpan', () => {
  it('measures net worth, each part and the index between two points', () => {
    const m = measureSpan(POINTS, 0, 2, both)!;
    expect(m.startDate).toBe('2025-03-03');
    expect(m.endDate).toBe('2026-06-09');
    expect(m.netWorth).toEqual({ start: 964_000, end: 976_340, amount: 12_340, pct: 12_340 / 964_000 });
    expect(m.accounts?.amount).toBe(12_340);
    expect(m.realEstate).toEqual({ start: 364_000, end: 364_000, amount: 0, pct: 0 });
    expect(m.indexPct).toBeCloseTo(1_060_000 / 964_000 - 1, 12);
  });

  it('reports earlier → later when the ends are given right to left', () => {
    const fwd = measureSpan(POINTS, 0, 2, both);
    const rev = measureSpan(POINTS, 2, 0, both);
    expect(rev).toEqual(fwd);
    expect(rev?.startIndex).toBe(0);
    expect(rev?.endIndex).toBe(2);
  });

  it('measures nothing for the same point twice or an index off the ends', () => {
    expect(measureSpan(POINTS, 1, 1, both)).toBeNull();
    expect(measureSpan(POINTS, -1, 1, both)).toBeNull();
    expect(measureSpan(POINTS, 0, 3, both)).toBeNull();
    expect(measureSpan(POINTS, 0.5, 2, both)).toBeNull();
    expect(measureSpan([], 0, 1, both)).toBeNull();
  });

  it('leaves out a part that is switched off', () => {
    const m = measureSpan(POINTS, 0, 1, { ...both, showRealEstate: false })!;
    expect(m.realEstate).toBeNull();
    expect(m.accounts?.amount).toBe(10_000);
    const n = measureSpan(POINTS, 0, 1, { ...both, showAccounts: false })!;
    expect(n.accounts).toBeNull();
    expect(n.realEstate?.amount).toBe(6_000);
  });

  it('gives no index move without a comparison, or with a missing value', () => {
    expect(measureSpan(POINTS, 0, 2, { ...both, hasIndex: false })?.indexPct).toBeNull();
    const gappy = [pt('2026-01-01', 1, 0, null), pt('2026-01-02', 2, 0, 5)];
    expect(measureSpan(gappy, 0, 1, both)?.indexPct).toBeNull();
    const none = [pt('2026-01-01', 1, 0), pt('2026-01-02', 2, 0)];
    expect(measureSpan(none, 0, 1, both)?.indexPct).toBeNull();
  });
});

describe('spanChange', () => {
  it('is exact to the cent, whatever the float subtraction leaves', () => {
    expect(spanChange(0.1, 0.3).amount).toBe(0.2);
    expect(spanChange(1_000_000.07, 999_999.99).amount).toBe(-0.08);
  });
  it('signs a fall as negative', () => {
    const c = spanChange(200_000, 190_000);
    expect(c.amount).toBe(-10_000);
    expect(c.pct).toBeCloseTo(-0.05, 12);
  });
  it('has no percentage from a zero or negative start', () => {
    expect(spanChange(0, 5_000)).toEqual({ start: 0, end: 5_000, amount: 5_000, pct: null });
    expect(spanChange(-10_000, 5_000)).toEqual({ start: -10_000, end: 5_000, amount: 15_000, pct: null });
    expect(spanChange(-10_000, -12_000).pct).toBeNull();
  });
});

describe('indexChange', () => {
  it('is the ratio of the two values, so the rescaling factor cancels', () => {
    expect(indexChange(200, 210)).toBeCloseTo(0.05, 12);
    // A negative factor (net worth started below zero) scales both ends alike.
    expect(indexChange(-200, -210)).toBeCloseTo(0.05, 12);
  });
  it('is null for a zero, a sign change or a missing end', () => {
    expect(indexChange(0, 0)).toBeNull();
    expect(indexChange(-1, 1)).toBeNull();
    expect(indexChange(null, 1)).toBeNull();
    expect(indexChange(1, undefined)).toBeNull();
    expect(indexChange(1, NaN)).toBeNull();
  });
});

describe('formatting', () => {
  it('reads a change as money and its share of the start', () => {
    expect(fmtSpanChange(spanChange(964_000, 976_340))).toBe('+$12,340 (1.28%)');
    expect(fmtSpanChange(spanChange(200_000, 199_200))).toBe('−$800 (−0.40%)');
    expect(fmtSpanChange(spanChange(0, 5_000))).toBe('+$5,000');
    expect(fmtSpanChange(spanChange(-3_000, -4_000))).toBe('−$1,000');
  });
  it('never signs or colours a change that rounds to nothing', () => {
    expect(fmtSpanChange(spanChange(100_000, 100_000.2))).toBe('$0 (0.00%)');
    expect(fmtPctChange(-0.00001)).toBe('0.00%');
    expect(fmtPctChange(0.05)).toBe('+5.00%');
    expect(direction(0.4)).toBe('flat');
    expect(direction(-0.6)).toBe('down');
    expect(direction(12)).toBe('up');
  });
  it('writes the year once when both dates share it', () => {
    expect(fmtSpanDates({ startDate: '2026-03-03', endDate: '2026-06-09' })).toBe('Mar 3 – Jun 9, 2026');
    expect(fmtSpanDates({ startDate: '2025-03-03', endDate: '2026-06-09' })).toBe('Mar 3, 2025 – Jun 9, 2026');
  });
});

describe('describeMeasurement', () => {
  it('says it all in one sentence, deposits included', () => {
    const m = measureSpan(POINTS, 2, 0, both)!;
    expect(describeMeasurement(m, 'S&P 500')).toBe(
      'Net worth changed +$12,340 (1.28%) from Mar 3, 2025 to Jun 9, 2026. '
      + 'Accounts and assets +$12,340 (2.06%); home equity $0 (0.00%). '
      + 'S&P 500 +9.96% over the same dates. Includes deposits and withdrawals.',
    );
  });
  it('lists the parts only beside each other, and the index only when known', () => {
    // A switched-off part arrives as zeroes, with net worth the other part alone.
    const accOnly = POINTS.map(p => pt(p.date, p.accounts_total, 0, p.index));
    const m = measureSpan(accOnly, 0, 1, { showAccounts: true, showRealEstate: false, hasIndex: false })!;
    expect(describeMeasurement(m, 'S&P 500')).toBe(
      'Net worth changed +$10,000 (1.67%) from Mar 3, 2025 to Sep 1, 2025. Includes deposits and withdrawals.',
    );
  });
});
