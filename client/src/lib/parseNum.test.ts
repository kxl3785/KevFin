import { describe, expect, it } from 'vitest';
import { parseNum, parseNumOrNull, sqliteUtcToIso } from './parseNum.ts';

describe('parseNumOrNull / parseNum', () => {
  it('tolerates commas, $ and spaces', () => {
    expect(parseNumOrNull('1,500')).toBe(1500);
    expect(parseNumOrNull('$1500')).toBe(1500);
    expect(parseNumOrNull(' $495,000.50 ')).toBe(495000.5);
    expect(parseNumOrNull('-20')).toBe(-20);
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
