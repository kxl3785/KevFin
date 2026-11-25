import { describe, it, expect } from 'vitest';
import {
  readRatioField, extractExpenseRatio, classifyRatio, summarizeFees, parseOverrides,
  looksLikeCash, isValidExpenseRatio, parseExpenseRatioBody, MAX_EXPENSE_RATIO, looksLikeNonFundSecurity,
} from './expenseRatio.js';

describe('readRatioField', () => {
  it('reads the formatted percent string first (units are unambiguous there)', () => {
    expect(readRatioField({ raw: 0.03, fmt: '0.03%' }, false)).toBeCloseTo(0.0003, 10);
    expect(readRatioField({ raw: 0.0003, fmt: '0.03%' }, true)).toBeCloseTo(0.0003, 10);
    expect(readRatioField({ fmt: '1.25%' }, false)).toBeCloseTo(0.0125, 10);
  });
  it('uses raw only for fields known to carry a fraction', () => {
    expect(readRatioField({ raw: 0.0015 }, true)).toBe(0.0015);
    expect(readRatioField({ raw: 0.15 }, false)).toBeNull();
  });
  it('keeps raw\'s exact figure when the display string is rounded to two decimals', () => {
    // Yahoo answers for public tickers (2026-11-24): fmt is rounded, raw is exact.
    expect(readRatioField({ raw: 0.00014999999, fmt: '0.01%' }, false)).toBeCloseTo(0.00015, 9); // FXAIX 0.015%
    expect(readRatioField({ raw: 0.00025, fmt: '0.03%' }, true)).toBe(0.00025);                    // FXNAX 0.025%
    expect(readRatioField({ raw: 0.000945, fmt: '0.09%' }, true)).toBe(0.000945);                  // SPY 0.0945%
    // Exactly half a display step away still counts (float: 0.00015 − 0.0001 > 0.00005).
    expect(readRatioField({ raw: 0.00015, fmt: '0.01%' }, true)).toBe(0.00015);
  });
  it('reads raw in percent points when that is what the display string says', () => {
    expect(readRatioField({ raw: 0.015, fmt: '0.01%' }, false)).toBeCloseTo(0.00015, 12);
    expect(readRatioField({ raw: 1.25, fmt: '1.25%' }, false)).toBeCloseTo(0.0125, 12);
  });
  it('prefers the fraction reading when both fit (a tiny raw next to "0.00%")', () => {
    expect(readRatioField({ raw: 0.00003, fmt: '0.00%' }, false)).toBe(0.00003);
  });
  it('falls back to the display string when raw matches neither reading', () => {
    expect(readRatioField({ raw: 0.4, fmt: '0.20%' }, true)).toBeCloseTo(0.002, 12);
  });
  it('returns null for missing or junk fields', () => {
    expect(readRatioField(undefined, true)).toBeNull();
    expect(readRatioField(null, true)).toBeNull();
    expect(readRatioField({}, true)).toBeNull();
    expect(readRatioField({ fmt: 'N/A' }, false)).toBeNull();
    expect(readRatioField({ raw: Number.NaN }, true)).toBeNull();
  });
});

