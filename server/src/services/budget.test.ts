import { describe, it, expect } from 'vitest';
import { autoCategory, displayPayee, isInternalTransfer, isDuplicateTxn, acctLast4, type DupTxn } from './budget.js';

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
    it('maps energy / utility providers to Gas & Electric', () => {
      expect(autoCategory('Atmos Energy', '', -90)).toBe('Gas & Electric');
      expect(autoCategory('Octopus Energy', '', -140)).toBe('Gas & Electric');
      expect(autoCategory('Reliant Energy', '', -160)).toBe('Gas & Electric');
      expect(autoCategory('TXU Energy', '', -130)).toBe('Gas & Electric');
      // A coffee brand with "Energy"-adjacent naming must not be mis-flagged: the
      // coffee rule wins on order. ("Green Mountain" is both a coffee and energy co.)
      expect(autoCategory('Green Mountain Coffee', '', -14)).toBe('Coffee Shops');
    });
    it('maps water utilities to Water', () => {
      expect(autoCategory('Dallas Water Utilities', '', -75)).toBe('Water');
      expect(autoCategory('City of Austin Water', '', -60)).toBe('Water');
      expect(autoCategory('EPCOR Water', '', -55)).toBe('Water');
    });
    it('maps recurring household services to Home Services', () => {
      expect(autoCategory('Blue Wave Pool Service', '', -180)).toBe('Home Services');
      expect(autoCategory('Green Lawn Landscaping', '', -150)).toBe('Home Services');
      expect(autoCategory('Merry Maids', '', -160)).toBe('Home Services');
      expect(autoCategory('ABC Pest Control', '', -65)).toBe('Home Services');
    });
    it('falls back to Miscellaneous when nothing matches', () => {
      expect(autoCategory('Joe Unknown Vendor', '', -30)).toBe('Miscellaneous');
    });
  });
});

describe('isInternalTransfer (cash-flow spending exclusion)', () => {
  it('always treats account-to-account Transfers as internal', () => {
    expect(isInternalTransfer('Transfers', true)).toBe(true);
    expect(isInternalTransfer('Transfers', false)).toBe(true);
  });

  it('excludes credit-card payments only when the card is tracked', () => {
    // Card connected → its purchases are counted, so the payment is just an internal move.
    expect(isInternalTransfer('Credit Card Payment', true)).toBe(true);
    // Card NOT connected → the payment is the only record of that spending; must count.
    expect(isInternalTransfer('Credit Card Payment', false)).toBe(false);
  });

  it('never excludes ordinary spending or income categories', () => {
    for (const tracked of [true, false]) {
      expect(isInternalTransfer('Groceries', tracked)).toBe(false);
      expect(isInternalTransfer('Mortgage', tracked)).toBe(false);
      expect(isInternalTransfer('Paychecks', tracked)).toBe(false);
    }
  });
});

describe('isDuplicateTxn (import vs SimpleFIN dedup)', () => {
  const DAY = 86400_000;
  const mk = (over: Partial<DupTxn>): DupTxn => ({ amount: -100, day: Date.parse('2026-06-15T00:00:00Z'), merchant: 'acme', acct: '1234', ...over });

  it('matches the same charge posted a couple days apart (date drift between feed and CSV)', () => {
    const feed = mk({ day: Date.parse('2026-06-15T00:00:00Z') });
    const csv = mk({ day: Date.parse('2026-06-13T00:00:00Z') });
    expect(isDuplicateTxn(csv, feed)).toBe(true);
  });

  it('matches on account when the merchant is worded differently', () => {
    // The real bug: "Reformed Radiolo Payroll" (feed) vs "Reformed Radiology" (CSV),
    // same paycheck, same account ending 2032, two days apart.
    const feed = mk({ amount: 18304, merchant: 'reformed radiolo payroll', acct: '2032', day: Date.parse('2026-06-15T00:00:00Z') });
    const csv = mk({ amount: 18304, merchant: 'reformed radiology', acct: '2032', day: Date.parse('2026-06-13T00:00:00Z') });
    expect(isDuplicateTxn(csv, feed)).toBe(true);
  });

  it('matches on merchant when the account is unknown on one side', () => {
    const feed = mk({ merchant: 'netflix', acct: '1234' });
    const csv = mk({ merchant: 'netflix', acct: '', day: Date.parse('2026-06-16T00:00:00Z') });
    expect(isDuplicateTxn(csv, feed)).toBe(true);
  });

  it('does NOT match a different amount', () => {
    expect(isDuplicateTxn(mk({ amount: -100 }), mk({ amount: -100.01 }))).toBe(false);
  });

  it('does NOT match outside the date window (genuine same-amount repeat)', () => {
    const a = mk({ day: Date.parse('2026-06-01T00:00:00Z') });
    const b = mk({ day: Date.parse('2026-06-10T00:00:00Z') });
    expect(isDuplicateTxn(a, b)).toBe(false);
  });

  it('does NOT match when neither merchant nor account line up', () => {
    expect(isDuplicateTxn(mk({ merchant: 'acme', acct: '1111' }), mk({ merchant: 'globex', acct: '2222' }))).toBe(false);
  });

  it('treats two empty secondary keys as no-match (amount+date alone is too weak)', () => {
    expect(isDuplicateTxn(mk({ merchant: '', acct: '' }), mk({ merchant: '', acct: '' }))).toBe(false);
  });
});

describe('acctLast4', () => {
  it('pulls the trailing 4 digits from an account name', () => {
    expect(acctLast4('Chase Sapphire Preferred (4167)')).toBe('4167');
    expect(acctLast4('J K Joint (...2032)')).toBe('2032');
    expect(acctLast4('Robinhood Credit Card **4284 (4284)')).toBe('4284');
  });
  it('returns empty string when there is no 4-digit tail', () => {
    expect(acctLast4('Checking')).toBe('');
    expect(acctLast4('')).toBe('');
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
