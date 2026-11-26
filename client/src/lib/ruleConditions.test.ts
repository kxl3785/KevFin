import { describe, it, expect } from 'vitest';
import { chipLabel, combinedSpec, defaultSelection, isEmptySpec, maskAmounts, toggleCondition, worthOffering, type RuleCondition } from './ruleConditions.ts';

const merchant: RuleCondition = { key: 'merchant', kind: 'merchant', label: 'Merchant is “Blue Bottle”', spec: { base: 'blue bottle' }, count: 4 };
const amount: RuleCondition = { key: 'amount', kind: 'amount', label: 'Amount is exactly $5.50', spec: { amount: 5.5 }, count: 9 };
const bottle: RuleCondition = { key: 'text:bottle', kind: 'text', label: 'Text contains “bottle”', spec: { contains: 'bottle' }, count: 6 };
const coffee: RuleCondition = { key: 'text:coffee', kind: 'text', label: 'Text contains “coffee”', spec: { contains: 'coffee' }, count: 12 };
const all = [merchant, amount, bottle, coffee];

describe('rule conditions', () => {
  it('ticks the payee condition by default, and nothing else', () => {
    expect([...defaultSelection(all)]).toEqual(['merchant']);
    expect(defaultSelection([amount, bottle]).size).toBe(0);
  });

  it('ANDs the ticked conditions into one spec', () => {
    expect(combinedSpec(all, new Set(['merchant', 'amount']))).toEqual({ base: 'blue bottle', amount: 5.5 });
    expect(combinedSpec(all, new Set())).toEqual({});
    expect(isEmptySpec({})).toBe(true);
    expect(isEmptySpec({ amount: 0 })).toBe(false);
  });

  it('keeps at most one text condition ticked', () => {
    let sel = toggleCondition(all, new Set(['merchant']), 'text:bottle');
    expect([...sel].sort()).toEqual(['merchant', 'text:bottle']);
    sel = toggleCondition(all, sel, 'text:coffee');
    expect([...sel].sort()).toEqual(['merchant', 'text:coffee']);
    sel = toggleCondition(all, sel, 'text:coffee');
    expect([...sel]).toEqual(['merchant']);
    // Unknown keys change nothing; the input set is never mutated.
    const before = new Set(['merchant']);
    expect([...toggleCondition(all, before, 'nope')]).toEqual(['merchant']);
    toggleCondition(all, before, 'amount');
    expect([...before]).toEqual(['merchant']);
  });

  it('offers the popup only when a rule could carry forward', () => {
    expect(worthOffering([merchant])).toBe(true);
    expect(worthOffering([amount])).toBe(false);
    expect(worthOffering([amount, { ...bottle, count: 1 }])).toBe(false);
    expect(worthOffering([amount, bottle])).toBe(true);
  });

  it('masks amounts in privacy mode only', () => {
    expect(maskAmounts('Amount is exactly $1,092.03', true)).toBe('Amount is exactly ••••••');
    expect(maskAmounts('Amount $5.50', false)).toBe('Amount $5.50');
    expect(maskAmounts('Merchant is “Blue Bottle”', true)).toBe('Merchant is “Blue Bottle”');
  });

  it('shortens the labels for chips', () => {
    expect(all.map(chipLabel)).toEqual(['Payee “Blue Bottle”', 'Amount $5.50', 'Contains “bottle”', 'Contains “coffee”']);
  });
});
