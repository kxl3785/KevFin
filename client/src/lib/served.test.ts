import { describe, it, expect } from 'vitest';
import { servedFrom, pollDelay, combineServed, updatedLabel } from './served.ts';

const headers = (h: Record<string, string>) => ({ get: (k: string) => h[k] ?? null });

describe('servedFrom', () => {
  it('reads when the result was computed and whether a newer one is on its way', () => {
    expect(servedFrom(headers({ 'X-KevFin-Computed-At': '1700000000000', 'X-KevFin-Refreshing': '1' })))
      .toEqual({ computedAt: 1700000000000, refreshing: true });
    expect(servedFrom(headers({ 'X-KevFin-Computed-At': '1700000000000', 'X-KevFin-Refreshing': '0' })))
      .toEqual({ computedAt: 1700000000000, refreshing: false });
  });

  it('is null for an endpoint that sends no such headers, or a junk value', () => {
    expect(servedFrom(headers({}))).toBeNull();
    expect(servedFrom(headers({ 'X-KevFin-Computed-At': 'soon', 'X-KevFin-Refreshing': '1' }))).toBeNull();
  });
});

describe('pollDelay', () => {
  it('asks again quickly, then backs off to a ceiling', () => {
    expect([0, 1, 2, 3, 4, 9].map(pollDelay)).toEqual([1500, 3000, 6000, 12000, 15000, 15000]);
  });
});

describe('combineServed', () => {
  it('is as old as the oldest result and refreshing while any is', () => {
    expect(combineServed([{ computedAt: 300, refreshing: false }, null, { computedAt: 100, refreshing: true }]))
      .toEqual({ computedAt: 100, refreshing: true });
    expect(combineServed([{ computedAt: 300, refreshing: false }, undefined])).toEqual({ computedAt: 300, refreshing: false });
  });

  it('is null until something has arrived', () => {
    expect(combineServed([null, undefined])).toBeNull();
  });
});

describe('updatedLabel', () => {
  // Local-time constructors, so the test reads the same in any timezone.
  const now = new Date(2026, 10, 26, 15, 0);

  it('gives the time alone for today', () => {
    expect(updatedLabel(new Date(2026, 10, 26, 9, 41).getTime(), now)).toBe('Updated 9:41 AM');
  });

  it('says yesterday', () => {
    expect(updatedLabel(new Date(2026, 10, 25, 18, 5).getTime(), now)).toBe('Updated yesterday, 6:05 PM');
  });

  it('gives the date for anything older, with the year once it differs', () => {
    expect(updatedLabel(new Date(2026, 10, 20, 9, 41).getTime(), now)).toBe('Updated Nov 20, 9:41 AM');
    expect(updatedLabel(new Date(2025, 11, 31, 9, 41).getTime(), now)).toBe('Updated Dec 31, 2025, 9:41 AM');
  });
});
