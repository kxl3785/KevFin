import { describe, it, expect } from 'vitest';
import { computeReturns, type ReturnsInput } from './investmentReturns.js';
import type { InvestmentTxn } from '../util/investmentFlows.js';
import type { Valuation } from '../util/returns.js';

// Fixtures only — no database. The shapes mirror the demo seed: a brokerage
// account with a quarterly "VANGUARD DIVIDEND REINVEST" line, a Roth IRA whose
// feed sends no transactions, and a savings account that pays interest.

const tx = (id: string, accountId: string, date: string, amount: number, description: string): InvestmentTxn =>
  ({ id, accountId, date, amount, description, payee: description, memo: '' });

const daily = (from: string, values: number[]): Valuation[] => values.map((value, i) => {
  const d = new Date(from + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + i);
  return { date: d.toISOString().slice(0, 10), value };
});

const BROKERAGE = { id: 'fid', name: 'Individual Brokerage', institution: 'Fidelity', balance: 1210 };
const ROTH = { id: 'roth', name: 'Roth IRA', institution: 'Vanguard', balance: 790 };
const SAVINGS = { id: 'ally', name: 'Online Savings', institution: 'Ally', balance: 45000 };

function input(over: Partial<ReturnsInput> = {}): ReturnsInput {
  // Brokerage: Nov 1: 1000 · Nov 2: 1100 (+10%) · Nov 3: 1200 (a 100 deposit,
  // no market move) · Nov 4: 1210 (+0.833…%).
  const txns = [
    tx('t-old', 'fid', '2026-10-01', 150, 'VANGUARD DIVIDEND REINVEST'), // history starts here
    tx('t-dep', 'fid', '2026-11-03', 100, 'Electronic Funds Transfer Received'),
    tx('t-buy', 'fid', '2026-11-03', -100, 'YOU BOUGHT VTI'),
  ];
  return {
    today: '2026-11-04',
    windowStart: '2026-11-01',
    investmentAccounts: [BROKERAGE, ROTH],
    observations: new Map([
      ['fid', [{ date: '2026-10-15', value: 990 }, ...daily('2026-11-01', [1000, 1100, 1200, 1210])]],
      ['roth', daily('2026-11-01', [700, 750, 760, 790])],
    ]),
    investmentTxns: txns,
    incomeAccounts: [BROKERAGE, ROTH, SAVINGS],
    incomeTxns: [...txns, tx('int-1', 'ally', '2026-06-30', 150.25, 'INTEREST PAYMENT')],
    overrides: {},
    ...over,
  };
}

