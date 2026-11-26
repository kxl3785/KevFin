import { describe, it, expect } from 'vitest';
import { andList, feeGroups, foldList, freeKinds, freeLine, namedList, type FeeRowLike } from './fundFees.ts';

const r = (symbol: string, value: number, expenseRatio: number | null, source = expenseRatio == null ? 'unknown' : 'provider'): FeeRowLike => ({
  id: symbol, symbol, name: `${symbol} name`, value, expenseRatio, source,
  annualCost: expenseRatio == null ? null : value * expenseRatio,
});

describe('feeGroups', () => {
  const rows = [
    r('VTI', 100_000, 0.0003),   // $30
    r('ARKK', 10_000, 0.0075),   // $75
    r('AAPL', 50_000, 0, 'stock'),
    r('CASH', 5_000, 0, 'cash'),
    r('SMALL', 1_000, null),
    r('BIG', 80_000, null),
    r('FREE', 2_000, 0, 'provider'),
  ];
  it('ranks the holdings that charge something by yearly cost, with their share of it', () => {
    const g = feeGroups(rows);
    expect(g.charging.map(c => c.row.symbol)).toEqual(['ARKK', 'VTI']);
    expect(g.charging[0].share).toBeCloseTo(75 / 105, 10);
    expect(g.charging.reduce((s, c) => s + c.share, 0)).toBeCloseTo(1, 10);
  });
  it('groups the 0% holdings, and the unknown ones largest first', () => {
    const g = feeGroups(rows);
    expect(g.free.map(x => x.symbol)).toEqual(['AAPL', 'CASH', 'FREE']);
    expect(g.unknown.map(x => x.symbol)).toEqual(['BIG', 'SMALL']);
  });
  it('breaks a tie in cost by the larger holding, then keeps the given order', () => {
    const g = feeGroups([r('A', 1_000, 0.01), r('B', 2_000, 0.005), r('C', 2_000, 0.005)]);
    expect(g.charging.map(c => c.row.symbol)).toEqual(['B', 'C', 'A']);
  });
  it('drops holdings with no value, and is empty for no rows', () => {
    expect(feeGroups([r('Z', 0, 0.01), r('N', Number.NaN, null)])).toEqual({ charging: [], free: [], unknown: [] });
    expect(feeGroups([])).toEqual({ charging: [], free: [], unknown: [] });
  });
});

describe('foldList', () => {
  const seven = [1, 2, 3, 4, 5, 6, 7];
  it('folds a long list to its first five until shown in full', () => {
    expect(foldList(seven, false)).toEqual({ shown: [1, 2, 3, 4, 5], folds: true });
    expect(foldList(seven, true)).toEqual({ shown: seven, folds: true });
  });
  it('just shows six or fewer', () => {
    expect(foldList(seven.slice(0, 6), false)).toEqual({ shown: seven.slice(0, 6), folds: false });
  });
});

describe('wording', () => {
  it('lists with commas and "and"', () => {
    expect(andList([])).toBe('');
    expect(andList(['A'])).toBe('A');
    expect(andList(['A', 'B', 'C'])).toBe('A, B and C');
  });
  it('names up to three, then "and N more"', () => {
    expect(namedList(['A', 'B', 'C', 'D'])).toBe('A, B, C and D');
    expect(namedList(['A', 'B', 'C', 'D', 'E'])).toBe('A, B, C and 2 more');
  });
  it('says what charges nothing, singular or plural by kind', () => {
    const src = (...s: string[]) => s.map(source => ({ source }));
    expect(freeKinds(src('stock', 'stock', 'cash'))).toBe('single stocks and cash');
    expect(freeKinds(src('stock'))).toBe('a single stock');
    expect(freeKinds(src('cash', 'provider', 'not-fund'))).toBe('cash, a holding that isn’t a fund and a zero-fee fund');
    expect(freeLine(src('stock', 'stock', 'cash'))).toBe('3 holdings charge nothing: single stocks and cash.');
    expect(freeLine(src('cash'))).toBe('1 holding charges nothing: cash.');
    expect(freeLine([])).toBeNull();
  });
});
