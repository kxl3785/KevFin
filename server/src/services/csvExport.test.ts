import { describe, it, expect } from 'vitest';
import {
  CSV_BOM, guardText, formatNumber, csvField, toCsv, csvFilename, parseDayFilter,
  transactionsCsv, holdingsCsv, sharesByPosition, lotKey, netWorthCsv,
  TRANSACTION_HEADER, HOLDINGS_HEADER, NET_WORTH_HEADER, PARTIAL_BASIS_NOTE,
} from './csvExport.js';
import type { HoldingRow } from './allocation.js';
import type { Holding } from './simplefin.js';
import { parseCsvText, txnRef } from '../shared/csvMapping.js';

// The file body without its byte-order mark, split into lines.
const lines = (csv: string) => {
  expect(csv.startsWith(CSV_BOM)).toBe(true);
  return csv.slice(1).split('\r\n');
};

describe('guardText (formula injection)', () => {
  it('prefixes an apostrophe to text a spreadsheet would run as a formula', () => {
    expect(guardText('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)");
    expect(guardText('+1')).toBe("'+1");
    expect(guardText('-cmd')).toBe("'-cmd");
    expect(guardText('@here')).toBe("'@here");
    expect(guardText('\tx')).toBe("'\tx");
    expect(guardText('\rx')).toBe("'\rx");
  });
  it('leaves ordinary text alone', () => {
    expect(guardText('Whole Foods')).toBe('Whole Foods');
    expect(guardText('a=b')).toBe('a=b');
    expect(guardText('')).toBe('');
  });
});

describe('formatNumber', () => {
  it('writes plain numbers without float noise or trailing zeros', () => {
    expect(formatNumber(-12.5)).toBe('-12.5');
    expect(formatNumber(100)).toBe('100');
    expect(formatNumber(0.1 + 0.2)).toBe('0.3');
    expect(formatNumber(1234567.891)).toBe('1234567.891');
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(-0)).toBe('0');
    expect(formatNumber(-0.0000001)).toBe('0');
    expect(formatNumber(12.3456789)).toBe('12.345679');
  });
  it('blanks non-finite values instead of writing NaN/Infinity', () => {
    expect(formatNumber(NaN)).toBe('');
    expect(formatNumber(Infinity)).toBe('');
    expect(formatNumber(-Infinity)).toBe('');
  });
});

describe('csvField', () => {
  it('quotes commas, quotes and line breaks (RFC 4180)', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('line1\nline2')).toBe('"line1\nline2"');
    expect(csvField('cr\rhere')).toBe('"cr\rhere"');
    expect(csvField('plain')).toBe('plain');
  });
  it('guards then quotes text that needs both', () => {
    expect(csvField('=1,2')).toBe(`"'=1,2"`);
    expect(csvField('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
  });
  it('never guards numbers, including negatives', () => {
    expect(csvField(-45.2)).toBe('-45.2');
    expect(csvField(3)).toBe('3');
  });
  it('writes null/undefined as an empty cell', () => {
    expect(csvField(null)).toBe('');
    expect(csvField(undefined)).toBe('');
  });
});

describe('toCsv', () => {
  it('starts with a BOM, ends every row with CRLF', () => {
    expect(toCsv(['A', 'B'], [['x', 1], [null, -2]])).toBe('﻿A,B\r\nx,1\r\n,-2\r\n');
  });
  it('is just the header for no rows', () => {
    expect(toCsv(['A'], [])).toBe('﻿A\r\n');
  });
  it('round-trips through an RFC 4180 parser', () => {
    const tricky = ['Café, "the" spot', 'multi\nline', "O'Reilly", 'naïve'];
    const parsed = parseCsvText(toCsv(['T'], tricky.map(t => [t])));
    expect(parsed.slice(1).map(r => r[0])).toEqual(tricky);
  });
});

describe('csvFilename / parseDayFilter', () => {
  it('dates the file', () => {
    expect(csvFilename('holdings', new Date(2026, 10, 24, 15, 0))).toBe('kevfin-holdings-2026-11-24.csv');
  });
  it('uses the local calendar day, not the UTC one (csv-ui-12)', () => {
    // 23:30 local on Nov 24 is already Nov 25 in UTC west of Greenwich, and
    // 00:30 local on Nov 25 is still Nov 24 in UTC east of it: either way the
    // file is named for the day on the user's clock.
    expect(csvFilename('net-worth', new Date(2026, 10, 24, 23, 30))).toBe('kevfin-net-worth-2026-11-24.csv');
    expect(csvFilename('net-worth', new Date(2026, 10, 25, 0, 30))).toBe('kevfin-net-worth-2026-11-25.csv');
  });
  it('accepts a real YYYY-MM-DD, treats blank as no filter, rejects the rest', () => {
    expect(parseDayFilter('2025-01-31', 'from')).toBe('2025-01-31');
    expect(parseDayFilter(undefined, 'from')).toBeNull();
    expect(parseDayFilter('', 'from')).toBeNull();
    expect(() => parseDayFilter('2025-02-30', 'from')).toThrow(/from must be a date/);
    expect(() => parseDayFilter('2025-1-5', 'to')).toThrow(/to must be a date/);
    expect(() => parseDayFilter(['2025-01-01'], 'to')).toThrow();
    expect(() => parseDayFilter('2025-99-99', 'to')).toThrow();
  });
});

describe('transactionsCsv', () => {
  const txns = [
    { id: 't-coffee', date: '2025-03-02', payee: 'Coffee, Inc.', amount: -4.5, category: 'Coffee Shops', account: 'Visa (1234)', postedAt: 2 },
    { id: 't-pay', date: '2025-03-01', payee: '=cmd|calc', amount: 1000.1 + 0.2, category: 'Paychecks', account: 'Checking', postedAt: 1 },
    { id: 't-late', date: '2025-04-10', payee: 'Late', amount: -0.004, category: 'Transfers', account: '-Savings', postedAt: 3 },
  ];
  it('writes Date, Merchant, Amount, Category, Account, KevFin ID oldest first, guarded and quoted', () => {
    expect(TRANSACTION_HEADER).toEqual(['Date', 'Merchant', 'Amount', 'Category', 'Account', 'KevFin ID']);
    expect(lines(transactionsCsv(txns))).toEqual([
      TRANSACTION_HEADER.join(','),
      `2025-03-01,'=cmd|calc,1000.3,Paychecks,Checking,${txnRef('t-pay')}`,
      `2025-03-02,"Coffee, Inc.",-4.5,Coffee Shops,Visa (1234),${txnRef('t-coffee')}`,
      `2025-04-10,Late,0,Transfers,'-Savings,${txnRef('t-late')}`, // -0.004 rounds to 0 cents, never "-0"
      '',
    ]);
  });
  it('filters by inclusive from / to', () => {
    const out = lines(transactionsCsv(txns, { from: '2025-03-02', to: '2025-03-02' }));
    expect(out.slice(1, -1)).toEqual([`2025-03-02,"Coffee, Inc.",-4.5,Coffee Shops,Visa (1234),${txnRef('t-coffee')}`]);
    expect(lines(transactionsCsv(txns, { from: '2025-04-01' })).length).toBe(3);
    expect(lines(transactionsCsv(txns, { to: '2025-02-28' }))).toEqual([TRANSACTION_HEADER.join(','), '']);
  });
  it('applies the category display label', () => {
    expect(transactionsCsv(txns.slice(0, 1), { label: c => `${c}!` })).toContain('Coffee Shops!');
  });
  it('is just the header when there are no transactions', () => {
    expect(transactionsCsv([])).toBe(CSV_BOM + TRANSACTION_HEADER.join(',') + '\r\n');
  });
});

describe('holdingsCsv', () => {
  const base = { costBasisCoveredValue: 0, costBasisComplete: true, pct: 0, overridden: false };
  const holdings: HoldingRow[] = [
    // One account, feed-reported basis.
    { ...base, symbol: 'VTI', name: 'Vanguard Total', value: 10000.004, costBasis: 8000, costBasisSource: 'reported', assetClass: 'US Stocks',
      accounts: [{ name: 'Brokerage', value: 10000.004, costBasis: 8000 }] },
    // Two accounts, a position-wide manual basis → split by value (3:1).
    { ...base, symbol: 'AAPL', name: 'Apple', value: 4000, costBasis: 2000, costBasisSource: 'manual', assetClass: 'US Stocks',
      accounts: [{ name: 'Brokerage', value: 3000, costBasis: null }, { name: 'IRA', value: 1000, costBasis: 900 }] },
    // Two accounts, feed-reported per account (one unknown).
    { ...base, symbol: 'BND', name: 'Bond fund', value: 300, costBasis: 100, costBasisSource: 'reported', assetClass: 'Bonds',
      accounts: [{ name: 'Brokerage', value: 200, costBasis: 100 }, { name: 'IRA', value: 100, costBasis: null }] },
    // No symbol: keyed by name.
    { ...base, symbol: '', name: 'Stable Value Fund', value: 50, costBasis: null, costBasisSource: null, assetClass: 'Short Term',
      accounts: [{ name: '401k', value: 50, costBasis: null }] },
    // A home: no account, no shares.
    { ...base, symbol: '', name: '1 Main St, Town, ST', value: 250000, costBasis: null, costBasisSource: null, assetClass: 'Real Estate', accounts: [] },
  ];
  const shares = new Map([
    ['VTI\u0000Brokerage', 40.5], ['AAPL\u0000Brokerage', 15], ['AAPL\u0000IRA', 5], ['Stable Value Fund\u0000401k', 50],
  ]);
  it('writes one line per position per account', () => {
    expect(lines(holdingsCsv(holdings, shares))).toEqual([
      HOLDINGS_HEADER.join(','),
      'VTI,Vanguard Total,Brokerage,40.5,10000,8000,US Stocks,',
      'AAPL,Apple,Brokerage,15,3000,1500,US Stocks,',
      'AAPL,Apple,IRA,5,1000,500,US Stocks,',
      'BND,Bond fund,Brokerage,,200,100,Bonds,',
      'BND,Bond fund,IRA,,100,,Bonds,',
      ',Stable Value Fund,401k,50,50,,Short Term,',
      ',"1 Main St, Town, ST",,,250000,,Real Estate,',
      '',
    ]);
  });
  it('does not divide by zero for a zero-value multi-account position', () => {
    const z: HoldingRow = { ...holdings[1], value: 0, accounts: [{ name: 'A', value: 0, costBasis: null }, { name: 'B', value: 0, costBasis: null }] };
    expect(lines(holdingsCsv([z], new Map()))[1]).toBe('AAPL,Apple,A,,0,,US Stocks,');
  });
  it('leaves a partial cost basis blank with a note, so Value − Cost basis never overstates the gain (csv-math-6)', () => {
    // Lot A worth 4,000 has a reported basis of 3,000; lot B worth 6,000 has none.
    // The app's gain is 4,000 − 3,000 = 1,000 on the covered part; writing 3,000
    // next to the 10,000 value would read as a 7,000 gain.
    const partial: HoldingRow = {
      ...base, symbol: 'VTI', name: 'Vanguard Total', value: 10000, costBasis: 3000, costBasisCoveredValue: 4000,
      costBasisComplete: false, costBasisSource: 'reported', assetClass: 'US Stocks',
      accounts: [{ name: 'Brokerage', value: 10000, costBasis: 3000 }],
    };
    expect(HOLDINGS_HEADER).toEqual(['Symbol', 'Name', 'Account', 'Shares', 'Value', 'Cost basis', 'Asset class', 'Note']);
    expect(lines(holdingsCsv([partial], new Map()))[1]).toBe(`VTI,Vanguard Total,Brokerage,,10000,,US Stocks,${PARTIAL_BASIS_NOTE}`);
    // Across two accounts the uncovered lots can't be placed, so neither row has a basis.
    const twoAccts: HoldingRow = { ...partial, accounts: [{ name: 'A', value: 6000, costBasis: 3000 }, { name: 'B', value: 4000, costBasis: null }] };
    expect(lines(holdingsCsv([twoAccts], new Map())).slice(1, 3)).toEqual([
      `VTI,Vanguard Total,A,,6000,,US Stocks,${PARTIAL_BASIS_NOTE}`,
      `VTI,Vanguard Total,B,,4000,,US Stocks,${PARTIAL_BASIS_NOTE}`,
    ]);
    // A complete reported basis is written as before.
    expect(lines(holdingsCsv([{ ...partial, costBasisComplete: true, costBasisCoveredValue: 10000 }], new Map()))[1])
      .toBe('VTI,Vanguard Total,Brokerage,,10000,3000,US Stocks,');
  });
  it('is just the header with nothing held', () => {
    expect(holdingsCsv([], new Map())).toBe(CSV_BOM + HOLDINGS_HEADER.join(',') + '\r\n');
  });
});

describe('sharesByPosition', () => {
  const lot = (symbol: string, description: string, shares: number | null): Holding =>
    ({ symbol, description, marketValue: 1, costBasis: null, shares, acquired: null });
  it('sums lots per position and account name, skipping unknown shares and unlisted accounts', () => {
    const byAccount = new Map<string, Holding[]>([
      ['a1', [lot('VTI', 'Vanguard', 10), lot('VTI', 'Vanguard', 2.5), lot('', 'Stable Value Fund', 7), lot('X', 'x', null)]],
      ['hidden', [lot('VTI', 'Vanguard', 99)]],
    ]);
    const out = sharesByPosition(byAccount, new Map([['a1', 'Brokerage']]));
    expect(out.get('VTI\u0000Brokerage')).toBe(12.5);
    expect(out.get(`${lotKey({ symbol: '', description: 'Stable Value Fund' })}\u0000Brokerage`)).toBe(7);
    expect(out.has('X\u0000Brokerage')).toBe(false);
    expect([...out.keys()].some(k => k.endsWith('hidden'))).toBe(false);
  });
});

describe('netWorthCsv', () => {
  it('writes the stored daily parts oldest first, rounded to cents', () => {
    const csv = netWorthCsv([
      { date: '2025-01-02', accounts_total: 1000.555, real_estate_total: 200000, net_worth: 201000.555 },
      { date: '2025-01-01', accounts_total: -50, real_estate_total: 0, net_worth: -50 },
    ]);
    expect(lines(csv)).toEqual([
      NET_WORTH_HEADER.join(','),
      '2025-01-01,-50,0,-50',
      '2025-01-02,1000.56,200000,201000.56',
      '',
    ]);
  });
  it('is just the header with no history', () => {
    expect(netWorthCsv([])).toBe(CSV_BOM + NET_WORTH_HEADER.join(',') + '\r\n');
  });
});
