import { describe, it, expect } from 'vitest';
import { resolveBudgetTab, stepMonth, dayHeader, groupByDay, filterTxns, amountMatches, inOutMortgage, NO_FILTERS, needsCategory } from './budgetView.ts';

describe('resolveBudgetTab', () => {
  it('keeps the current tabs', () => {
    expect(resolveBudgetTab('transactions')).toEqual({ tab: 'transactions' });
    expect(resolveBudgetTab('recurring')).toEqual({ tab: 'recurring' });
  });
  it('maps the old tabs onto the new ones', () => {
    expect(resolveBudgetTab('cashflow')).toEqual({ tab: 'cashflow', cashView: 'month' });
    expect(resolveBudgetTab('sankey')).toEqual({ tab: 'cashflow', cashView: 'flow' });
    expect(resolveBudgetTab('rules')).toEqual({ tab: 'setup' });
  });
  it('ignores unknown tabs', () => {
    expect(resolveBudgetTab('nope')).toBeNull();
    expect(resolveBudgetTab(undefined)).toBeNull();
  });
});

describe('stepMonth', () => {
  const months = ['2026-06', '2026-05', '2026-03']; // newest first; April has no data
  it('steps to the neighbouring months that have data', () => {
    expect(stepMonth(months, '2026-06', -1)).toBe('2026-05');
    expect(stepMonth(months, '2026-05', -1)).toBe('2026-03');
    expect(stepMonth(months, '2026-03', 1)).toBe('2026-05');
  });
  it('stops at the ends', () => {
    expect(stepMonth(months, '2026-06', 1)).toBeNull();
    expect(stepMonth(months, '2026-03', -1)).toBeNull();
    expect(stepMonth(months, '2025-01', 1)).toBeNull();
  });
});

describe('dayHeader / groupByDay', () => {
  it('names the day, with the year only outside the current one', () => {
    expect(dayHeader('2026-06-23', 2026)).toBe('Tue, Jun 23');
    expect(dayHeader('2025-06-23', 2026)).toBe('Mon, Jun 23, 2025');
  });
  it('groups consecutive rows on the same date, keeping order', () => {
    const g = groupByDay([{ date: '2026-06-23', id: 1 }, { date: '2026-06-23', id: 2 }, { date: '2026-06-21', id: 3 }]);
    expect(g.map(d => [d.date, d.rows.length])).toEqual([['2026-06-23', 2], ['2026-06-21', 1]]);
  });
});

describe('filterTxns', () => {
  const rows = [
    { payee: 'Safeway', account: 'Sapphire', category: 'Groceries', amount: -111.21 },
    { payee: 'Venmo', account: 'Checking', category: 'Miscellaneous', amount: -40 },
    { payee: 'Acme payroll', account: 'Checking', category: 'Paychecks', amount: 3120.44 },
    { payee: 'Refund', account: 'Sapphire', category: 'Miscellaneous', amount: 25 },
  ];
  it('passes everything with no filters', () => {
    expect(filterTxns(rows, NO_FILTERS)).toHaveLength(4);
  });
  it('category, account, needs-a-category, amount and search combine', () => {
    expect(filterTxns(rows, { ...NO_FILTERS, category: 'Groceries' }).map(r => r.payee)).toEqual(['Safeway']);
    expect(filterTxns(rows, { ...NO_FILTERS, account: 'Checking' })).toHaveLength(2);
    expect(filterTxns(rows, { ...NO_FILTERS, needsCategory: true }).map(r => r.payee)).toEqual(['Venmo']);
    expect(filterTxns(rows, { ...NO_FILTERS, amount: 'over100' })).toHaveLength(2);
    expect(filterTxns(rows, { ...NO_FILTERS, q: 'sapph' })).toHaveLength(2);
    expect(filterTxns(rows, { ...NO_FILTERS, account: 'Sapphire', amount: 'in' }).map(r => r.payee)).toEqual(['Refund']);
  });
  it('needsCategory only counts expenses', () => {
    expect(needsCategory({ category: 'Miscellaneous', amount: 25 })).toBe(false);
  });
});

describe('amountMatches', () => {
  it('compares sizes, and splits in from out', () => {
    expect(amountMatches(-150, 'over100')).toBe(true);
    expect(amountMatches(150, 'over100')).toBe(true);
    expect(amountMatches(-6, 'under20')).toBe(true);
    expect(amountMatches(-6, 'in')).toBe(false);
    expect(amountMatches(-6, 'out')).toBe(true);
    expect(amountMatches(-600, 'over500')).toBe(true);
  });
});

describe('inOutMortgage', () => {
  it('sums by sign and keeps the mortgage apart, whatever its sign', () => {
    expect(inOutMortgage([
      { category: 'Paychecks', amount: 3000 },
      { category: 'Groceries', amount: -200 },
      { category: 'Groceries', amount: 20 },
      { category: 'Mortgage', amount: -2800 },
      { category: 'Mortgage', amount: 100 },
    ])).toEqual({ inflow: 3020, outflow: 200, mortgage: 2900 });
  });
});
