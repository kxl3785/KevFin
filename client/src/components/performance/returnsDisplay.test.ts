import { describe, it, expect } from 'vitest';
import { fmtPct, spanLabel, headline, isShortSpan, nextOverrides, monthLabel, afterFailedSave, maskPercents } from './returnsDisplay.ts';

describe('fmtPct', () => {
  it('signs and rounds to one decimal', () => {
    expect(fmtPct(0.10916)).toBe('+10.9%');
    expect(fmtPct(-0.032)).toBe('−3.2%');
    expect(fmtPct(0)).toBe('0.0%');
    expect(fmtPct(-0.0004)).toBe('0.0%'); // no "−0.0%"
  });
  it('is null for missing or non-finite values', () => {
    expect(fmtPct(null)).toBeNull();
    expect(fmtPct(undefined)).toBeNull();
    expect(fmtPct(NaN)).toBeNull();
    expect(fmtPct(Infinity)).toBeNull();
  });
});

describe('spanLabel', () => {
  it('uses days, months or years', () => {
    expect(spanLabel(1)).toBe('over 1 day');
    expect(spanLabel(12)).toBe('over 12 days');
    expect(spanLabel(91)).toBe('over 3 months');
    expect(spanLabel(365)).toBe('over 12 months');
    expect(spanLabel(730)).toBe('over 2 years');
    expect(spanLabel(913)).toBe('over 2.5 years');
  });
  it('is empty for zero or bad input', () => {
    expect(spanLabel(0)).toBe('');
    expect(spanLabel(NaN)).toBe('');
  });
});

describe('headline', () => {
  it('shows the span total for a year or less', () => {
    expect(headline({ periodReturn: 0.05, annualized: null }, 200)).toEqual({ value: 0.05, label: 'over 7 months', total: null });
    // Exactly a year is not annualised.
    expect(headline({ periodReturn: 0.1, annualized: 0.1 }, 365)).toEqual({ value: 0.1, label: 'over 12 months', total: null });
  });
  it('shows the per-year rate for longer spans, with the total beside it', () => {
    expect(headline({ periodReturn: 0.21, annualized: 0.1 }, 730)).toEqual({ value: 0.1, label: 'a year', total: 0.21 });
  });
  it('falls back to the total when no per-year rate exists', () => {
    expect(headline({ periodReturn: -1, annualized: null }, 800)).toEqual({ value: -1, label: 'over 2.2 years', total: null });
  });
  it('is empty for a missing measure', () => {
    expect(headline(null, 100)).toEqual({ value: null, label: '', total: null });
    expect(headline({ periodReturn: NaN, annualized: null }, 100).value).toBeNull();
  });
});

describe('nextOverrides', () => {
  it('stores an exclusion and removes it again on re-include', () => {
    const a = nextOverrides({}, 't1', false);
    expect(a).toEqual({ t1: 'exclude' });
    expect(nextOverrides(a, 't1', true)).toEqual({});
  });
  it('does not mutate the input', () => {
    const cur = { t1: 'exclude' as const };
    nextOverrides(cur, 't2', false);
    expect(cur).toEqual({ t1: 'exclude' });
  });
});

describe('monthLabel', () => {
  it('formats a month key', () => {
    expect(monthLabel('2025-11')).toBe('Nov 2025');
    expect(monthLabel('junk')).toBe('junk');
  });
});

describe('headline uses the span of the figure itself', () => {
  it('labels a money-weighted figure by its own (shorter) span', () => {
    // Dates measured: 800 days, but the account started empty and the money
    // was in for 300 days: no per-year rate, a total "over 10 months".
    const m = { periodReturn: 0.25, annualized: null, days: 300 };
    expect(headline(m, 800)).toEqual({ value: 0.25, label: 'over 10 months', total: null });
  });
  it('falls back to the caller’s span when the figure has none', () => {
    expect(headline({ periodReturn: 0.3, annualized: 0.127 }, 800)).toEqual({ value: 0.127, label: 'a year', total: 0.3 });
    expect(headline({ periodReturn: 0.3, annualized: 0.127, days: 0 }, 800).label).toBe('a year');
  });
});

describe('afterFailedSave', () => {
  const prev = { a: 'exclude' as const };
  const attempted = { a: 'exclude' as const, b: 'exclude' as const };
  it('rolls the switch back to what the server holds', () => {
    expect(afterFailedSave(attempted, attempted, prev)).toBe(prev);
  });
  it('never undoes a newer toggle made while the save was in flight', () => {
    const newer = { b: 'exclude' as const };
    expect(afterFailedSave(newer, attempted, prev)).toBe(newer);
  });
});

describe('maskPercents', () => {
  it('hides percentages but keeps names and dates', () => {
    expect(maskPercents('1 of 2 investment accounts is included, holding 67% of the balance.'))
      .toBe('1 of 2 investment accounts is included, holding ••% of the balance.');
    expect(maskPercents('Large one-day changes: Individual Brokerage moved +28.7% on Nov 3, 2026 and IRA moved −40.1% on Nov 4, 2026.'))
      .toBe('Large one-day changes: Individual Brokerage moved ••% on Nov 3, 2026 and IRA moved ••% on Nov 4, 2026.');
    expect(maskPercents('No numbers here.')).toBe('No numbers here.');
  });
});

describe('isShortSpan', () => {
  it('flags history well short of the period picked', () => {
    expect(isShortSpan(16, 365)).toBe(true);
    expect(isShortSpan(200, 365)).toBe(true);
  });
  it('does not flag a span that (nearly) fills the period', () => {
    expect(isShortSpan(365, 365)).toBe(false);
    expect(isShortSpan(300, 365)).toBe(false);
    expect(isShortSpan(88, 90)).toBe(false);
  });
  it('is false for missing or bad input', () => {
    expect(isShortSpan(0, 365)).toBe(false);
    expect(isShortSpan(NaN, 365)).toBe(false);
  });
});
