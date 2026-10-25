import { describe, it, expect } from 'vitest';
import { fmtMoney, fmtMoneyCompact, fmtDate, fmtMonth } from './format.ts';

describe('fmtMoney', () => {
  it('uses a true minus sign before the dollar sign', () => {
    expect(fmtMoney(-1234)).toBe('−$1,234');
    expect(fmtMoney(1234)).toBe('$1,234');
  });

  it('does not show a negative zero', () => {
    expect(fmtMoney(-0.4)).toBe('$0');
    expect(fmtMoney(-0.4, { sign: true })).toBe('$0');
  });

  it('can force a plus and show cents', () => {
    expect(fmtMoney(980, { sign: true })).toBe('+$980');
    expect(fmtMoney(-980, { sign: true })).toBe('−$980');
    expect(fmtMoney(12.5, { cents: true })).toBe('$12.50');
  });
});

describe('fmtMoneyCompact', () => {
  it('abbreviates thousands and millions', () => {
    expect(fmtMoneyCompact(950)).toBe('$950');
    expect(fmtMoneyCompact(1200)).toBe('$1.2k');
    expect(fmtMoneyCompact(15_000)).toBe('$15k');
    expect(fmtMoneyCompact(1_300_000)).toBe('$1.3M');
    expect(fmtMoneyCompact(-40_000)).toBe('−$40k');
  });
});

describe('dates', () => {
  it('reads ISO dates as calendar days, not instants', () => {
    expect(fmtDate('2026-10-24')).toBe('Oct 24, 2026');
    expect(fmtDate('2026-01-01')).toBe('Jan 1, 2026');
    expect(fmtDate('2026-10-24', { year: false })).toBe('Oct 24');
  });

  it('formats a month alone', () => {
    expect(fmtMonth('2026-10-24')).toBe('Oct 2026');
  });
});
