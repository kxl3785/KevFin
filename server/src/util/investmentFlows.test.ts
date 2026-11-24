import { describe, it, expect } from 'vitest';
import {
  classifyInvestmentTxn, classifyBankIncome, detectFlows, parseFlowOverrides, incomeSummary, type InvestmentTxn,
} from './investmentFlows.js';

const c = (description: string, amount: number) => classifyInvestmentTxn({ description, amount });

describe('classifyInvestmentTxn', () => {
  it('reads the demo seed brokerage line as dividend income, not a deposit', () => {
    expect(c('VANGUARD DIVIDEND REINVEST', 180.5)).toEqual({ kind: 'income', income: 'dividend' });
  });

  it('recognises income lines', () => {
    expect(c('DIVIDEND RECEIVED VANGUARD TOTAL STOCK', 42)).toEqual({ kind: 'income', income: 'dividend' });
    expect(c('INTEREST EARNED ON CASH', 3.1)).toEqual({ kind: 'income', income: 'interest' });
    expect(c('LONG-TERM CAP GAIN DIST VTI', 12)).toEqual({ kind: 'income', income: 'capitalGain' });
    expect(c('LT CG DISTRIBUTION', 12)).toEqual({ kind: 'income', income: 'capitalGain' });
    expect(c('RETURN OF CAPITAL', 5)).toEqual({ kind: 'income', income: 'dividend' });
    expect(c('FUND DISTRIBUTION', 5)).toEqual({ kind: 'income', income: 'dividend' });
  });

  it('treats buys, sells, reinvestment and sweeps as internal trades', () => {
    expect(c('YOU BOUGHT VANGUARD TOTAL STOCK MKT (VTI)', -5000)).toEqual({ kind: 'trade' });
    expect(c('YOU SOLD APPLE INC', 2500)).toEqual({ kind: 'trade' });
    expect(c('REINVESTMENT VANGUARD TOTAL STOCK', -42)).toEqual({ kind: 'trade' });
    expect(c('DIVIDEND REINVESTED', -42)).toEqual({ kind: 'trade' });
    expect(c('Bought 10 VTI @ 250.12', -2501.2)).toEqual({ kind: 'trade' });
    expect(c('FDIC INSURED DEPOSIT SWEEP', -900)).toEqual({ kind: 'trade' });
    expect(c('EXCHANGE TO VFIAX', -1000)).toEqual({ kind: 'trade' });
  });

  it('treats fees and charges as costs, not withdrawals', () => {
    expect(c('ADVISORY FEE', -75)).toEqual({ kind: 'fee' });
    expect(c('MARGIN INTEREST', -12)).toEqual({ kind: 'fee' });
    expect(c('FOREIGN TAX PAID', -1.2)).toEqual({ kind: 'fee' });
    expect(c('INTEREST', -4)).toEqual({ kind: 'fee' });
    expect(c('FEE REBATE', 10)).toEqual({ kind: 'fee' });
  });

  it('recognises deposits and withdrawals by description, with direction from the sign', () => {
    const flow = { kind: 'flow', basis: 'matched' };
    expect(c('Electronic Funds Transfer Received', 1000)).toEqual(flow);
    expect(c('CONTRIBUTION 2026', 7000)).toEqual(flow);
    expect(c('PARTIC CONTR', 500)).toEqual(flow);
    expect(c('EMPLOYER MATCH', 250)).toEqual(flow);
    expect(c('TRANSFER TO CHASE CHECKING', -2000)).toEqual(flow);
    expect(c('IRA DISTRIBUTION', -3000)).toEqual(flow);
    expect(c('FED TAX WITHHELD', -300)).toEqual(flow);
    expect(c('ROTH CONVERSION', 6500)).toEqual(flow);
    expect(c('WIRE TRANSFER IN', 10000)).toEqual(flow);
    expect(c('ACH DEPOSIT', 300)).toEqual(flow);
    expect(c('ACME CORP PAYROLL', 3120.44)).toEqual(flow);
  });

  it('counts an in-kind transfer of shares as a deposit, not a trade', () => {
    expect(c('TRANSFER OF ASSETS 100 SHARES VTI', 25000)).toEqual({ kind: 'flow', basis: 'matched' });
    expect(c('ACATS IN', 25000)).toEqual({ kind: 'flow', basis: 'matched' });
  });

  it('counts anything unrecognised as a guessed flow, never as gain', () => {
    expect(c('ROCKET MORTGAGE PMT', -2800)).toEqual({ kind: 'flow', basis: 'guessed' });
    expect(c('', 50)).toEqual({ kind: 'flow', basis: 'guessed' });
  });

  it('ignores zero and non-finite amounts', () => {
    expect(c('CONTRIBUTION', 0)).toEqual({ kind: 'ignore' });
    expect(c('CONTRIBUTION', NaN)).toEqual({ kind: 'ignore' });
  });

  it('reads payee and memo too', () => {
    expect(classifyInvestmentTxn({ payee: 'Vanguard', description: 'VTI', memo: 'Dividend', amount: 9 }))
      .toEqual({ kind: 'income', income: 'dividend' });
  });
});

