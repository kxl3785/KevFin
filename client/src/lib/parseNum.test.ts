import { describe, expect, it } from 'vitest';
import { parseNum, parseNumOrNull, sqliteUtcToIso } from './parseNum.ts';

describe('parseNumOrNull / parseNum', () => {
  it('tolerates commas, $ and spaces', () => {
    expect(parseNumOrNull('1,500')).toBe(1500);
    expect(parseNumOrNull('$1500')).toBe(1500);
    expect(parseNumOrNull(' $495,000.50 ')).toBe(495000.5);
    expect(parseNumOrNull('-20')).toBe(-20);
  });
  it('scales a k / m / b suffix instead of dropping it', () => {
    expect(parseNumOrNull('15k')).toBe(15000);
    expect(parseNumOrNull('$1.2M')).toBe(1200000);
    expect(parseNumOrNull('1.15m')).toBe(1150000);
    expect(parseNumOrNull('$980 K')).toBe(980000);
    expect(parseNumOrNull('2b')).toBe(2e9);
    expect(parseNumOrNull('-1.5k')).toBe(-1500);
    // A letter that isn't a scale is still ignored, as before.
    expect(parseNumOrNull('12mo')).toBe(12);
    expect(parseNumOrNull('k')).toBeNull();
  });
  it('returns null for blank/unparseable input; parseNum falls back to 0', () => {
    expect(parseNumOrNull('')).toBeNull();
    expect(parseNumOrNull('abc')).toBeNull();
    expect(parseNum('')).toBe(0);
    expect(parseNum('0')).toBe(0);
  });
});

describe('sqliteUtcToIso', () => {
  it('marks SQLite datetime strings as UTC', () => {
    expect(sqliteUtcToIso('2026-07-03 14:05:09')).toBe('2026-07-03T14:05:09Z');
    expect(new Date(sqliteUtcToIso('2026-07-03 14:05:09')).toISOString()).toBe('2026-07-03T14:05:09.000Z');
  });
  it('leaves ISO and date-only strings alone', () => {
    expect(sqliteUtcToIso('2026-07-03T14:05:09Z')).toBe('2026-07-03T14:05:09Z');
    expect(sqliteUtcToIso('2026-07-03')).toBe('2026-07-03');
  });
});
