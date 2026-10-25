import { describe, it, expect } from 'vitest';
import { ruleStatus, ruleTypeTag, filterRules, filterAuto, categoryOptions, maskMoney, plural, type RuleReview, type AutoMerchant } from './rulesReview.ts';

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
