import { describe, it, expect } from 'vitest';
import { monthsBefore, rangeCutoff, RANGES } from './dateRange.ts';

const at = (iso: string) => new Date(iso + 'T12:00:00');

describe('monthsBefore', () => {
  // Date.setMonth() rolls "February 31" forward to March 3, which turned the
  // dashboard's 1M button into a 28-day window whenever today was the 31st.
  it('clamps to the target month end instead of rolling over', () => {
    expect(monthsBefore(at('2026-03-31'), 1).toDateString()).toBe(at('2026-02-28').toDateString());
    expect(monthsBefore(at('2026-05-31'), 3).toDateString()).toBe(at('2026-02-28').toDateString());
    expect(monthsBefore(at('2026-07-31'), 1).toDateString()).toBe(at('2026-06-30').toDateString());
  });

  it('keeps the same day when the target month has it', () => {
    expect(monthsBefore(at('2026-07-15'), 1).toDateString()).toBe(at('2026-06-15').toDateString());
    expect(monthsBefore(at('2026-07-15'), 6).toDateString()).toBe(at('2026-01-15').toDateString());
  });

  it('crosses year boundaries', () => {
    expect(monthsBefore(at('2026-01-31'), 3).toDateString()).toBe(at('2025-10-31').toDateString());
    expect(monthsBefore(at('2026-02-15'), 12).toDateString()).toBe(at('2025-02-15').toDateString());
  });

  it('clamps a leap day back to Feb 28 in a common year', () => {
    expect(monthsBefore(at('2024-02-29'), 12).toDateString()).toBe(at('2023-02-28').toDateString());
  });
});

describe('rangeCutoff', () => {
  it('never returns a cutoff later than the true window start', () => {
    // On the 31st the old code returned a cutoff *after* the intended start,
    // silently shortening the range.
    expect(rangeCutoff('1M', at('2026-03-31'))).toBe('2026-02-28');
    expect(rangeCutoff('3M', at('2026-05-31'))).toBe('2026-02-28');
    expect(rangeCutoff('6M', at('2026-08-31'))).toBe('2026-02-28');
  });

  it('handles the fixed anchors', () => {
    expect(rangeCutoff('ALL', at('2026-07-27'))).toBe('');
    expect(rangeCutoff('YTD', at('2026-07-27'))).toBe('2026-01-01');
  });

  it('walks back whole years', () => {
    expect(rangeCutoff('1Y', at('2026-07-27'))).toBe('2025-07-27');
    expect(rangeCutoff('3Y', at('2026-07-27'))).toBe('2023-07-27');
    expect(rangeCutoff('5Y', at('2026-07-27'))).toBe('2021-07-27');
  });

  it('formats from local components, not UTC', () => {
    // 11pm local on the 27th is already the 28th in UTC; the cutoff must still
    // be built from the local calendar date the snapshots are keyed by.
    const late = new Date('2026-07-27T23:30:00');
    expect(rangeCutoff('YTD', late)).toBe('2026-01-01');
    expect(rangeCutoff('1Y', late)).toBe('2025-07-27');
  });

  it('returns a usable cutoff for every range key', () => {
    for (const r of RANGES) {
      const c = rangeCutoff(r, at('2026-03-31'));
      expect(c === '' || /^\d{4}-\d{2}-\d{2}$/.test(c)).toBe(true);
    }
  });
});