describe('computeReturns', () => {
  it('removes a deposit from the return and lists it', () => {
    const r = computeReturns(input());
    const fid = r.accounts.find(a => a.id === 'fid')!;
    expect(fid.included).toBe(true);
    expect(fid.measuredFrom).toBe('2026-11-01');
    expect(fid.measuredTo).toBe('2026-11-04');
    // 1.10 × (1200 / (1100 + 100)) × (1210 / 1200) − 1 = 1.1 × 1.008333… − 1 = 10.9167%
    expect(fid.timeWeighted.periodReturn).toBeCloseTo(1.1 * (1210 / 1200) - 1, 12);
    expect(fid.timeWeighted.periodReturn).toBeCloseTo(0.1091667, 6);
    // Simple (deposit-blind) return would have been 21%.
    expect(fid.timeWeighted.annualized).toBeNull();
    expect(fid.deposits).toBe(100);
    expect(fid.withdrawals).toBe(0);
    expect(fid.gain).toBe(110); // 1210 − 1000 − 100
    expect(r.flows).toHaveLength(1);
    expect(r.flows[0]).toMatchObject({ id: 't-dep', accountName: 'Individual Brokerage', amount: 100, basis: 'matched', included: true });
  });

  it('leaves out an account whose feed sends no transactions, and says so', () => {
    const r = computeReturns(input());
    const roth = r.accounts.find(a => a.id === 'roth')!;
    expect(roth.included).toBe(false);
    expect(roth.reason).toMatch(/doesn’t send transactions/);
    expect(roth.timeWeighted.periodReturn).toBeNull();
    // Coverage: 1210 of 2000.
    expect(r.coverage).toEqual({ includedBalance: 1210, totalBalance: 2000, share: 0.605, includedCount: 1, accountCount: 2 });
    expect(r.caveats.some(c => /1 of 2 investment accounts is included, holding 61%/.test(c))).toBe(true);
    expect(r.caveats.some(c => /Dividends and interest from Roth IRA aren’t counted/.test(c))).toBe(true);
  });

  it('counts a deposit the user switched off as gain (their choice)', () => {
    const r = computeReturns(input({ overrides: { 't-dep': 'exclude' } }));
    const fid = r.accounts.find(a => a.id === 'fid')!;
    // Without the deposit: 1.1 × 1200/1100 × 1210/1200 − 1 = 1210/1000 − 1
    expect(fid.timeWeighted.periodReturn).toBeCloseTo(0.21, 12);
    expect(fid.gain).toBe(210);
    expect(fid.deposits).toBe(0);
    expect(r.flows[0]).toMatchObject({ id: 't-dep', included: false, overridden: true });
  });

  it('never starts before the first stored transaction', () => {
    // History starts Oct 1; the window starts Sep 1. The Oct 15 balance is the
    // first one on/after the transactions begin.
    const r = computeReturns(input({ windowStart: '2026-09-01' }));
    const fid = r.accounts.find(a => a.id === 'fid')!;
    expect(fid.measuredFrom).toBe('2026-10-15');
    expect(r.caveats.some(c => /measured from a later date/.test(c))).toBe(true);
  });

  it('uses the latest balance on or before the window start', () => {
    const r = computeReturns(input({ windowStart: '2026-10-20' }));
    expect(r.accounts.find(a => a.id === 'fid')!.measuredFrom).toBe('2026-10-15');
  });

  it('needs at least two balances and a recent one', () => {
    const few = computeReturns(input({ observations: new Map([['fid', [{ date: '2026-11-04', value: 1210 }]]]) }));
    expect(few.accounts.find(a => a.id === 'fid')!.reason).toMatch(/Not enough daily balances/);
    expect(few.total).toBeNull();

    const none = computeReturns(input({ observations: new Map() }));
    expect(none.accounts.find(a => a.id === 'fid')!.reason).toMatch(/No daily balances recorded yet/);

    const stale = computeReturns(input({ today: '2026-11-20' }));
    expect(stale.accounts.find(a => a.id === 'fid')!.reason).toMatch(/No balance recorded since Nov 4, 2026/);
  });

  it('combines accounts that start on different days without counting the newcomer as growth', () => {
    // A: 100 → 110 → 121 from Nov 1. B (history from Nov 2): 200 → 220.
    // Total: 100, 310, 341 with B joining at Nov 2's close.
    //   TWR = (310 − 200) / 100 × 341 / 310 − 1 = 1.1 × 1.1 − 1 = 21%
    //   MWR: −100 − 200x + 341x² = 0, x = (200 + 420) / 682 = 1/1.1 → 21%
    const A = { id: 'a', name: 'A', institution: 'X', balance: 121 };
    const B = { id: 'b', name: 'B', institution: 'X', balance: 220 };
    const r = computeReturns({
      today: '2026-11-03',
      windowStart: '2026-11-01',
      investmentAccounts: [A, B],
      observations: new Map([
        ['a', daily('2026-11-01', [100, 110, 121])],
        ['b', daily('2026-11-02', [200, 220])],
      ]),
      investmentTxns: [tx('a1', 'a', '2026-10-01', 1, 'DIVIDEND'), tx('b1', 'b', '2026-11-02', 1, 'DIVIDEND')],
      incomeAccounts: [A, B],
      incomeTxns: [],
      overrides: {},
    });
    expect(r.total).not.toBeNull();
    expect(r.total!.measuredFrom).toBe('2026-11-01');
    expect(r.total!.timeWeighted.periodReturn).toBeCloseTo(0.21, 12);
    expect(r.total!.moneyWeighted.periodReturn).toBeCloseTo(0.21, 8);
    expect(r.total!.startValue).toBe(300);
    expect(r.total!.endValue).toBe(341);
    expect(r.total!.gain).toBe(41);
    expect(r.coverage.share).toBe(1);
  });

  it('flags a lone one-day jump with no recorded deposit', () => {
    const r = computeReturns(input({
      observations: new Map([['fid', daily('2026-11-01', [1000, 1010, 2010, 2015])]]),
      investmentTxns: [tx('t-old', 'fid', '2026-10-01', 150, 'VANGUARD DIVIDEND REINVEST')],
    }));
    // 2010 / 1010 − 1 = +99.0% on Nov 3, not undone on Nov 4.
    expect(r.caveats.some(c => /Large one-day changes.*Individual Brokerage moved \+99\.0% on Nov 3, 2026/.test(c))).toBe(true);
  });

  it('warns about guessed movements', () => {
    const r = computeReturns(input({
      investmentTxns: [...input().investmentTxns, tx('odd', 'fid', '2026-11-02', 40, 'MISC CREDIT')],
    }));
    expect(r.flows.find(f => f.id === 'odd')).toMatchObject({ basis: 'guessed', included: true });
    expect(r.caveats.some(c => /1 money movement didn’t match/.test(c))).toBe(true);
  });

  it('totals dividend and interest income across investment and bank accounts', () => {
    const r = computeReturns(input());
    // Window: Nov 2025 … Oct 2026. The Oct 1 dividend (150) and Jun 30 interest (150.25).
    expect(r.income.from).toBe('2025-11-01');
    expect(r.income.to).toBe('2026-10-31');
    expect(r.income.total).toBe(300.25);
    expect(r.income.nextTwelveMonths).toBe(300.25);
    expect(r.income.byAccount).toEqual([
      { accountId: 'ally', name: 'Online Savings', total: 150.25 },
      { accountId: 'fid', name: 'Individual Brokerage', total: 150 },
    ]);
  });

  it('copes with no investment accounts at all', () => {
    const r = computeReturns({
      today: '2026-11-04', windowStart: '2025-11-04', investmentAccounts: [], observations: new Map(),
      investmentTxns: [], incomeAccounts: [], incomeTxns: [], overrides: {},
    });
    expect(r.total).toBeNull();
    expect(r.coverage.share).toBeNull();
    expect(r.flows).toEqual([]);
    expect(r.caveats[0]).toMatch(/No investment accounts/);
    expect(r.income.total).toBe(0);
  });
});