describe('extractExpenseRatio', () => {
  it('prefers the net ratio', () => {
    const r = { fundProfile: { feesExpensesInvestment: { netExpRatio: { raw: 0.04, fmt: '0.04%' }, annualReportExpenseRatio: { raw: 0.0005, fmt: '0.05%' } } } };
    expect(extractExpenseRatio(r)).toBeCloseTo(0.0004, 10);
  });
  it('falls back to the annual-report ratio from either module', () => {
    expect(extractExpenseRatio({ fundProfile: { feesExpensesInvestment: { annualReportExpenseRatio: { raw: 0.0059 } } } })).toBe(0.0059);
    expect(extractExpenseRatio({ defaultKeyStatistics: { annualReportExpenseRatio: { raw: 0.0003, fmt: '0.03%' } } })).toBeCloseTo(0.0003, 10);
  });
  it('lets a positive figure beat a stray zero, but accepts a genuine zero', () => {
    const mixed = { fundProfile: { feesExpensesInvestment: { netExpRatio: { raw: 0, fmt: '0.00%' } } }, defaultKeyStatistics: { annualReportExpenseRatio: { raw: 0.0009 } } };
    expect(extractExpenseRatio(mixed)).toBe(0.0009);
    expect(extractExpenseRatio({ fundProfile: { feesExpensesInvestment: { netExpRatio: { raw: 0, fmt: '0.00%' } } } })).toBe(0);
  });
  it('keeps the published precision for real Yahoo answers (FXAIX, FXNAX, SPY)', () => {
    const FXAIX = {
      fundProfile: { feesExpensesInvestment: {
        netExpRatio: { raw: 0.00014999999, fmt: '0.01%' }, annualReportExpenseRatio: { raw: 0.00014999999, fmt: '0.01%' } } },
      defaultKeyStatistics: { annualReportExpenseRatio: { raw: 0.00014999999, fmt: '0.01%' } },
    };
    const FXNAX = { fundProfile: { feesExpensesInvestment: { netExpRatio: { raw: 0.00025, fmt: '0.03%' } } } };
    const SPY = {
      fundProfile: { feesExpensesInvestment: { netExpRatio: {}, annualReportExpenseRatio: { raw: 0.000945, fmt: '0.09%' } } },
      defaultKeyStatistics: { annualReportExpenseRatio: {} },
    };
    expect(extractExpenseRatio(FXAIX)).toBeCloseTo(0.00015, 9);
    expect(extractExpenseRatio(FXNAX)).toBeCloseTo(0.00025, 12);
    expect(extractExpenseRatio(SPY)).toBeCloseTo(0.000945, 12);
    // $500,000 in FXAIX costs 500,000 × 0.00015 = $75 a year (not the $50 the rounded 0.01% gave).
    const s = summarizeFees([{ id: 'FXAIX', symbol: 'FXAIX', name: 'Fidelity 500 Index', value: 500_000, expenseRatio: extractExpenseRatio(FXAIX), source: 'provider' }]);
    expect(s.totalAnnualCost).toBeCloseTo(75, 2);
  });
  it('rejects out-of-range figures (a percent read as a fraction) and missing data', () => {
    expect(extractExpenseRatio({ defaultKeyStatistics: { annualReportExpenseRatio: { raw: 0.75 } } })).toBeNull();
    expect(extractExpenseRatio({ defaultKeyStatistics: { annualReportExpenseRatio: { raw: -0.001 } } })).toBeNull();
    expect(extractExpenseRatio({})).toBeNull();
    expect(extractExpenseRatio(undefined)).toBeNull();
  });
});

