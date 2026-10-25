import { describe, it, expect } from 'vitest';
import { periodLabel, isShortSpan, fmtFullDate, daysBetween } from './periodLabel.ts';

describe('periodLabel', () => {
  it('labels presets by their length', () => {
    expect(periodLabel('YTD', '2026-01-01', '2026-10-24', '2026-01-02')).toBe('YTD');
    expect(periodLabel('1Y', '2025-10-24', '2026-10-24', '2025-10-24')).toBe('over 1 yr');
    expect(periodLabel('3Y', '2023-10-24', '2026-10-24', '2023-10-24')).toBe('over 3 yrs');
    expect(periodLabel('5Y', '2021-10-24', '2026-10-24', '2021-10-25')).toBe('over 5 yrs');
  });

  it('ALL reads "since" the window start month', () => {
    expect(periodLabel('ALL', '2021-03-15', '2026-10-24', '2021-03-15')).toBe('since Mar 2021');
  });

  it('custom shows the month span, or "in" for a single month', () => {
    expect(periodLabel('custom', '2023-01-05', '2024-06-20', '2023-01-05')).toBe('Jan 2023 – Jun 2024');
    expect(periodLabel('custom', '2024-06-03', '2024-06-28', '2024-06-03')).toBe('in Jun 2024');
  });

  it('a series that starts materially late says "since" its own start, whatever the range', () => {
    expect(periodLabel('5Y', '2021-10-24', '2026-10-24', '2023-04-10')).toBe('since Apr 2023');
    expect(periodLabel('YTD', '2026-01-01', '2026-10-24', '2026-03-02')).toBe('since Mar 2026');
    expect(periodLabel('custom', '2020-01-01', '2024-01-01', '2021-03-15')).toBe('since Mar 2021');
  });

  it('tolerates a start up to 7 days after the window start, but not 8', () => {
    expect(periodLabel('1Y', '2025-10-24', '2026-10-24', '2025-10-31')).toBe('over 1 yr');
    expect(periodLabel('1Y', '2025-10-24', '2026-10-24', '2025-11-01')).toBe('since Nov 2025');
  });

  it('does not shift month for dates on the 1st or last day (UTC parsing)', () => {
    expect(periodLabel('ALL', '2021-03-01', '2026-10-24', '2021-03-01')).toBe('since Mar 2021');
    expect(periodLabel('custom', '2021-01-01', '2021-12-31', '2021-01-01')).toBe('Jan 2021 – Dec 2021');
  });
});

describe('fmtFullDate / daysBetween', () => {
  it('formats exact dates', () => {
    expect(fmtFullDate('2021-03-05')).toBe('Mar 5, 2021');
    expect(fmtFullDate('2026-01-01')).toBe('Jan 1, 2026');
  });
  it('counts whole days', () => {
    expect(daysBetween('2026-01-01', '2026-01-31')).toBe(30);
    expect(daysBetween('2025-10-24', '2026-10-24')).toBe(365);
    expect(daysBetween('2026-02-01', '2026-01-01')).toBe(-31);
  });
});

describe('isShortSpan', () => {
  it('flags spans under a year, with a week of slack for 1Y windows', () => {
    expect(isShortSpan('2026-01-02', '2026-10-24')).toBe(true);
    expect(isShortSpan('2025-10-24', '2026-10-24')).toBe(false);
    expect(isShortSpan('2025-10-26', '2026-10-24')).toBe(false); // 363 days
    expect(isShortSpan('2025-11-01', '2026-10-24')).toBe(true);  // 357 days
    expect(isShortSpan('2021-03-15', '2026-10-24')).toBe(false);
  });
});