// What the line DOES decides its class, not words inside a security's name.
// Realistic brokerage wording (Fidelity / Schwab / Vanguard style), with the
// class each one must get. + = money into the account.
describe('classifyInvestmentTxn on realistic brokerage lines', () => {
  const INCOME_DIV = { kind: 'income', income: 'dividend' };
  const INCOME_INT = { kind: 'income', income: 'interest' };
  const INCOME_CG = { kind: 'income', income: 'capitalGain' };
  const TRADE = { kind: 'trade' };
  const FEE = { kind: 'fee' };
  const FLOW = { kind: 'flow', basis: 'matched' };
  const cases: [string, number, object][] = [
    // Sells of funds/stocks whose NAMES carry income words → trades (RM-1)
    ['YOU SOLD SCHWAB US DIVIDEND EQUITY ETF (SCHD) (Cash)', 25_000, TRADE],
    ['YOU SOLD VANGUARD HIGH DIVIDEND YIELD ETF', 10_000, TRADE],
    ['YOU SOLD ISHARES TR CORE HIGH DIVIDEND ETF (HDV) (Cash)', 5_000, TRADE],
    ['YOU SOLD VANGUARD SPECIALIZED FUNDS DIV APP ETF (VIG) (Cash)', 5_000, TRADE],
    ['YOU SOLD ISHARES CORE DIVIDEND GROWTH ETF (DGRO)', 4_000, TRADE],
    ['YOU SOLD PINTEREST INC CL A (PINS) (Cash)', 8_000, TRADE],
    ['Sell 50 SCHD @ 80.10', 4_005, TRADE],
    ['REDEMPTION VANGUARD INTEREST RATE FUND', 2_000, TRADE],
    ['EXCHANGE FROM VANGUARD HIGH DIVIDEND YIELD', 3_000, TRADE],
    // Buys and reinvestment → trades
    ['YOU BOUGHT SCHWAB US DIVIDEND EQUITY ETF (SCHD)', -25_000, TRADE],
    ['YOU BOUGHT PINTEREST INC CL A (PINS)', -8_000, TRADE],
    ['REINVESTMENT VANGUARD HIGH DIVIDEND YIELD ETF', -42, TRADE],
    ['DIVIDEND REINVESTED SCHD', -42, TRADE],
    ['Reinvest Dividend', -18.3, TRADE],
    ['LT CAP GAIN REINVEST VTSAX', -12, TRADE],
    // Dividends, interest and fund distributions paid in → income
    ['DIVIDEND RECEIVED SCHWAB US DIVIDEND EQUITY ETF', 120, INCOME_DIV],
    ['DIVIDEND RECEIVED VANGUARD SPECIALIZED FUNDS DIV APP ETF (VIG)', 31, INCOME_DIV],
    ['DIVIDEND RECEIVED 100 SHARES', 55, INCOME_DIV],
    ['Qualified Dividend', 64.2, INCOME_DIV],
    ['VANGUARD DIVIDEND REINVEST', 180.5, INCOME_DIV],
    ['INTEREST', 3.1, INCOME_INT],
    ['INTEREST EARNED FDIC INSURED DEPOSIT', 2.4, INCOME_INT],
    ['Bank Interest', 0.87, INCOME_INT],
    ['LONG-TERM CAP GAIN DIST VTI', 12, INCOME_CG],
    ['ST CAP GAIN DISTRIBUTION', 4, INCOME_CG],
    ['FUND DISTRIBUTION', 5, INCOME_DIV],
    ['RETURN OF CAPITAL', 5, INCOME_DIV],
    // Fees and charges → costs
    ['ADVISORY FEE', -75, FEE],
    ['WIRE TRANSFER FEE', -25, FEE],
    ['MARGIN INTEREST', -12, FEE],
    ['INTEREST', -4, FEE],
    ['FOREIGN TAX PAID', -1.2, FEE],
    ['ADVISORY PROGRAM', -50, FEE],
    // Rollovers and in-kind transfers → owner money, even naming a dividend fund (RM-2)
    ['ROLLOVER DISTRIBUTION FROM 401K PLAN', 150_000, FLOW],
    ['TRANSFER OF ASSETS 100 SHARES VANGUARD HIGH DIVIDEND YIELD ETF', 12_000, FLOW],
    ['ACATS IN SCHWAB US DIVIDEND EQUITY ETF', 30_000, FLOW],
    ['TRANSFER OF ASSETS 100 SHARES VTI', 25_000, FLOW],
    ['ROLLOVER CONTRIBUTION', 50_000, FLOW],
    // Transfers, deposits and withdrawals → flows
    ['TRANSFER FROM ADVISORY ACCOUNT', 40_000, FLOW],   // "advisory" is an account name here (RM-8)
    ['TRANSFER TO ADVISORY ACCOUNT', -40_000, FLOW],
    ['Electronic Funds Transfer Received', 1_000, FLOW],
    ['TRANSFER TO CHASE CHECKING', -2_000, FLOW],
    ['CONTRIBUTION 2026', 7_000, FLOW],
    // Distributions to or from a retirement plan → flows, not fund income
    ['IRA DISTRIBUTION', -3_000, FLOW],
    ['FIDELITY IRA DISTRIBUTION', 20_000, FLOW],
    ['HSA DISTRIBUTION', 1_500, FLOW],
    ['ROTH IRA QUALIFIED DISTRIBUTION', 6_000, FLOW],
    // A dividend paid out to the bank is cash leaving, not a reinvestment (RM-7)
    ['DIVIDEND PAYMENT TRANSFERRED TO BANK', -100, FLOW],
  ];
  it.each(cases)('%s (%d)', (description, amount, expected) => {
    expect(classifyInvestmentTxn({ description, amount })).toEqual(expected);
  });
});