describe('computeReturns: data that can’t support a return', () => {
  const ONE = { id: 'fid', name: 'Individual Brokerage', institution: 'Fidelity', balance: 10300 };
  const CHK = { id: 'chk', name: 'Checking', institution: 'Chase', balance: 5000 };
  const base = (over: Partial<ReturnsInput> = {}): ReturnsInput => {
    const txns = [tx('t0', 'fid', '2026-10-01', 15, 'DIVIDEND RECEIVED')];
    return {
      today: '2026-11-05', windowStart: '2026-11-01',
      investmentAccounts: [ONE],
      observations: new Map([['fid', daily('2026-11-01', [10000, 10100, 0, 10200, 10300])]]),
      investmentTxns: txns, incomeAccounts: [ONE, CHK], incomeTxns: txns, overrides: {},
      ...over,
    };
  };

  it('skips a one-day zero balance instead of showing −100%', () => {
    // No flows: 10300 / 10000 − 1 = +3% for the account and the total.
    const r = computeReturns(base());
    const a = r.accounts[0];
    expect(a.included).toBe(true);
    expect(a.timeWeighted.periodReturn).toBeCloseTo(0.03, 12);
    expect(a.moneyWeighted.periodReturn).toBeCloseTo(0.03, 8);
    expect(a.gain).toBe(300);
    expect(r.total!.timeWeighted.periodReturn).toBeCloseTo(0.03, 12);
    expect(r.caveats.some(c => /looked like a failed sync and was skipped \(Individual Brokerage on Nov 3, 2026\)/.test(c))).toBe(true);
    expect(r.caveats.some(c => /Large one-day changes/.test(c))).toBe(false);
  });

  it('leaves out an account whose latest balance fell to zero with nothing recorded going out', () => {
    const r = computeReturns(base({ observations: new Map([['fid', daily('2026-11-01', [10000, 10100, 10200, 10300, 0])]]) }));
    expect(r.accounts[0].included).toBe(false);
    expect(r.accounts[0].reason).toMatch(/fell to zero on Nov 5, 2026 with no recorded withdrawal, so there isn’t enough data/);
    expect(r.accounts[0].timeWeighted.periodReturn).toBeNull();
    expect(r.total).toBeNull();
  });

  it('leaves out an account whose provider stopped sending new balances', () => {
    // The daily snapshot keeps writing the cached 100,000 as a "real" balance,
    // so the observations look current; the provider's own balance date doesn't.
    const vals = daily('2026-09-01', Array.from({ length: 85 }, (_, i) => (i < 30 ? 90_000 + i * 300 : 100_000)));
    const today = vals[vals.length - 1].date;  // 2026-11-24
    const stale = { ...ONE, balanceDate: '2026-09-30T16:00:00.000Z' };
    const r = computeReturns(base({
      today, windowStart: '2026-09-01', investmentAccounts: [stale],
      observations: new Map([['fid', vals]]),
      investmentTxns: [tx('a0', 'fid', '2026-08-01', 1, 'DIVIDEND')],
    }));
    expect(r.accounts[0].included).toBe(false);
    expect(r.accounts[0].reason).toMatch(/hasn’t sent a new balance since Sep 30, 2026/);
    expect(r.total).toBeNull();

    // A recent balance date, or none at all (unknown), keeps it in.
    for (const balanceDate of [`${today} 06:00:00`, null]) {
      const ok = computeReturns(base({
        today, windowStart: '2026-09-01', investmentAccounts: [{ ...ONE, balanceDate }],
        observations: new Map([['fid', vals]]),
        investmentTxns: [tx('a0', 'fid', '2026-08-01', 1, 'DIVIDEND')],
      }));
      expect(ok.accounts[0].included).toBe(true);
    }
  });
});

