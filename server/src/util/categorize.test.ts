import { describe, it, expect } from 'vitest';
import { categorize, CATEGORIES } from './categorize.js';

describe('categorize', () => {
  it('classifies credit cards', () => {
    expect(categorize('Chase Sapphire Preferred')).toBe('credit');
    expect(categorize('Visa Signature')).toBe('credit');
    expect(categorize('Amex Platinum')).toBe('credit');
    expect(categorize('American Express Gold')).toBe('credit');
    expect(categorize('Capital One Venture')).toBe('credit');
    expect(categorize('Freedom Unlimited')).toBe('credit');
    expect(categorize('Discover it Card')).toBe('credit'); // \bcard\b
  });

  it('classifies brokerage / investment accounts', () => {
    expect(categorize('Roth IRA')).toBe('brokerage');
    expect(categorize('Fidelity 401(k)')).toBe('brokerage');
    expect(categorize('Vanguard Brokerage')).toBe('brokerage');
    expect(categorize('529 College Plan')).toBe('brokerage');
    expect(categorize('Crypto Wallet')).toBe('brokerage');
    expect(categorize('Joint TOD')).toBe('brokerage');
    expect(categorize('HSA Investment')).toBe('brokerage');
  });

  it('classifies banking accounts', () => {
    expect(categorize('Total Checking')).toBe('banking');
    expect(categorize('High Yield Savings')).toBe('banking');
    expect(categorize('Cash Management')).toBe('banking');
    expect(categorize('Money Market')).toBe('banking');
    expect(categorize('Bank of America')).toBe('banking'); // \bbank\b
  });

  it('defaults to other when nothing matches', () => {
    expect(categorize('Auto Loan')).toBe('other');
    expect(categorize('Something Unknown')).toBe('other');
    expect(categorize('')).toBe('other');
  });

  it('honors precedence: credit > brokerage > banking', () => {
    // First matching rule wins, in source order.
    expect(categorize('Credit Card Checking')).toBe('credit');   // credit before banking
    expect(categorize('Investment Savings')).toBe('brokerage');  // brokerage before banking
  });

  it('is case-insensitive', () => {
    expect(categorize('CHECKING')).toBe('banking');
    expect(categorize('roth ira')).toBe('brokerage');
  });

  it('always returns a member of CATEGORIES', () => {
    for (const name of ['Visa', 'Roth IRA', 'Checking', 'random', '']) {
      expect(CATEGORIES).toContain(categorize(name));
    }
  });
});