describe('isValidExpenseRatio', () => {
  it('accepts 0 through 5% inclusive only', () => {
    expect(isValidExpenseRatio(0)).toBe(true);
    expect(isValidExpenseRatio(MAX_EXPENSE_RATIO)).toBe(true);
    expect(isValidExpenseRatio(0.0500001)).toBe(false);
    expect(isValidExpenseRatio(-0.0001)).toBe(false);
    expect(isValidExpenseRatio(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isValidExpenseRatio('0.01')).toBe(false);
  });
});

describe('looksLikeCash', () => {
  it('recognises untickered cash lines but not money-market funds', () => {
    expect(looksLikeCash('', 'Cash')).toBe(true);
    expect(looksLikeCash('CASH', 'Cash & Cash Investments')).toBe(true);
    expect(looksLikeCash('', 'FDIC bank sweep program')).toBe(true);
    expect(looksLikeCash('SPAXX', 'Fidelity Government Money Market')).toBe(false);
    expect(looksLikeCash('', 'Target Date 2050 Portfolio')).toBe(false);
    expect(looksLikeCash('', 'Cashmere Valley Bank stock')).toBe(false);
  });
});

describe('classifyRatio', () => {
  it('lets the user figure win over everything', () => {
    expect(classifyRatio({ symbol: 'AAPL', name: 'Apple', quoteType: 'EQUITY', override: 0.001 })).toEqual({ ratio: 0.001, source: 'manual', lookup: false });
    expect(classifyRatio({ symbol: '', name: 'Cash', quoteType: null, override: 0 })).toEqual({ ratio: 0, source: 'manual', lookup: false });
  });
  it('ignores an invalid stored figure', () => {
    expect(classifyRatio({ symbol: 'VTI', name: 'Vanguard Total', quoteType: 'ETF', override: 0.2 })).toEqual({ ratio: null, source: 'unknown', lookup: true });
  });
  it('charges nothing for stocks, cash and other non-funds', () => {
    expect(classifyRatio({ symbol: 'AAPL', name: 'Apple', quoteType: 'EQUITY', override: undefined })).toMatchObject({ ratio: 0, source: 'stock' });
    expect(classifyRatio({ symbol: '', name: 'Cash', quoteType: null, override: undefined })).toMatchObject({ ratio: 0, source: 'cash' });
    expect(classifyRatio({ symbol: 'BTC', name: 'Bitcoin', quoteType: 'CRYPTOCURRENCY', override: undefined })).toMatchObject({ ratio: 0, source: 'not-fund' });
  });
  it('settles options and CUSIP-held bills, bonds and CDs as non-funds without a lookup', () => {
    expect(classifyRatio({ symbol: '912797KX4', name: 'UNITED STATES TREAS BILLS', quoteType: null, override: undefined }))
      .toEqual({ ratio: 0, source: 'not-fund', lookup: false });
    expect(classifyRatio({ symbol: '-AAPL250117C150', name: 'CALL APPLE', quoteType: null, override: undefined }))
      .toEqual({ ratio: 0, source: 'not-fund', lookup: false });
    expect(classifyRatio({ symbol: 'XYZ', name: 'Some contract', quoteType: null, override: undefined, assetClass: 'Options' }))
      .toEqual({ ratio: 0, source: 'not-fund', lookup: false });
    // The user's figure still wins.
    expect(classifyRatio({ symbol: '912797KX4', name: 'UNITED STATES TREAS BILLS', quoteType: null, override: 0.001 }))
      .toMatchObject({ ratio: 0.001, source: 'manual' });
  });
  it('still looks up money-market funds and funds a plan reports by CUSIP', () => {
    expect(classifyRatio({ symbol: 'SPAXX', name: 'Fidelity Government Money Market', quoteType: null, override: undefined, assetClass: 'Short Term' }))
      .toMatchObject({ source: 'unknown', lookup: true });
    expect(classifyRatio({ symbol: '922908363', name: 'Vanguard Total Bond Market Index Trust', quoteType: null, override: undefined, assetClass: 'Bonds' }))
      .toMatchObject({ source: 'unknown', lookup: true });
  });
  it('looks up tickered funds and unknown-type tickers; leaves untickered funds unknown', () => {
    expect(classifyRatio({ symbol: 'VTI', name: 'Vanguard Total', quoteType: 'ETF', override: undefined })).toEqual({ ratio: null, source: 'unknown', lookup: true });
    expect(classifyRatio({ symbol: 'XYZ', name: 'Something', quoteType: null, override: undefined })).toEqual({ ratio: null, source: 'unknown', lookup: true });
    expect(classifyRatio({ symbol: '', name: 'Age-Based 2040 Portfolio', quoteType: null, override: undefined })).toEqual({ ratio: null, source: 'unknown', lookup: false });
  });
});

describe('summarizeFees', () => {
  const row = (id: string, value: number, expenseRatio: number | null, source: 'provider' | 'stock' | 'unknown' | 'manual' = expenseRatio == null ? 'unknown' : 'provider') =>
    ({ id, symbol: id, name: id, value, expenseRatio, source });

  it('computes the value-weighted ratio and yearly cost (hand-checked)', () => {
    // 90,000 × 0.03% = $27 ; 10,000 × 1% = $100 ; total $127 on $100,000 = 0.127%.
    const s = summarizeFees([row('VTI', 90_000, 0.0003), row('ARKK', 10_000, 0.01)]);
    expect(s.totalAnnualCost).toBeCloseTo(127, 8);
    expect(s.weightedRatio).toBeCloseTo(0.00127, 10);
    expect(s.coverage).toBe(1);
    expect(s.rows.map(r => r.id)).toEqual(['ARKK', 'VTI']); // sorted by annual cost
    expect(s.largestId).toBe('ARKK');
  });

  it('counts stocks at 0 and leaves unknown funds out of the ratio but in the coverage gap', () => {
    // Known: VTI $50k @ 0.03% ($15) + AAPL $30k @ 0 = $80k covered; MYST $20k unknown.
    const s = summarizeFees([row('VTI', 50_000, 0.0003), row('AAPL', 30_000, 0, 'stock'), row('MYST', 20_000, null)]);
    expect(s.totalValue).toBe(100_000);
    expect(s.coveredValue).toBe(80_000);
    expect(s.coverage).toBeCloseTo(0.8, 12);
    expect(s.totalAnnualCost).toBeCloseTo(15, 8);
    expect(s.weightedRatio).toBeCloseTo(15 / 80_000, 12);
    expect(s.unknownCount).toBe(1);
    expect(s.rows[s.rows.length - 1].id).toBe('MYST'); // unknowns last
    expect(s.rows.find(r => r.id === 'MYST')!.annualCost).toBeNull();
  });

  it('handles empty input and all-unknown input without NaN', () => {
    const empty = summarizeFees([]);
    expect(empty).toMatchObject({ totalValue: 0, coveredValue: 0, coverage: 0, weightedRatio: null, totalAnnualCost: 0, largestId: null, unknownCount: 0 });
    const unknown = summarizeFees([row('A', 1000, null)]);
    expect(unknown.weightedRatio).toBeNull();
    expect(unknown.coverage).toBe(0);
    expect(unknown.largestId).toBeNull();
  });

  it('drops non-positive values and flags no largest when everything costs 0', () => {
    const s = summarizeFees([row('SHORT', -5000, 0.01), row('ZERO', 0, 0.01), row('AAPL', 1000, 0, 'stock')]);
    expect(s.rows.map(r => r.id)).toEqual(['AAPL']);
    expect(s.weightedRatio).toBe(0);
    expect(s.largestId).toBeNull();
  });

  it('turns an out-of-range ratio into unknown', () => {
    const s = summarizeFees([row('BAD', 1000, 0.3)]);
    expect(s.rows[0]).toMatchObject({ expenseRatio: null, source: 'unknown', annualCost: null });
  });

  it('keeps a figure\'s provider, and drops it when the figure is unusable', () => {
    const s = summarizeFees([
      { ...row('VFINX', 1000, 0.0014), provider: 'sec', asOf: '2026-06-30' },
      { ...row('BAD', 1000, 0.3), provider: 'sec', asOf: '2026-06-30' },
    ]);
    expect(s.rows.find(r => r.id === 'VFINX')).toMatchObject({ provider: 'sec', asOf: '2026-06-30', annualCost: 1.4 });
    const bad = s.rows.find(r => r.id === 'BAD')!;
    expect(bad.provider).toBeUndefined();
    expect(bad.asOf).toBeUndefined();
  });
});

describe('parseOverrides', () => {
  it('keeps valid entries and drops junk', () => {
    expect(parseOverrides('{"VTI":0.0003,"BAD":0.5,"NEG":-1,"STR":"0.01"," ":0.01}')).toEqual({ VTI: 0.0003 });
    expect(parseOverrides('not json')).toEqual({});
    expect(parseOverrides('[1,2]')).toEqual({});
    expect(parseOverrides(undefined)).toEqual({});
  });
});

describe('parseExpenseRatioBody', () => {
  it('accepts numbers and numeric strings from 0 to 5%', () => {
    expect(parseExpenseRatioBody({ symbol: ' VTI ', expenseRatio: 0.0003 })).toEqual({ id: 'VTI', ratio: 0.0003 });
    expect(parseExpenseRatioBody({ symbol: 'VTI', expenseRatio: '0.05' })).toEqual({ id: 'VTI', ratio: 0.05 });
    expect(parseExpenseRatioBody({ symbol: 'VTI', expenseRatio: 0 })).toEqual({ id: 'VTI', ratio: 0 });
  });
  it('clears with null, undefined or blank', () => {
    expect(parseExpenseRatioBody({ symbol: 'VTI', expenseRatio: null })).toEqual({ id: 'VTI', ratio: null });
    expect(parseExpenseRatioBody({ symbol: 'VTI' })).toEqual({ id: 'VTI', ratio: null });
    expect(parseExpenseRatioBody({ symbol: 'VTI', expenseRatio: '  ' })).toEqual({ id: 'VTI', ratio: null });
  });
  it('refuses out-of-range values, other types and a missing symbol', () => {
    for (const bad of [0.0501, -0.001, 'abc', true, [], {}, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(parseExpenseRatioBody({ symbol: 'VTI', expenseRatio: bad })).toHaveProperty('error');
    }
    expect(parseExpenseRatioBody({ expenseRatio: 0.001 })).toHaveProperty('error');
    expect(parseExpenseRatioBody({ symbol: '   ', expenseRatio: 0.001 })).toHaveProperty('error');
    expect(parseExpenseRatioBody(null)).toHaveProperty('error');
  });
});

describe('looksLikeNonFundSecurity', () => {
  it('recognises option symbols, CUSIP-held debt and the Options class', () => {
    expect(looksLikeNonFundSecurity('AAPL  250117C00150000', 'AAPL Jan 2025 150 Call')).toBe(true);
    expect(looksLikeNonFundSecurity('912828YK0', 'US TREASURY NOTE')).toBe(true);
    expect(looksLikeNonFundSecurity('06051GHY8', 'BANK OF AMERICA CORP 4.25% 10/22/2026')).toBe(true);
    expect(looksLikeNonFundSecurity('14042RQB0', 'CAPITAL ONE NA CD')).toBe(true);
    expect(looksLikeNonFundSecurity('12345ABC7', 'Something', 'Short Term')).toBe(true);
    expect(looksLikeNonFundSecurity('', 'Covered call', 'Options')).toBe(true);
  });
  it('leaves stocks, funds and fund-named CUSIPs alone', () => {
    for (const [s, n, c] of [['VTI', 'Vanguard Total Stock', 'Domestic Stock'], ['SPAXX', 'Money Market', 'Short Term'],
      ['922908363', 'Vanguard Total Bond Market Index Trust', 'Bonds'], ['123456789', 'Stable Value Fund', 'Short Term'],
      ['', 'US Treasury Bill', 'Short Term'], ['BTC-USD', 'Bitcoin', 'Crypto']] as const) {
      expect(looksLikeNonFundSecurity(s, n, c)).toBe(false);
    }
  });
});