describe('computeReturns: classification feeds the right figures', () => {
  const IRA = { id: 'ira', name: 'Rollover IRA', institution: 'Fidelity', balance: 160_000 };

  it('treats an incoming rollover as a deposit, not as gain or income', () => {
    // Flat at 10,000; 150,000 rolled in on Nov 3. True return 0%.
    const r = computeReturns({
      today: '2026-11-04', windowStart: '2026-11-01',
      investmentAccounts: [IRA],
      observations: new Map([['ira', daily('2026-11-01', [10_000, 10_000, 160_000, 160_000])]]),
      investmentTxns: [
        tx('a0', 'ira', '2026-10-01', 1, 'DIVIDEND'),
        tx('r', 'ira', '2026-11-03', 150_000, 'ROLLOVER DISTRIBUTION FROM 401K PLAN'),
      ],
      incomeAccounts: [IRA], incomeTxns: [], overrides: {},
    });
    expect(r.total!.timeWeighted.periodReturn).toBeCloseTo(0, 12);
    expect(r.total!.deposits).toBe(150_000);
    expect(r.total!.gain).toBe(0);
    expect(r.flows.map(f => f.id)).toEqual(['r']);
  });

  it('counts only real income: no fund sale, no IRA payout or salary landing in checking', () => {
    const BRK = { id: 'brk', name: 'Brokerage', institution: 'Schwab', balance: 50_000 };
    const CHK = { id: 'chk', name: 'Checking', institution: 'Chase', balance: 5_000 };
    const txns = [
      tx('div', 'brk', '2026-03-15', 120, 'DIVIDEND RECEIVED SCHWAB US DIVIDEND EQUITY ETF'),
      tx('sale', 'brk', '2026-04-10', 25_000, 'YOU SOLD SCHWAB US DIVIDEND EQUITY ETF (SCHD) (Cash)'),
    ];
    const bank = [
      tx('int', 'chk', '2026-06-30', 2.5, 'INTEREST PAID'),
      tx('ira', 'chk', '2026-03-10', 20_000, 'FIDELITY IRA DISTRIBUTION'),
      tx('trust', 'chk', '2026-04-10', 20_000, 'TRUST DISTRIBUTION'),
      tx('pay', 'chk', '2026-05-01', 6_500, 'PINTEREST INC PAYROLL'),
    ];
    const r = computeReturns({
      today: '2026-11-24', windowStart: '2025-11-24',
      investmentAccounts: [BRK],
      observations: new Map([['brk', daily('2026-11-20', [50_000, 50_000, 50_000, 50_000, 50_000])]]),
      investmentTxns: txns,
      incomeAccounts: [BRK, CHK], incomeTxns: [...txns, ...bank], overrides: {},
    });
    expect(r.income.total).toBe(122.5);             // 120 + 2.5
    expect(r.income.nextTwelveMonths).toBe(122.5);
    expect(r.income.byAccount).toEqual([
      { accountId: 'brk', name: 'Brokerage', total: 120 },
      { accountId: 'chk', name: 'Checking', total: 2.5 },
    ]);
  });
});

