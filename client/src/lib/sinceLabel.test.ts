import { describe, it, expect } from 'vitest';
import { sinceLabel, visitTitle } from './sinceLabel.ts';

// Local-time constructors (no trailing Z) so the assertions hold in any timezone.
const now = new Date(2026, 9, 24, 15, 0); // Oct 24, 2026, 3:00 PM local
const iso = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).toISOString();

describe('sinceLabel', () => {
  it('falls back for a legacy snapshot with no timestamp', () => {
    expect(sinceLabel(undefined, now)).toBe('since last visit');
  });

  it('falls back for an unparseable timestamp', () => {
    expect(sinceLabel('not-a-date', now)).toBe('since last visit');
    expect(sinceLabel('', now)).toBe('since last visit');
  });

  it('shows the clock time for a visit earlier the same local day', () => {
    expect(sinceLabel(iso(2026, 10, 24, 14, 15), now)).toBe('since 2:15 PM');
    expect(sinceLabel(iso(2026, 10, 24, 0, 5), now)).toBe('since 12:05 AM');
  });

  it('says "yesterday" for the previous local calendar day, even late at night', () => {
    expect(sinceLabel(iso(2026, 10, 23, 23, 59), now)).toBe('since yesterday');
    expect(sinceLabel(iso(2026, 10, 23, 0, 1), now)).toBe('since yesterday');
  });

  it('yesterday crosses month and year boundaries', () => {
    expect(sinceLabel(iso(2026, 2, 28), new Date(2026, 2, 1, 9, 0))).toBe('since yesterday');
    expect(sinceLabel(iso(2025, 12, 31), new Date(2026, 0, 1, 9, 0))).toBe('since yesterday');
  });

  it('uses month and day within the same year', () => {
    expect(sinceLabel(iso(2026, 10, 22, 14, 15), now)).toBe('since Oct 22');
    expect(sinceLabel(iso(2026, 1, 3), now)).toBe('since Jan 3');
  });

  it('adds the year for an earlier year', () => {
    expect(sinceLabel(iso(2025, 10, 22), now)).toBe('since Oct 22, 2025');
  });
});

describe('visitTitle', () => {
  it('gives the full local date and time', () => {
    expect(visitTitle(iso(2026, 10, 22, 14, 15))).toBe('Oct 22, 2026, 2:15 PM');
  });

  it('is null without a usable timestamp', () => {
    expect(visitTitle(undefined)).toBeNull();
    expect(visitTitle('garbage')).toBeNull();
  });
});
