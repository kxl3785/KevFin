import { describe, it, expect } from 'vitest';
import { matchesShape } from './usePersistentState.ts';

describe('matchesShape', () => {
  it('rejects null / objects / primitives for an array default', () => {
    expect(matchesShape([], [])).toBe(true);
    expect(matchesShape(null, [])).toBe(false);
    expect(matchesShape({}, [])).toBe(false);
    expect(matchesShape('x', [])).toBe(false);
  });

  it('rejects null / arrays / primitives for an object default', () => {
    expect(matchesShape({ a: 1 }, {})).toBe(true);
    expect(matchesShape(null, {})).toBe(false);
    expect(matchesShape([], {})).toBe(false);
    expect(matchesShape(3, {})).toBe(false);
  });

  it('requires the same typeof for primitive defaults', () => {
    expect(matchesShape(5, 0)).toBe(true);
    expect(matchesShape('5', 0)).toBe(false);
    expect(matchesShape(true, false)).toBe(true);
    expect(matchesShape(null, false)).toBe(false);
    expect(matchesShape('Budget', 'Net Worth')).toBe(true);
  });

  it('accepts anything when the default is null (object-or-unset state)', () => {
    expect(matchesShape(null, null)).toBe(true);
    expect(matchesShape({ a: 1 }, null)).toBe(true);
  });
});
