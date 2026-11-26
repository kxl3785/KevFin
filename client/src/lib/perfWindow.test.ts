import { describe, it, expect } from 'vitest';
import {
  rangeBounds, windowSeries, fmtReturn, gapWords, percentTicks, fmtTick, DEFAULT_RANGE, firstDateIn, commonStart, compareWindow,
} from './perfWindow.ts';

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

describe('comparing from a common start', () => {
  // Weekly points on one grid, as the server sends them: your series starts on
  // Nov 27, the S&P 500 (no price yet that week) a week later.
  const mine = [
    { date: '2021-11-20', value: 95 },
    { date: '2021-11-27', value: 100 },
    { date: '2021-12-04', value: 110 },
    { date: '2026-11-21', value: 165 },
  ];
  const spy = [
    { date: '2021-12-04', value: 100 },
    { date: '2026-11-21', value: 160 },
  ];
  const [from, to] = ['2021-11-26', '2026-11-26'];

  it('finds each first date and the latest of them', () => {
    expect(firstDateIn(mine, from, to)).toBe('2021-11-27');
    expect(commonStart([mine, spy], from, to)).toBe('2021-12-04');
    expect(commonStart([mine, []], from, to)).toBe('2021-11-27');
    expect(commonStart([], from, to)).toBeNull();
  });
  it('measures both returns from the later start, and says it moved', () => {
    const c = compareWindow(mine, spy, from, to)!;
    expect(c.start).toBe('2021-12-04');
    expect(c.late).toBe(true);
    expect(c.mine.points[0]).toEqual({ date: '2021-12-04', value: 0 });
    expect(c.mine.totalReturn).toBeCloseTo(165 / 110 - 1, 10);
    expect(c.bench!.totalReturn).toBeCloseTo(0.6, 10);
    // Each from its own start would have read +65.0% vs +60.0%: 5 pts ahead,
    // where over the same days it is 10 pts behind.
    expect(gapWords(c.mine.totalReturn, c.bench!.totalReturn)).toBe('10.0 pts behind');
    expect(gapWords(windowSeries(mine, from, to)!.totalReturn, windowSeries(spy, from, to)!.totalReturn)).toBe('5.0 pts ahead');
  });
  it('keeps your own start when the benchmark starts first or is missing', () => {
    const early = [{ date: '2021-11-27', value: 50 }, { date: '2026-11-21', value: 80 }];
    const c = compareWindow(mine, early, from, to)!;
    expect(c.start).toBe('2021-11-27');
    expect(c.late).toBe(false);
    const alone = compareWindow(mine, null, from, to)!;
    expect(alone.bench).toBeNull();
    expect(alone.late).toBe(false);
    expect(alone.mine.totalReturn).toBeCloseTo(0.65, 10);
  });
  it('falls back to your own start when the benchmark begins after your last point', () => {
    const c = compareWindow(mine.slice(0, 3), spy.slice(1), from, to)!;
    expect(c.bench).toBeNull();
    expect(c.start).toBe('2021-11-27');
  });
  it('is null when your series has nothing in the window', () => {
    expect(compareWindow(mine, spy, '2027-01-01', '2027-12-31')).toBeNull();
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
    // Shown as +43.3% and +44.7%: the gap a reader works out is 1.4, though the
    // unrounded returns differ by 1.45.
    expect(gapWords(0.43325, 0.44775)).toBe('1.4 pts behind');
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
  it('fits the domain to the data rather than rounding out a whole step', () => {
    // The tester's 5Y chart: −23%…+84% had drawn as −50%…+100%.
    const { domain, ticks } = percentTicks(-23, 84);
    expect(domain[0]).toBeLessThanOrEqual(-23);
    expect(domain[0]).toBeGreaterThan(-35);
    expect(domain[1]).toBeGreaterThanOrEqual(84);
    expect(domain[1]).toBeLessThan(95);
    expect(ticks).toEqual([-25, 0, 25, 50, 75]);
    // Every tick sits inside the domain.
    expect(ticks.every(t => t >= domain[0] && t <= domain[1])).toBe(true);
  });
  it('opens a window around a flat series', () => {
    const { ticks } = percentTicks(0, 0);
    expect(ticks.length).toBeGreaterThan(1);
    expect(ticks).toContain(0);
  });
});
