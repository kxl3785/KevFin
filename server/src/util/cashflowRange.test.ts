import { describe, it, expect } from 'vitest';
import { rangeBounds, inRange } from './cashflowRange.js';

const now = new Date('2026-11-26T12:00:00Z');

describe('rangeBounds', () => {
  it('rolling ranges reach back from the current month with no end', () => {
    expect(rangeBounds('1m', now)).toEqual({ start: '2026-11-01', end: null, label: 'This month' });
    expect(rangeBounds('3m', now).start).toBe('2026-09-01');
    expect(rangeBounds('6m', now).start).toBe('2026-06-01');
    expect(rangeBounds('ytd', now).start).toBe('2026-01-01');
    expect(rangeBounds('12m', now).start).toBe('2025-12-01');
  });
  it('a calendar month covers exactly that month', () => {
    expect(rangeBounds('2026-06', now)).toEqual({ start: '2026-06-01', end: '2026-06-30', label: 'June 2026' });
    expect(rangeBounds('2024-02', now)).toMatchObject({ start: '2024-02-01', end: '2024-02-29' });
    expect(rangeBounds('2026-12', now)).toMatchObject({ start: '2026-12-01', end: '2026-12-31' });
  });
  it('anything else is all time', () => {
    expect(rangeBounds('all', now)).toEqual({ start: null, end: null, label: 'All time' });
    expect(rangeBounds('2026-13', now).start).toBeNull();
    expect(rangeBounds('', now).start).toBeNull();
  });
});

describe('inRange', () => {
  const june = rangeBounds('2026-06', now);
  it('includes both ends of a month', () => {
    expect(inRange('2026-06-01', june)).toBe(true);
    expect(inRange('2026-06-30', june)).toBe(true);
    expect(inRange('2026-05-31', june)).toBe(false);
    expect(inRange('2026-07-01', june)).toBe(false);
  });
  it('open bounds let everything through', () => {
    expect(inRange('1999-01-01', rangeBounds('all', now))).toBe(true);
    expect(inRange('2026-11-30', rangeBounds('1m', now))).toBe(true);
  });
});