describe('classifyBankIncome (savings / checking)', () => {
  const cases: [string, number, string | null][] = [
    ['INTEREST PAYMENT', 150.25, 'interest'],
    ['INTEREST PAID', 12, 'interest'],
    ['Interest Earned', 4.1, 'interest'],
    ['DIVIDEND', 12.5, 'dividend'],                     // credit-union savings
    ['SHARE DIVIDEND', 3.2, 'dividend'],
    ['PINTEREST INC PAYROLL', 6_500, null],             // salary from an employer named Pinterest
    ['FIDELITY IRA DISTRIBUTION', 20_000, null],        // retirement money arriving, not income
    ['VANGUARD IRA DISTRIBUTION', 3_000, null],
    ['TRUST DISTRIBUTION', 20_000, null],
    ['OWNER DISTRIBUTION ACME LLC', 8_000, null],
    ['FUND DISTRIBUTION', 50, null],                    // never a bare distribution in a bank account
    ['CAP GAIN DISTRIBUTION', 50, null],
    ['INTEREST TRANSFER FROM CD', 40, null],            // the CD's own interest line counts it
    ['INTEREST', -4, null],                             // a charge
    ['ZELLE FROM PAT', 200, null],
  ];
  it.each(cases)('%s (%d)', (description, amount, expected) => {
    expect(classifyBankIncome({ description, amount })).toBe(expected);
  });
});

const tx = (id: string, date: string, amount: number, description: string, accountId = 'a1'): InvestmentTxn =>
  ({ id, accountId, date, amount, description, payee: '', memo: '' });

describe('detectFlows', () => {
  const txns = [
    tx('t3', '2026-03-02', 500, 'CONTRIBUTION'),
    tx('t1', '2026-01-15', 180, 'VANGUARD DIVIDEND REINVEST'),
    tx('t2', '2026-02-01', -1000, 'YOU BOUGHT VTI'),
    tx('t4', '2026-04-01', -50, 'MYSTERY LINE'),
  ];

  it('keeps only deposits/withdrawals, oldest first, included by default', () => {
    const f = detectFlows(txns, {});
    expect(f.map(x => x.id)).toEqual(['t3', 't4']);
    expect(f.every(x => x.included && !x.overridden)).toBe(true);
    expect(f[1].basis).toBe('guessed');
  });

  it('applies the user\'s exclude switch', () => {
    const f = detectFlows(txns, { t4: 'exclude', t1: 'exclude' });
    expect(f.find(x => x.id === 't4')).toMatchObject({ included: false, overridden: true });
    // Excluding a non-flow id does nothing (it never becomes a flow).
    expect(f.find(x => x.id === 't1')).toBeUndefined();
  });

  it('re-including is the same as the default', () => {
    expect(detectFlows(txns, { t3: 'include' })[0]).toMatchObject({ included: true, overridden: false });
  });

  it('handles empty input', () => {
    expect(detectFlows([], {})).toEqual([]);
  });
});

describe('parseFlowOverrides', () => {
  it('accepts only include/exclude values', () => {
    expect(parseFlowOverrides('{"a":"exclude","b":"include","c":"maybe","d":1}')).toEqual({ a: 'exclude', b: 'include' });
  });
  it('survives junk', () => {
    expect(parseFlowOverrides(undefined)).toEqual({});
    expect(parseFlowOverrides('')).toEqual({});
    expect(parseFlowOverrides('not json')).toEqual({});
    expect(parseFlowOverrides('null')).toEqual({});
    expect(parseFlowOverrides('[1,2]')).toEqual({});
  });
});

