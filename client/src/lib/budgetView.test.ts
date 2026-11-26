import { describe, it, expect } from 'vitest';
import { resolveBudgetTab, stepMonth, dayHeader, groupByDay, filterTxns, amountMatches, inOutMortgage, NO_FILTERS, needsCategory, categoryGroups, excludedCategoryNames, healCategoryPrefs, parseBudgetInput, type ListCat } from './budgetView.ts';

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

describe('categoryGroups (the Overview categories card)', () => {
  // A month like the tester's: $697 of flexible spending against a $2,880
  // budget, one bill, and a $2,800 mortgage as the excluded reference row.
  const byCategory: ListCat[] = [
    { category: 'Groceries', spent: 450, count: 6, target: 600 },
    { category: 'Dining', spent: 247, count: 4, target: 280 },
    { category: 'Gas & Electric', spent: 110, count: 1, target: 0 },
    { category: 'Travel', spent: 0, count: 0, target: 24000, period: 'annual' },
    { category: 'Mortgage', spent: 2800, count: 1, target: 0, excluded: true },
  ];
  const groups = [{ categories: [{ name: 'Groceries', canonical: 'Groceries' }, { name: 'Mortgage', canonical: 'Mortgage' }, { name: 'Coffee', canonical: 'Coffee' }] }];
  const categories = ['Coffee', 'Dining', 'Gas & Electric', 'Groceries', 'Mortgage', 'Travel'];
  const run = (hidden: string[], extra: string[], topN = 10) => categoryGroups({
    byCategory, billNames: ['Gas & Electric'], hidden, extra, categories,
    excludedNames: excludedCategoryNames(byCategory, groups), topN,
    blank: name => ({ category: name, spent: 0, count: 0, target: 0 }),
  });
  const names = (rows: ListCat[]) => rows.map(c => c.category);

  it('keeps the mortgage out of the groups, their subtotals and "Add category"', () => {
    const g = run([], []);
    expect(names(g.flexible)).toEqual(['Groceries', 'Dining', 'Travel']);
    expect(names(g.bills)).toEqual(['Gas & Electric']);
    expect(names(g.excluded)).toEqual(['Mortgage']);
    expect(g.flexSpent).toBe(697);
    expect(g.flexBudget).toBe(2880); // 600 + 280 + 24,000 / 12
    expect(g.insertable).toEqual(['Coffee']);
  });

  it('hiding the mortgage and then adding it back leaves it a reference row (the tester\'s steps)', () => {
    // The saved state an older build produced: Mortgage in both lists.
    for (const [hidden, extra] of [[['Mortgage'], ['Mortgage']], [[], ['Mortgage']], [['Mortgage'], []]]) {
      const g = run(hidden, extra);
      expect(names(g.flexible)).toEqual(['Groceries', 'Dining', 'Travel']);
      expect(g.flexSpent).toBe(697); // not $3,497
      expect(g.flexBudget).toBe(2880);
      expect(names(g.excluded)).toEqual(['Mortgage']);
      expect(g.insertable).not.toContain('Mortgage');
      expect(g.hidden.names).toEqual([]);
    }
  });

  it('a month with no mortgage payment still never offers it', () => {
    const g = categoryGroups({
      byCategory: byCategory.filter(c => !c.excluded), billNames: [], hidden: [], extra: ['Mortgage'], categories,
      excludedNames: excludedCategoryNames(byCategory.filter(c => !c.excluded), groups), topN: 10,
      blank: name => ({ category: name, spent: 0, count: 0, target: 0 }),
    });
    expect(names(g.flexible)).not.toContain('Mortgage');
    expect(g.insertable).not.toContain('Mortgage');
  });

  it('knows a renamed mortgage by its canonical name', () => {
    const ex = excludedCategoryNames([], [{ categories: [{ name: 'Home loan', canonical: 'Mortgage' }] }]);
    expect(ex.has('Home loan')).toBe(true);
  });

  it('reports hidden categories with spending, and what the top-N cut leaves out', () => {
    const g = run(['Dining', 'Gas & Electric', 'Coffee'], [], 1);
    expect(names(g.flexible)).toEqual(['Groceries']);
    expect(g.bills).toEqual([]);
    expect(g.hidden).toEqual({ names: ['Dining', 'Gas & Electric'], spent: 357 }); // Coffee has no spend
    expect(g.rest).toEqual({ count: 1, spent: 0 }); // Travel, past the top 1
    expect(g.insertable).toEqual(['Coffee', 'Dining', 'Gas & Electric', 'Travel']);
  });

  it('adds an inserted category, at $0 when it has no row this month', () => {
    const g = run([], ['Coffee']);
    expect(g.flexible.at(-1)).toEqual({ category: 'Coffee', spent: 0, count: 0, target: 0 });
    expect(g.insertable).toEqual([]);
  });
});

describe('healCategoryPrefs', () => {
  const ex = new Set(['Mortgage']);
  it('drops excluded categories from the saved hidden and added lists', () => {
    expect(healCategoryPrefs(['Mortgage', 'Coffee'], ['Mortgage'], ex)).toEqual({ hidden: ['Coffee'], extra: [] });
  });
  it('returns null when there is nothing to clean', () => {
    expect(healCategoryPrefs(['Coffee'], ['Dining'], ex)).toBeNull();
  });
});

describe('parseBudgetInput', () => {
  it('reads plausible amounts', () => {
    expect(parseBudgetInput('300')).toEqual({ kind: 'amount', value: 300 });
    expect(parseBudgetInput(' $1,250.50 ')).toEqual({ kind: 'amount', value: 1250.5 });
    expect(parseBudgetInput('1.5k')).toEqual({ kind: 'amount', value: 1500 });
    expect(parseBudgetInput('$2M')).toEqual({ kind: 'amount', value: 2000000 });
    expect(parseBudgetInput('1.15m')).toEqual({ kind: 'amount', value: 1150000 });
    expect(parseBudgetInput('0')).toEqual({ kind: 'amount', value: 0 }); // clears a budget deliberately
    expect(parseBudgetInput('.5')).toEqual({ kind: 'amount', value: 0.5 });
  });
  it('treats blank as nothing to save', () => {
    expect(parseBudgetInput('')).toEqual({ kind: 'blank' });
    expect(parseBudgetInput('   ')).toEqual({ kind: 'blank' });
  });
  it('rejects junk mixed with digits instead of saving the digits', () => {
    for (const s of ['abc30', 'abc', '30abc', '3o0', '-50', '1,2,3', '12,34', '$', 'k', '5kk', '1.2.3', '30 dollars']) {
      expect(parseBudgetInput(s)).toEqual({ kind: 'invalid' });
    }
  });
});
