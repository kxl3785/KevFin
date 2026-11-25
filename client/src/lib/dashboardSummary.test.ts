import { describe, it, expect } from 'vitest';
import type { Account, ManualAsset, Snapshot } from '@shared/apiTypes';
import {
  accountMix, headlineChanges, isoDaysBefore, payoffMonth, snapshotOnOrBefore, sparkValues, ascending,
} from './dashboardSummary.ts';

const both = { accounts: true, realEstate: true };
const snap = (date: string, acc: number, re: number): Snapshot =>
  ({ date, accounts_total: acc, real_estate_total: re, net_worth: acc + re });

describe('isoDaysBefore', () => {
  it('crosses month and year boundaries', () => {
    expect(isoDaysBefore('2026-03-01', 1)).toBe('2026-02-28');
    expect(isoDaysBefore('2026-01-15', 30)).toBe('2025-12-16');
    expect(isoDaysBefore('2024-03-01', 1)).toBe('2024-02-29');
  });
});

describe('snapshotOnOrBefore', () => {
  const asc = [snap('2026-01-05', 1, 0), snap('2026-01-10', 2, 0)];
  it('takes the last snapshot on or before the day', () => {
    expect(snapshotOnOrBefore(asc, '2026-01-09')?.accounts_total).toBe(1);
    expect(snapshotOnOrBefore(asc, '2026-01-10')?.accounts_total).toBe(2);
  });
  it('is null when history starts later', () => {
    expect(snapshotOnOrBefore(asc, '2026-01-04')).toBeNull();
  });
});

describe('headlineChanges', () => {
  // Newest-first, as the API returns it.
  const history = [
    snap('2026-11-24', 350_000, 316_000),
    snap('2026-10-25', 345_000, 316_000),
    snap('2026-10-20', 340_000, 315_000),
    snap('2025-12-31', 300_000, 305_000),
    snap('2025-06-01', 280_000, 300_000),
  ];

  it('measures 30 days and YTD from the latest snapshot', () => {
    const { d30, ytd } = headlineChanges(history, both);
    // 30 days before Nov 24 is Oct 25.
    expect(d30?.amount).toBe(666_000 - 661_000);
    expect(d30?.pct).toBeCloseTo(5_000 / 661_000);
    // YTD starts from the Dec 31 value.
    expect(ytd?.amount).toBe(666_000 - 605_000);
  });

  it('follows the switched-on series', () => {
    const { ytd } = headlineChanges(history, { accounts: true, realEstate: false });
    expect(ytd?.amount).toBe(50_000);
  });

  it('is null when history does not reach back far enough', () => {
    const short = [snap('2026-11-24', 10, 0), snap('2026-11-20', 9, 0)];
    expect(headlineChanges(short, both)).toEqual({ d30: null, ytd: null });
  });

  it('leaves pct null when the starting value is not positive', () => {
    const h = [snap('2026-11-24', 500, 0), snap('2025-12-31', -200, 0)];
    expect(headlineChanges(h, both).ytd).toEqual({ amount: 700, pct: null });
  });

  it('handles empty history', () => {
    expect(headlineChanges([], both)).toEqual({ d30: null, ytd: null });
  });
});

describe('sparkValues', () => {
  it('keeps the last 90 days, oldest first', () => {
    const h = [snap('2026-11-24', 3, 0), snap('2026-09-01', 2, 0), snap('2026-08-01', 1, 0)];
    expect(sparkValues(h, both)).toEqual([2, 3]);
    expect(ascending(h)[0].date).toBe('2026-08-01');
  });
});

describe('accountMix', () => {
  const acct = (category: Account['category'], balance: number, hidden = false): Account => ({
    id: `${category}${balance}`, org_name: 'X', name: 'n', renamed: false, balance, currency: 'USD',
    category, hidden, updated_at: '',
  });
  const asset = (category: ManualAsset['category'], value: number) =>
    ({ id: 1, name: 'a', category, value, interest_rate: null } as unknown as ManualAsset);

  it('splits positive balances and skips credit, hidden and empty slices', () => {
    const mix = accountMix(
      [acct('brokerage', 300), acct('banking', 100), acct('credit', -50), acct('brokerage', 999, true)],
      [asset('other', 100)],
    );
    expect(mix.map(m => [m.key, m.value, m.share])).toEqual([
      ['investing', 300, 0.6], ['cash', 100, 0.2], ['other', 100, 0.2],
    ]);
  });

  it('is empty with nothing positive', () => {
    expect(accountMix([acct('credit', -5)], [])).toEqual([]);
  });
});

describe('payoffMonth', () => {
  it('adds the term to the start month', () => {
    expect(payoffMonth('2021-07-01', 30)).toBe('2051-07');
    expect(payoffMonth('2020-12-15', 15)).toBe('2035-12');
    expect(payoffMonth('2021-01-01', null)).toBe('2051-01');
  });
  it('is null without a start', () => {
    expect(payoffMonth(null, 30)).toBeNull();
    expect(payoffMonth('garbage', 30)).toBeNull();
  });
});