describe('incomeSummary', () => {
  it('totals the 12 complete months before today\'s month, by kind and account', () => {
    const s = incomeSummary([
      tx('d1', '2025-10-31', 99, 'DIVIDEND'),             // before the window
      tx('d2', '2025-11-01', 100, 'DIVIDEND'),            // first day of the window
      tx('i1', '2026-03-15', 2.5, 'INTEREST EARNED', 'a2'),
      tx('g1', '2026-06-15', 40, 'ST CAP GAIN', 'a1'),
      tx('d3', '2026-10-31', 60.25, 'DIVIDEND RECEIVED'), // last day of the window
      tx('d4', '2026-11-02', 70, 'DIVIDEND'),             // current month: not yet counted
      tx('r1', '2026-06-15', -40, 'REINVESTMENT'),        // trade, not income
      tx('x1', '2026-06-16', 5000, 'CONTRIBUTION'),       // a deposit, not income
    ], '2026-11-24');
    expect(s.months).toHaveLength(12);
    expect(s.months[0].month).toBe('2025-11');
    expect(s.months[11].month).toBe('2026-10');
    expect(s.from).toBe('2025-11-01');
    expect(s.to).toBe('2026-10-31');
    expect(s.months[0]).toEqual({ month: '2025-11', dividends: 100, interest: 0, capitalGains: 0, total: 100 });
    expect(s.months.find(m => m.month === '2026-03')!.interest).toBe(2.5);
    expect(s.months.find(m => m.month === '2026-06')!).toMatchObject({ capitalGains: 40, total: 40 });
    expect(s.total).toBe(202.75);                       // 100 + 2.5 + 40 + 60.25
    expect(s.nextTwelveMonths).toBe(202.75);            // the past year, repeated
    expect(s.byAccount).toEqual([{ accountId: 'a1', total: 200.25 }, { accountId: 'a2', total: 2.5 }]);
  });

  it('wraps across a January boundary', () => {
    const s = incomeSummary([], '2026-01-05');
    expect(s.months[0].month).toBe('2025-01');
    expect(s.months[11].month).toBe('2025-12');
    expect(s.to).toBe('2025-12-31');
  });

  it('is all zeros (never NaN) with no transactions', () => {
    const s = incomeSummary([], '2026-11-24');
    expect(s.total).toBe(0);
    expect(s.byAccount).toEqual([]);
    expect(s.months.every(m => m.total === 0 && Number.isFinite(m.total))).toBe(true);
  });
});

describe('incomeSummary leaves sales and payouts out of income', () => {
  it('counts a real dividend but not the sale of the dividend fund', () => {
    // 120 dividend in Mar 2026 and a 25,000 SCHD sale in Apr 2026 → 120.
    const s = incomeSummary([
      tx('d', '2026-03-15', 120, 'DIVIDEND RECEIVED SCHWAB US DIVIDEND EQUITY ETF'),
      tx('s', '2026-04-10', 25_000, 'YOU SOLD SCHWAB US DIVIDEND EQUITY ETF (SCHD) (Cash)'),
      tx('p', '2026-05-10', 8_000, 'YOU SOLD PINTEREST INC CL A (PINS) (Cash)'),
    ], '2026-11-24');
    expect(s.total).toBe(120);
    expect(s.nextTwelveMonths).toBe(120);
    expect(s.months.find(m => m.month === '2026-04')!.total).toBe(0);
    expect(s.months.find(m => m.month === '2026-05')!.interest).toBe(0);
  });

  it('uses the bank rule for bank accounts: interest yes, IRA / trust payouts and salary no', () => {
    const s = incomeSummary([
      tx('i', '2026-03-31', 41.5, 'INTEREST PAYMENT', 'chk'),
      tx('d', '2026-04-30', 12.5, 'DIVIDEND', 'chk'),
      tx('ira', '2026-05-03', 3_000, 'VANGUARD IRA DISTRIBUTION', 'chk'),
      tx('tr', '2026-03-10', 20_000, 'TRUST DISTRIBUTION', 'chk'),
      tx('pay', '2026-05-01', 6_500, 'PINTEREST INC PAYROLL', 'chk'),
      // Brokerage lines in the same call keep the brokerage rule.
      tx('fd', '2026-06-15', 9, 'FUND DISTRIBUTION', 'brk'),
    ], '2026-11-24', { bankAccountIds: new Set(['chk']) });
    expect(s.total).toBe(63);                       // 41.5 + 12.5 + 9
    expect(s.months.find(m => m.month === '2026-05')!.total).toBe(0);
    expect(s.byAccount).toEqual([{ accountId: 'chk', total: 54 }, { accountId: 'brk', total: 9 }]);
  });
});
