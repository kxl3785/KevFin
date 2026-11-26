import { describe, it, expect } from 'vitest';
import { rangeBounds, windowSeries, fmtReturn, gapWords, percentTicks, fmtTick, DEFAULT_RANGE } from './perfWindow.ts';

describe('rangeBounds', () => {
  it('resolves each preset against the history end', () => {
    expect(rangeBounds(DEFAULT_RANGE, '2021-11-27', '2026-11-26')).toEqual(['2026-01-01', '2026-11-26']);
    expect(rangeBounds({ ...DEFAULT_RANGE, range: '1Y' }, '2021-11-27', '2026-11-26')).toEqual(['2025-11-26', '2026-11-26']);
    expect(rangeBounds({ ...DEFAULT_RANGE, range: 'ALL' }, '2021-11-27', '2026-11-26')).toEqual(['2021-11-27', '2026-11-26']);
  });
  it('falls back to the history ends for a blank custom range', () => {
    expect(rangeBounds({ range: 'custom', customFrom: '', customTo: '' }, '2021-11-27', '2026-11-26')).toEqual(['2021-11-27', '2026-11-26']);
    expect(rangeBounds({ range: 'custom', customFrom: '2024-01-01', customTo: '2024-06-30' }, '2021-11-27', '2026-11-26')).toEqual(['2024-01-01', '2024-06-30']);
  });
});

describe('windowSeries', () => {
  const pts = [
    { date: '2025-12-29', value: 90 },
    { date: '2026-01-05', value: 100 },
    { date: '2026-02-05', value: 95 },
    { date: '2026-03-05', value: 104.7 },
  ];
  it('re-bases to 0% at the first point in the window, in percent', () => {
    const w = windowSeries(pts, '2026-01-01', '2026-12-31')!;
    expect(w.points.map(p => p.value)).toEqual([0, -5, 4.7]);
    expect(w.totalReturn).toBeCloseTo(0.047, 10);
  });
  it('is null when nothing falls in the window', () => {
    expect(windowSeries(pts, '2027-01-01', '2027-12-31')).toBeNull();
  });
});

describe('formatting', () => {
  it('formats returns with a true minus and no "−0.0%"', () => {
    expect(fmtReturn(0.047)).toBe('+4.7%');
    expect(fmtReturn(-0.012)).toBe('−1.2%');
    expect(fmtReturn(-0.0001)).toBe('0.0%');
  });
  it('words the gap to a benchmark', () => {
    expect(gapWords(0.047, 0.057)).toBe('1.0 pts behind');
    expect(gapWords(0.08, 0.057)).toBe('2.3 pts ahead');
    expect(gapWords(0.05, 0.05)).toBe('level with it');
  });
  it('labels ticks as signed percents', () => {
    expect(fmtTick(0)).toBe('0%');
    expect(fmtTick(5)).toBe('+5%');
    expect(fmtTick(-2.5)).toBe('−2.5%');
  });
});

describe('percentTicks', () => {
  it('always includes a zero tick, with a round step', () => {
    const { ticks, domain } = percentTicks(-6, 14);
    expect(ticks).toContain(0);
    expect(domain[0]).toBeLessThanOrEqual(-6);
    expect(domain[1]).toBeGreaterThanOrEqual(14);
    expect(ticks[1] - ticks[0]).toBe(5);
  });
  it('includes zero even when every value is above it', () => {
    expect(percentTicks(3, 40).ticks[0]).toBe(0);
  });
  it('opens a window around a flat series', () => {
    const { ticks } = percentTicks(0, 0);
    expect(ticks.length).toBeGreaterThan(1);
    expect(ticks).toContain(0);
  });
});