describe('combineTotal: moves between measured accounts', () => {
  const A = { id: 'a', name: 'Brokerage A', institution: 'X', balance: 51_000 };
  const B = { id: 'b', name: 'Brokerage B', institution: 'Y', balance: 102_000 };
  const run = (aDay: string, bDay: string, aVals: number[], bVals: number[]) => computeReturns({
    today: '2026-11-03', windowStart: '2026-11-01',
    investmentAccounts: [A, B],
    observations: new Map([['a', daily('2026-11-01', aVals)], ['b', daily('2026-11-01', bVals)]]),
    investmentTxns: [
      tx('a0', 'a', '2026-10-01', 1, 'DIVIDEND'), tx('b0', 'b', '2026-10-01', 1, 'DIVIDEND'),
      tx('a1', 'a', aDay, -50_000, 'TRANSFER TO BROKERAGE B'),
      tx('b1', 'b', bDay, 50_000, 'TRANSFER FROM BROKERAGE A'),
    ],
    incomeAccounts: [A, B], incomeTxns: [], overrides: {},
  });

  it('cancels a same-day move in the combined figures', () => {
    // Nov 1: A 100,000, B 50,000. Nov 2: 50,000 moves A → B, market +2%:
    // A 51,000, B 102,000 → total 153,000 / 150,000 − 1 = +2.000%. Flat Nov 3.
    const r = run('2026-11-02', '2026-11-02', [100_000, 51_000, 51_000], [50_000, 102_000, 102_000]);
    expect(r.total!.timeWeighted.periodReturn).toBeCloseTo(0.02, 12);
    expect(r.total!.moneyWeighted.periodReturn).toBeCloseTo(0.02, 8);
    expect(r.total!.deposits).toBe(0);
    expect(r.total!.withdrawals).toBe(0);
    expect(r.total!.gain).toBe(3_000);
    // Each account still shows its own leg.
    expect(r.accounts.find(a => a.id === 'a')!.withdrawals).toBe(50_000);
    expect(r.accounts.find(a => a.id === 'b')!.deposits).toBe(50_000);
  });

  it('still gets 0% when the legs post on different days', () => {
    // A sends on Nov 2, B receives on Nov 3; the market is flat throughout.
    const r = run('2026-11-02', '2026-11-03', [100_000, 50_000, 50_000], [50_000, 50_000, 100_000]);
    expect(r.total!.timeWeighted.periodReturn).toBeCloseTo(0, 12);
  });
});

describe('computeReturns: span reported with each measure', () => {
  it('measures an account that starts empty from its first deposit', () => {
    // First transaction (a 0.50 interest credit) on 2025-01-01 while the
    // account reads 0; 1,000 deposited 2025-04-11; 1,100 on 2026-08-24.
    // Invested 500 days → both rates 1.1^(365/500) − 1 = 7.2054% a year.
    const A = { id: 'a', name: 'New Brokerage', institution: 'X', balance: 1_100 };
    const r = computeReturns({
      today: '2026-08-24', windowStart: '2024-08-25',
      investmentAccounts: [A],
      observations: new Map([['a', [
        { date: '2025-01-01', value: 0 }, { date: '2025-04-11', value: 1_000 }, { date: '2026-08-24', value: 1_100 },
      ]]]),
      investmentTxns: [tx('i', 'a', '2025-01-01', 0.5, 'INTEREST'), tx('d', 'a', '2025-04-11', 1_000, 'ACH DEPOSIT')],
      incomeAccounts: [A], incomeTxns: [], overrides: {},
    });
    const expected = Math.pow(1.1, 365 / 500) - 1;
    expect(r.total!.days).toBe(600);                         // the dates measured
    expect(r.total!.timeWeighted).toMatchObject({ days: 500 });
    expect(r.total!.moneyWeighted).toMatchObject({ days: 500 });
    expect(r.total!.timeWeighted.annualized).toBeCloseTo(expected, 8);
    expect(r.total!.moneyWeighted.annualized).toBeCloseTo(expected, 8);
    expect(r.accounts[0].timeWeighted.days).toBe(500);
    expect(r.accounts[0].moneyWeighted.days).toBe(500);
  });
});
