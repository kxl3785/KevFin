import { describe, it, expect } from 'vitest';
import {
  ruleStatus, ruleTypeTag, filterRules, filterAuto, categoryOptions, maskMoney, plural,
  filterByKind, sortRules, needsAttention, isAttention, groupByCategory, normalizeRulesView, DEFAULT_RULES_VIEW,
  type RuleReview, type AutoMerchant,
} from './rulesReview.ts';

const rule = (o: Partial<RuleReview>): RuleReview => ({
  id: 1, kind: 'merchant', conditions: [{ field: 'merchant', value: 'Amazon Mktp' }], description: 'Merchant is “Amazon Mktp”', category: 'Shopping',
  matched: 0, shadowed: 0, total: 0, lastMatched: null, samples: [], createdAt: '', ...o,
});
const auto = (o: Partial<AutoMerchant>): AutoMerchant => ({ merchant: 'shell oil', payee: 'Shell Oil', category: 'Gas', count: 3, total: 90, lastDate: '2026-05-01', ...o });

describe('ruleStatus', () => {
  it('classifies active, shadowed and unused rules', () => {
    expect(ruleStatus({ matched: 3, shadowed: 2 })).toBe('active');
    expect(ruleStatus({ matched: 0, shadowed: 2 })).toBe('shadowed');
    expect(ruleStatus({ matched: 0, shadowed: 0 })).toBe('unused');
  });
});

describe('filters', () => {
  const rules = [rule({ id: 1 }), rule({ id: 2, kind: 'base', conditions: [{ field: 'merchant_like', value: 'Shell Oil' }], description: 'Merchants like “Shell Oil”', category: 'Gas' })];
  it('searches description and category, case-insensitively', () => {
    expect(filterRules(rules, 'AMAZON', '').map(r => r.id)).toEqual([1]);
    expect(filterRules(rules, 'gas', '').map(r => r.id)).toEqual([2]);
    expect(filterRules(rules, '  ', '')).toHaveLength(2);
  });
  it('searches condition values', () => {
    const smart = rule({ id: 3, kind: 'smart', description: 'Merchant “Verizon Wireless” and amount is $85.00', category: 'Bills',
      conditions: [{ field: 'merchant_like', value: 'Verizon Wireless' }, { field: 'amount', value: '$85.00' }] });
    expect(filterRules([...rules, smart], '$85', '').map(r => r.id)).toEqual([3]);
    expect(filterRules([...rules, smart], 'verizon', '').map(r => r.id)).toEqual([3]);
  });
  it('filters by exact category', () => {
    expect(filterRules(rules, '', 'Gas').map(r => r.id)).toEqual([2]);
    expect(filterRules(rules, 'amazon', 'Gas')).toEqual([]);
  });
  it('filters auto merchants by payee, merchant key or category', () => {
    const list = [auto({}), auto({ merchant: 'trader joes', payee: 'Trader Joe’s', category: 'Groceries' })];
    expect(filterAuto(list, 'trader', '')).toHaveLength(1);
    expect(filterAuto(list, 'shell', '')).toHaveLength(1);
    expect(filterAuto(list, '', 'Groceries')).toHaveLength(1);
  });
  it('lists distinct sorted category labels', () => {
    expect(categoryOptions({ rules, auto: [auto({ category: 'Groceries' }), auto({})] })).toEqual(['Gas', 'Groceries', 'Shopping']);
  });
});

describe('ruleTypeTag', () => {
  const c = (n: number) => Array.from({ length: n }, () => ({ field: 'text' as const, value: 'x' }));
  it('names the rule type', () => {
    expect(ruleTypeTag({ kind: 'merchant', conditions: c(1) })).toBe('Exact merchant');
    expect(ruleTypeTag({ kind: 'base', conditions: c(1) })).toBe('Similar merchants');
    expect(ruleTypeTag({ kind: 'smart', conditions: c(1) })).toBe('If');
    expect(ruleTypeTag({ kind: 'smart', conditions: c(3) })).toBe('All of');
  });
});

