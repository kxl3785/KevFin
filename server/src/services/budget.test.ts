import { describe, it, expect } from 'vitest';
import { autoCategory, displayPayee } from './budget.js';

describe('autoCategory', () => {
  describe('precedence rules (checked before the keyword table)', () => {
    it('detects credit-card payments first', () => {
      expect(autoCategory('CHASE', 'Payment Thank You - Mobile', -500)).toBe('Credit Card Payment');
      expect(autoCategory('', 'AUTOPAY VISA', -500)).toBe('Credit Card Payment');
    });
    it('detects internal transfers', () => {
      expect(autoCategory('', 'Online Transfer to Savings', -1000)).toBe('Transfers');
      // a transfer keyword wins over a merchant keyword in the same string
      expect(autoCategory('', 'Transfer to Amazon', -200)).toBe('Transfers');
    });
    it('keeps P2P (Zelle/Venmo/Cash App) out of Transfers so it stays categorizable', () => {
      expect(autoCategory('Zelle', 'payment to John', -50)).toBe('Miscellaneous');
      expect(autoCategory('Venmo', 'transfer to roommate', -75)).not.toBe('Transfers');
    });
    it('detects mortgage payments', () => {
      expect(autoCategory('Rocket Mortgage', 'Payment', -2500)).toBe('Mortgage');
      expect(autoCategory('PENNYMAC', 'home loan', -2200)).toBe('Mortgage');
    });
  });

  describe('income (positive amounts)', () => {
    it('classifies paychecks', () => {
      expect(autoCategory('ACME CORP', 'PAYROLL DIRECT DEP', 5000)).toBe('Paychecks');
    });
    it('classifies dividends and interest', () => {
      expect(autoCategory('VANGUARD', 'DIVIDEND', 120)).toBe('Dividends & Capital Gains');
      expect(autoCategory('ALLY BANK', 'Interest Payment', 12)).toBe('Dividends & Capital Gains');
    });
    it('falls back to Other Income', () => {
      expect(autoCategory('Someone', 'Reimbursement', 200)).toBe('Other Income');
    });
  });

  describe('expense keyword table', () => {
    it('maps common merchants to their category', () => {
      expect(autoCategory('Starbucks', '', -6)).toBe('Coffee Shops');
      expect(autoCategory('Shell Gas Station', '', -45)).toBe('Gas');
      expect(autoCategory('Whole Foods Market', '', -88)).toBe('Groceries');
      expect(autoCategory('Adobe', 'monthly', -55)).toBe('Subscriptions');
    });
    it('falls back to Miscellaneous when nothing matches', () => {
      expect(autoCategory('Joe Unknown Vendor', '', -30)).toBe('Miscellaneous');
    });
  });
});

describe('displayPayee', () => {
  it('surfaces the counterparty name for P2P transfers', () => {
    expect(displayPayee('Zelle payment', 'John Smith')).toBe('John Smith');
  });

  it('pulls the real merchant out of aggregator descriptors', () => {
    expect(displayPayee('PayPal', 'PAYPAL *STEAM GAMES')).toBe('STEAM GAMES');
    expect(displayPayee('SQ *Blue Bottle', '')).toBe('Blue Bottle');
  });

  it('strips trailing bank reference ids', () => {
    expect(displayPayee('ARAGON 29618049464', '')).toBe('ARAGON');
  });

  it('leaves an already-clean payee untouched (Amazon star is just a ref)', () => {
    expect(displayPayee('Amazon', 'AMAZON MKTPL*X1239A')).toBe('Amazon');
  });

  it('falls back to Unknown when there is nothing to show', () => {
    expect(displayPayee('', '')).toBe('Unknown');
  });
});
