import { describe, it, expect } from 'vitest';
import { isBill, billCategories, BILL_SHARE } from './bills.js';

describe('isBill', () => {
  it('needs recurring charges', () => {
    expect(isBill(0, 400)).toBe(false);
    expect(isBill(-5, 400)).toBe(false);
  });
  it('is a bill at half the typical monthly spend or more', () => {
    expect(BILL_SHARE).toBe(0.5);
    expect(isBill(200, 400)).toBe(true);
    expect(isBill(185, 185)).toBe(true);
    expect(isBill(199.99, 400)).toBe(false);
  });
  it('counts recurring charges with no spending history as a bill', () => {
    expect(isBill(50, 0)).toBe(true);
  });
});

describe('billCategories', () => {
  const typical = new Map([
    ['Fitness', 185], ['Groceries', 850], ['Internet & Phone', 180], ['Shopping', 400],
  ]);
  it('groups recurring items by category and keeps the ones that pass', () => {
    const out = billCategories([
      { category: 'Fitness', payee: 'Equinox', monthlyAvg: 185 },
      { category: 'Internet & Phone', payee: 'Comcast', monthlyAvg: 89.99 },
      { category: 'Internet & Phone', payee: 'Verizon', monthlyAvg: 85 },
      { category: 'Shopping', payee: 'Amazon Prime', monthlyAvg: 12, annual: true },
      { category: 'Groceries', payee: 'Milk delivery', monthlyAvg: 30 },
    ], typical);
    expect(out.map(b => b.category)).toEqual(['Fitness', 'Internet & Phone']);
    const net = out.find(b => b.category === 'Internet & Phone')!;
    expect(net.recurringMonthly).toBe(174.99);
    expect(net.share).toBe(0.97);
    expect(net.items.map(i => i.payee)).toEqual(['Comcast', 'Verizon']);
  });
  it('a hand-added bill in a category with no history is a bill, with no share', () => {
    const [b] = billCategories([{ category: 'Pet Insurance', payee: 'Trupanion', monthlyAvg: 40 }], typical);
    expect(b).toMatchObject({ category: 'Pet Insurance', typicalMonthly: 0, share: null });
  });
  it('skips the categories it is told to and zero-amount items', () => {
    const out = billCategories([
      { category: 'Mortgage', payee: 'Loan servicer', monthlyAvg: 2800 },
      { category: 'Fitness', payee: 'Free trial', monthlyAvg: 0 },
    ], typical, new Set(['Mortgage']));
    expect(out).toEqual([]);
  });
});
