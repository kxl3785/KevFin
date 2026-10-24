import { describe, it, expect } from 'vitest';
import { relTime, newestTimestamp } from './relTime.ts';

const now = Date.parse('2026-10-24T15:00:00Z');

describe('relTime', () => {
  it('reads a SQLite timestamp as UTC, not local time', () => {
    expect(relTime('2026-10-24 14:55:00', now)).toBe('5m ago');
    expect(relTime('2026-10-24T14:55:00Z', now)).toBe('5m ago');
  });

  it('steps through minutes, hours and days', () => {
    expect(relTime('2026-10-24 14:59:40', now)).toBe('just now');
    expect(relTime('2026-10-24 12:00:00', now)).toBe('3h ago');
    expect(relTime('2026-10-23 12:00:00', now)).toBe('yesterday');
    expect(relTime('2026-10-20 15:00:00', now)).toBe('4d ago');
  });

  it('handles missing and unparseable input', () => {
    expect(relTime(null, now)).toBe('never');
    expect(relTime('garbage', now)).toBe('garbage');
  });
});

describe('newestTimestamp', () => {
  it('picks the latest, comparing instants rather than strings', () => {
    expect(newestTimestamp(['2026-10-24 09:00:00', '2026-10-24 14:00:00', '2026-10-23 23:00:00'])).toBe('2026-10-24 14:00:00');
    expect(newestTimestamp(['2026-10-24 09:00:00', '2026-10-24T10:00:00Z'])).toBe('2026-10-24T10:00:00Z');
  });

  it('is null when nothing parses', () => {
    expect(newestTimestamp([])).toBeNull();
    expect(newestTimestamp(['nope'])).toBeNull();
  });
});