describe('display helpers', () => {
  it('masks money in privacy mode only', () => {
    expect(maskMoney(5, true, n => `$${n}`)).toBe('••••');
    expect(maskMoney(5, false, n => `$${n}`)).toBe('$5');
  });
  it('pluralizes', () => {
    expect(plural(1, 'transaction')).toBe('1 transaction');
    expect(plural(2, 'transaction')).toBe('2 transactions');
  });
});

describe('organizing the rules list', () => {
  const rule = (o: Partial<RuleReview> & { id: number }): RuleReview => ({
    kind: 'merchant', conditions: [{ field: 'merchant', value: `M${o.id}` }], description: `Merchant is “M${o.id}”`,
    category: 'Groceries', matched: 0, shadowed: 0, total: 0, lastMatched: null, samples: [], createdAt: '2026-01-01 00:00:00', ...o,
  });
  const ids = (rs: RuleReview[]) => rs.map(r => r.id);
  const rs = [
    rule({ id: 1, kind: 'merchant', matched: 5, total: 100, lastMatched: '2026-05-01', createdAt: '2026-01-03 00:00:00', conditions: [{ field: 'merchant', value: 'Whole Foods' }] }),
    rule({ id: 2, kind: 'base', matched: 0, shadowed: 3, createdAt: '2026-02-01 00:00:00', category: 'Gas', conditions: [{ field: 'merchant_like', value: 'shell' }] }),
    rule({ id: 3, kind: 'smart', matched: 5, total: 300, lastMatched: '2026-06-10', createdAt: '2026-01-02 00:00:00', category: 'Gas', conditions: [{ field: 'text', value: 'Arco' }] }),
    rule({ id: 4, kind: 'smart', matched: 0, shadowed: 0, createdAt: '2026-03-01 00:00:00', conditions: [{ field: 'text', value: 'aldi' }, { field: 'amount', value: '$5.00' }] }),
  ];

  it('filters by kind', () => {
    expect(ids(filterByKind(rs, 'all'))).toEqual([1, 2, 3, 4]);
    expect(ids(filterByKind(rs, 'smart'))).toEqual([3, 4]);
    expect(ids(filterByKind(rs, 'base'))).toEqual([2]);
  });

  it('sorts by use (ties by dollar total, then id), recency, age and name', () => {
    expect(ids(sortRules(rs, 'used'))).toEqual([3, 1, 2, 4]);
    expect(ids(sortRules(rs, 'recent'))).toEqual([3, 1, 2, 4]); // never-matched last, in id order
    expect(ids(sortRules(rs, 'newest'))).toEqual([4, 2, 1, 3]);
    expect(ids(sortRules(rs, 'az'))).toEqual([4, 3, 2, 1]); // aldi, Arco, shell, Whole Foods — case-insensitive
    expect(ids(rs)).toEqual([1, 2, 3, 4]); // input untouched
  });

  it('collects the rules that decide nothing', () => {
    const a = needsAttention(rs);
    expect(ids(a.shadowed)).toEqual([2]);
    expect(ids(a.unused)).toEqual([4]);
    expect(rs.filter(isAttention).map(r => r.id)).toEqual([2, 4]);
  });

  it('groups by category A–Z, keeping the given order and summing each group', () => {
    const g = groupByCategory(sortRules(rs, 'used'));
    expect(g.map(x => [x.category, ids(x.rules), x.matched, x.total])).toEqual([
      ['Gas', [3, 2], 5, 300],
      ['Groceries', [1, 4], 5, 100],
    ]);
  });

  it('repairs a saved view', () => {
    expect(normalizeRulesView(undefined)).toEqual(DEFAULT_RULES_VIEW);
    expect(normalizeRulesView({ sort: 'az', grouped: false })).toEqual({ sort: 'az', grouped: false });
    expect(normalizeRulesView({ sort: 'bogus', grouped: 'yes' })).toEqual(DEFAULT_RULES_VIEW);
  });
});
