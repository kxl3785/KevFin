import { describe, it, expect } from 'vitest';
import {
  detectDelimiter, parseCsvText, suggestMapping, sanitizeMapping, parseDateCell, detectDateOrder,
  parseAmountCell, readRow, signSummary, headerSignature, unguardText, EMPTY_MAPPING, type CsvMapping,
  parseCsvRecords, detectDecimalComma, looksHeaderless, suggestMappingFromData, txnRef,
} from './csvMapping.js';

const map = (over: Partial<CsvMapping>): CsvMapping => ({ ...EMPTY_MAPPING, ...over });

describe('parseCsvText', () => {
  it('handles quoted commas, doubled quotes and line breaks inside quotes (RFC 4180)', () => {
    const text = 'a,b,c\r\n"x, y","say ""hi""","line1\nline2"\r\n';
    expect(parseCsvText(text)).toEqual([['a', 'b', 'c'], ['x, y', 'say "hi"', 'line1\nline2']]);
  });
  it('drops a UTF-8 byte-order mark and blank rows', () => {
    expect(parseCsvText('﻿Date,Amount\n\n2025-01-02,5\n,\n')).toEqual([['Date', 'Amount'], ['2025-01-02', '5']]);
  });
  it('keeps an empty trailing field', () => {
    expect(parseCsvText('a,b\n1,\n')).toEqual([['a', 'b'], ['1', '']]);
  });
  it('returns nothing for empty input', () => {
    expect(parseCsvText('')).toEqual([]);
    expect(parseCsvText('﻿')).toEqual([]);
  });
  it('splits semicolon and tab files when the header uses them', () => {
    expect(detectDelimiter('Datum;Betrag;Text\n01.02.2025;-12,50;Cafe')).toBe(';');
    expect(parseCsvText('Datum;Betrag\n01.02.2025;-12,50')).toEqual([['Datum', 'Betrag'], ['01.02.2025', '-12,50']]);
    expect(detectDelimiter('Date\tAmount\n2025-01-01\t5')).toBe('\t');
    expect(detectDelimiter('Date,Amount\n')).toBe(',');
    // A semicolon inside quotes doesn't count.
    expect(detectDelimiter('"a;b;c",d\n')).toBe(',');
    expect(detectDelimiter('')).toBe(',');
  });
});

describe('suggestMapping', () => {
  it('picks the same columns as the original importer for its own layout', () => {
    const m = suggestMapping(['Date', 'Merchant', 'Category', 'Account', 'Original Statement', 'Notes', 'Amount', 'Tags']);
    expect(m).toMatchObject({ date: 0, merchant: 1, category: 2, account: 3, notes: 5, amount: 6, debit: null, credit: null, dateOrder: 'mdy', flipSign: false });
  });
  it('takes the first matching column in file order, like the original importer', () => {
    // "Posted Date" comes before "Transaction Date" here, so it wins.
    expect(suggestMapping(['Posted Date', 'Transaction Date', 'Amount']).date).toBe(0);
    // "Name" (col 0) beats "Description" (col 1).
    expect(suggestMapping(['Name', 'Description', 'Date', 'Amount']).merchant).toBe(0);
  });
  it('understands common bank synonyms, including separate money in / out columns', () => {
    const m = suggestMapping(['Posting Date', 'Payee Name', 'Withdrawal', 'Deposit', 'Memo']);
    expect(m).toMatchObject({ date: 0, merchant: 1, amount: null, debit: 2, credit: 3, notes: 4 });
  });
  it('ignores case, spaces, a BOM and punctuation/units in headers', () => {
    const m = suggestMapping(['﻿ DATE ', 'Amount (USD)', 'Transaction_Description']);
    expect(m).toMatchObject({ date: 0, amount: 1, merchant: 2 });
  });
  it('never maps money in / out when there is an amount column', () => {
    expect(suggestMapping(['Date', 'Amount', 'Debit', 'Credit'])).toMatchObject({ amount: 1, debit: null, credit: null });
  });
  it('leaves fields with no plausible column unmapped', () => {
    expect(suggestMapping(['foo', 'bar'])).toEqual(EMPTY_MAPPING);
    expect(suggestMapping([])).toEqual(EMPTY_MAPPING);
  });
});

describe('sanitizeMapping', () => {
  it('drops indexes outside the file, non-integers and junk', () => {
    const m = sanitizeMapping({ date: 0, amount: 7, merchant: 1.5, account: -1, category: '2', notes: 2, dateOrder: 'xyz', flipSign: 'yes' }, 3);
    expect(m).toEqual({ ...EMPTY_MAPPING, date: 0, notes: 2 });
  });
  it('prefers the amount column when both an amount and in/out are sent', () => {
    expect(sanitizeMapping({ amount: 0, debit: 1, credit: 2, dateOrder: 'dmy', flipSign: true }, 3))
      .toMatchObject({ amount: 0, debit: null, credit: null, dateOrder: 'dmy', flipSign: true });
  });
  it('treats a missing or non-object mapping as empty', () => {
    expect(sanitizeMapping(null, 3)).toEqual(EMPTY_MAPPING);
    expect(sanitizeMapping('date', 3)).toEqual(EMPTY_MAPPING);
  });
});

describe('parseDateCell', () => {
  it('reads ISO dates, ignoring a trailing time', () => {
    expect(parseDateCell('2025-04-03')).toBe('2025-04-03');
    expect(parseDateCell(' 2025-04-03T10:20:00Z ')).toBe('2025-04-03');
    expect(parseDateCell('2025/4/3')).toBe('2025-04-03');
    expect(parseDateCell('2025-4-3')).toBe('2025-04-03');
  });
  it('reads numeric dates month-first by default and day-first on request', () => {
    expect(parseDateCell('04/03/2025')).toBe('2025-04-03');
    expect(parseDateCell('4/3/2025', 'dmy')).toBe('2025-03-04');
    expect(parseDateCell('04-03-2025')).toBe('2025-04-03');
    expect(parseDateCell('04.03.2025', 'dmy')).toBe('2025-03-04');
  });
  it('expands two-digit years the way the JS date parser does (00–49 → 2000s)', () => {
    expect(parseDateCell('1/5/24')).toBe('2024-01-05');
    expect(parseDateCell('1/5/49')).toBe('2049-01-05');
    expect(parseDateCell('1/5/50')).toBe('1950-01-05');
  });
  it('reads written-out month names', () => {
    expect(parseDateCell('Apr 3, 2025')).toBe('2025-04-03');
    expect(parseDateCell('3 April 2025')).toBe('2025-04-03');
  });
  it('rejects impossible or unreadable dates instead of inventing one', () => {
    expect(parseDateCell('2025-02-30')).toBeNull();
    expect(parseDateCell('2024-02-29')).toBe('2024-02-29'); // leap day is real
    expect(parseDateCell('13/01/2025')).toBeNull();          // month 13, month-first
    expect(parseDateCell('13/01/2025', 'dmy')).toBe('2025-01-13');
    expect(parseDateCell('2')).toBeNull();
    expect(parseDateCell('45123')).toBeNull();
    expect(parseDateCell('yesterday')).toBeNull();
    expect(parseDateCell('')).toBeNull();
    expect(parseDateCell('0/0/2025')).toBeNull();
  });
});

describe('detectDateOrder', () => {
  it('spots day-first files from a day over 12 in the first position', () => {
    expect(detectDateOrder(['01/02/2025', '25/02/2025'])).toEqual({ order: 'dmy', ambiguous: false, numericCount: 2, conflicting: false });
  });
  it('spots month-first files from a day over 12 in the second position', () => {
    expect(detectDateOrder(['01/02/2025', '02/25/2025'])).toMatchObject({ order: 'mdy', ambiguous: false });
  });
  it('flags a file where every date fits both orders, keeping month-first', () => {
    expect(detectDateOrder(['01/02/2025', '03/04/2025'])).toEqual({ order: 'mdy', ambiguous: true, numericCount: 2, conflicting: false });
  });
  it('flags a file that contradicts itself', () => {
    expect(detectDateOrder(['25/02/2025', '02/25/2025'])).toMatchObject({ ambiguous: true, conflicting: true });
  });
  it('is not ambiguous when there are no numeric dates (ISO, text, empty)', () => {
    expect(detectDateOrder(['2025-01-02', 'Jan 3, 2025'])).toEqual({ order: 'mdy', ambiguous: false, numericCount: 0, conflicting: false });
    expect(detectDateOrder([])).toMatchObject({ ambiguous: false, numericCount: 0 });
  });
});

describe('parseAmountCell', () => {
  it('reads plain, signed and currency-marked amounts', () => {
    expect(parseAmountCell('12.34')).toBe(12.34);
    expect(parseAmountCell('-12.34')).toBe(-12.34);
    expect(parseAmountCell('+12')).toBe(12);
    expect(parseAmountCell('$1,234.56')).toBe(1234.56);
    expect(parseAmountCell('-$1,234.56')).toBe(-1234.56);
    expect(parseAmountCell('$-5.00')).toBe(-5);
    expect(parseAmountCell('€12')).toBe(12);
    expect(parseAmountCell('12.00 USD')).toBe(12);
    expect(parseAmountCell('USD -3')).toBe(-3);
    expect(parseAmountCell('−7.5')).toBe(-7.5); // Unicode minus
    expect(parseAmountCell('7.5-')).toBe(-7.5);  // trailing minus
  });
  it('reads accounting parentheses as negative (and a negative inside them as positive, like the original importer)', () => {
    expect(parseAmountCell('(45.00)')).toBe(-45);
    expect(parseAmountCell('($1,000)')).toBe(-1000);
    expect(parseAmountCell('(-12)')).toBe(12);
  });
  it('handles thousands separators and comma decimals', () => {
    expect(parseAmountCell('1,234')).toBe(1234);
    expect(parseAmountCell('1,234,567.89')).toBe(1234567.89);
    expect(parseAmountCell('1.234.567,89')).toBe(1234567.89);
    expect(parseAmountCell('1 234,56')).toBe(1234.56);
    expect(parseAmountCell('12,50')).toBe(12.5);
    expect(parseAmountCell('12,5')).toBe(12.5);
    expect(parseAmountCell('1.234.567')).toBe(1234567);
    expect(parseAmountCell('0.5')).toBe(0.5);
    expect(parseAmountCell('.5')).toBe(0.5);
  });
  it('returns null (never NaN) for blank or unreadable cells', () => {
    for (const s of ['', '   ', 'N/A', 'abc', '12abc', '1-2', '$', '()', '--', '1e5', '2025-01-02']) {
      expect(parseAmountCell(s)).toBeNull();
    }
  });
  it('never returns -0', () => {
    expect(Object.is(parseAmountCell('-0'), 0)).toBe(true);
    expect(Object.is(parseAmountCell('(0.00)'), 0)).toBe(true);
  });
});

describe('readRow', () => {
  const m = map({ date: 0, merchant: 1, amount: 2, account: 3, category: 4, notes: 5 });

  it('reads a row through the mapping, trimming text', () => {
    expect(readRow(['2025-01-05', ' Cafe ', '-4.50', ' Visa 1234 ', ' Coffee Shops ', ' latte '], m)).toEqual({
      ok: true, txn: { date: '2025-01-05', amount: -4.5, merchant: 'Cafe', account: 'Visa 1234', category: 'Coffee Shops', notes: 'latte' },
    });
  });
  it('fills the original importer’s defaults for blank text', () => {
    expect(readRow(['2025-01-05', '', '1', '', '', ''], m)).toMatchObject({ ok: true, txn: { merchant: 'Unknown', account: 'Imported', category: '', notes: '' } });
    expect(readRow(['2025-01-05', 'x', '1'], map({ date: 0, merchant: 1, amount: 2 }))).toMatchObject({ ok: true, txn: { account: 'Imported' } });
  });
  it('says why a row needs a look', () => {
    expect(readRow(['', 'x', '1'], m)).toEqual({ ok: false, reason: 'Date is blank' });
    // The unreadable cell is kept out of the reason (it may be an amount, which
    // privacy mode hides) and returned on its own.
    expect(readRow(['someday', 'x', '1'], m)).toEqual({ ok: false, reason: 'Can’t read the date', value: 'someday' });
    expect(readRow(['2025-01-05', 'x', ''], m)).toEqual({ ok: false, reason: 'Amount is blank' });
    expect(readRow(['2025-01-05', 'x', 'lots'], m)).toEqual({ ok: false, reason: 'Can’t read the amount', value: 'lots' });
    // csv-ui-7: an amount the reader can't parse never appears in the reason.
    const dr = readRow(['2025-01-05', 'RENT', '1,850.00 DR'], m);
    expect(dr).toEqual({ ok: false, reason: 'Can’t read the amount', value: '1,850.00 DR' });
    expect(readRow(['2025-01-05'], map({ amount: 0 }))).toEqual({ ok: false, reason: 'No date column chosen' });
    expect(readRow(['2025-01-05'], map({ date: 0 }))).toEqual({ ok: false, reason: 'No amount column chosen' });
  });
  it('shortens a long unreadable value', () => {
    const r = readRow(['x'.repeat(40), 'm', '1'], m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.value).toBe(`${'x'.repeat(23)}…`);
  });
  it('combines money in and money out columns, whatever sign the bank used', () => {
    const io = map({ date: 0, merchant: 1, debit: 2, credit: 3 });
    expect(readRow(['2025-01-05', 'Shop', '45.00', ''], io)).toMatchObject({ ok: true, txn: { amount: -45 } });
    expect(readRow(['2025-01-05', 'Shop', '-45.00', ''], io)).toMatchObject({ ok: true, txn: { amount: -45 } });
    expect(readRow(['2025-01-05', 'Pay', '', '1,000.00'], io)).toMatchObject({ ok: true, txn: { amount: 1000 } });
    expect(readRow(['2025-01-05', 'Both', '10', '25'], io)).toMatchObject({ ok: true, txn: { amount: 15 } });
    expect(readRow(['2025-01-05', 'None', '', ''], io)).toEqual({ ok: false, reason: 'Money in and money out are both blank' });
    expect(readRow(['2025-01-05', 'Bad', 'x', ''], io)).toEqual({ ok: false, reason: 'Can’t read the amount', value: 'x' });
  });
  it('ignores the flip with money in / money out columns, whose sign is explicit (csv-ui-3)', () => {
    // Debit 4.50 is money out (-4.50) and Credit 2500 money in (+2500) with or
    // without the box: ticking it must not turn the purchase into income.
    const io = map({ date: 0, merchant: 1, debit: 2, credit: 3, flipSign: true });
    expect(readRow(['05/01/2026', 'COFFEE', '4.50', ''], io)).toMatchObject({ ok: true, txn: { amount: -4.5 } });
    expect(readRow(['05/02/2026', 'PAYROLL', '', '2500.00'], io)).toMatchObject({ ok: true, txn: { amount: 2500 } });
  });
  it('flips the sign when asked, without producing -0', () => {
    const f = { ...m, flipSign: true };
    expect(readRow(['2025-01-05', 'Shop', '12.5'], f)).toMatchObject({ ok: true, txn: { amount: -12.5 } });
    expect(readRow(['2025-01-05', 'Refund', '-3'], f)).toMatchObject({ ok: true, txn: { amount: 3 } });
    const zero = readRow(['2025-01-05', 'Zero', '0'], f);
    expect(zero.ok && Object.is(zero.txn.amount, 0)).toBe(true);
  });
  it('reads dates in the chosen order', () => {
    expect(readRow(['03/04/2025', 'x', '1'], { ...m, dateOrder: 'dmy' })).toMatchObject({ ok: true, txn: { date: '2025-04-03' } });
  });
  it('removes the export’s formula-guard apostrophe from text cells', () => {
    expect(readRow(['2025-01-05', "'=SUM(A1)", '1', "'-Checking", "'@cat"], m))
      .toMatchObject({ ok: true, txn: { merchant: '=SUM(A1)', account: '-Checking', category: '@cat' } });
  });
});

describe('unguardText', () => {
  it('only strips an apostrophe that guards a formula character', () => {
    expect(unguardText("'=1")).toBe('=1');
    expect(unguardText("'+1")).toBe('+1');
    expect(unguardText("'\t")).toBe('\t');
    expect(unguardText("'Tis the season")).toBe("'Tis the season");
    expect(unguardText("O'Reilly")).toBe("O'Reilly");
    expect(unguardText('')).toBe('');
  });
});

describe('signSummary', () => {
  it('suggests a flip only when positives clearly dominate', () => {
    expect(signSummary([5, 6, 7, -1])).toEqual({ positive: 3, negative: 1, suggestFlip: true });
    expect(signSummary([5, 6, 7, -1, -2])).toEqual({ positive: 3, negative: 2, suggestFlip: false }); // 3 is not > 4
    expect(signSummary([5, 6])).toEqual({ positive: 2, negative: 0, suggestFlip: false });         // too few to tell
    expect(signSummary([-5, -6, -7, 100])).toMatchObject({ suggestFlip: false });
    expect(signSummary([])).toEqual({ positive: 0, negative: 0, suggestFlip: false });
    expect(signSummary([0, 0, 0])).toEqual({ positive: 0, negative: 0, suggestFlip: false });
  });
});

describe('headerSignature', () => {
  it('is the same for the same layout regardless of case, spacing and a BOM', () => {
    expect(headerSignature(['﻿Date', ' Amount '])).toBe(headerSignature(['date', 'AMOUNT']));
    expect(headerSignature(['Date', 'Amount'])).not.toBe(headerSignature(['Amount', 'Date']));
    expect(headerSignature([])).toBe('');
  });
});

describe('a double quote inside an unquoted field (csv-math-5)', () => {
  const csv = 'Date,Description,Amount\n2026-01-01,SUBWAY 12" SUB,-9.00\n2026-01-02,SHELL,-30.00\n2026-01-03,GYM,-40.00\n';
  it('is a literal character, so later rows are not swallowed', () => {
    expect(parseCsvText(csv)).toEqual([
      ['Date', 'Description', 'Amount'],
      ['2026-01-01', 'SUBWAY 12" SUB', '-9.00'],
      ['2026-01-02', 'SHELL', '-30.00'],
      ['2026-01-03', 'GYM', '-40.00'],
    ]);
  });
  it('still opens a quoted section at the start of a field', () => {
    expect(parseCsvText('a,b\n"x, ""y""",2\n')).toEqual([['a', 'b'], ['x, "y"', '2']]);
    expect(parseCsvText('a,b\n5" pipe,"q,r"\n')).toEqual([['a', 'b'], ['5" pipe', 'q,r']]);
  });
  it('detectDelimiter uses the same rule', () => {
    // The mid-field quote must not hide the semicolons that follow it.
    expect(detectDelimiter('Text 12" A;Datum;Betrag\n')).toBe(';');
    expect(detectDelimiter('"a;b;c",d\n')).toBe(',');
  });
});

describe('parseCsvRecords row numbers (csv-ui-11)', () => {
  it('numbers rows as a spreadsheet does: header row 1, blank lines counted', () => {
    const recs = parseCsvRecords('Date,Merchant,Amount\n\n2026-05-01,A,-1\n2026-05-02,B,-2');
    expect(recs.map(r => [r.cells[1], r.row])).toEqual([['Merchant', 1], ['A', 3], ['B', 4]]);
  });
  it('keeps a quoted line break on one row, and counts CRLF once', () => {
    const recs = parseCsvRecords('h1,h2\r\n"two\nlines",x\r\nnext,y\r\n');
    expect(recs.map(r => r.row)).toEqual([1, 2, 3]);
  });
});

describe('decimal comma files (csv-math-8)', () => {
  it('reads 1.234 as thousands only when the file uses a decimal comma', () => {
    expect(parseAmountCell('-1.234', true)).toBe(-1234);
    expect(parseAmountCell('-1.234')).toBe(-1.234);   // default unchanged
    expect(parseAmountCell('12.345')).toBe(12.345);   // US file: a decimal mark
    expect(parseAmountCell('12.34', true)).toBe(12.34); // two decimals stay decimals
    expect(parseAmountCell('1,234')).toBe(1234);      // existing rule kept
    expect(parseAmountCell('1.234,56', true)).toBe(1234.56);
  });
  it('decides the decimal mark once from the delimiter or the amount cells', () => {
    expect(detectDecimalComma(['-1.234', '-3,20'], ',')).toBe(true);
    expect(detectDecimalComma(['-1.234'], ';')).toBe(true);
    expect(detectDecimalComma(['1,234', '$1,234.56', '-12.5'], ',')).toBe(false);
    expect(detectDecimalComma(['12,50 €'], ',')).toBe(true);
  });
});

describe('files without a header row (csv-ui-2, PS-2, csv-math-4)', () => {
  const rows = [
    ['05/01/2026', '-12.50', '*', '', 'COFFEE SHOP'],
    ['05/02/2026', '-40.00', '*', '', 'GAS STATION'],
    ['05/03/2026', '2500.00', '*', '', 'PAYROLL'],
  ];
  it('spots a first row that is a transaction', () => {
    expect(looksHeaderless(rows[0])).toBe(true);
    expect(looksHeaderless(['Date', 'Description', 'Amount'])).toBe(false);
    expect(looksHeaderless(['Posted', 'Payee', 'Value'])).toBe(false); // names, no data
    expect(looksHeaderless(['05/01/2026', 'COFFEE'])).toBe(false);     // no amount cell
  });
  it('guesses date, amount and description from the data', () => {
    expect(suggestMappingFromData(rows)).toEqual({ ...EMPTY_MAPPING, date: 0, amount: 1, merchant: 4, hasHeader: false });
  });
  it('sanitizeMapping keeps hasHeader, defaulting to true', () => {
    expect(sanitizeMapping({ hasHeader: false }, 3).hasHeader).toBe(false);
    expect(sanitizeMapping({}, 3).hasHeader).toBe(true);
    expect(sanitizeMapping({ hasHeader: 'no' }, 3).hasHeader).toBe(true);
  });
});

describe('txnRef', () => {
  it('is a stable, short, text-only fingerprint', () => {
    const a = txnRef('imp|2026-05-20|-180.00|pool service ref12345678|amex gold');
    expect(a).toMatch(/^k[0-9a-f]{16}$/);
    expect(txnRef('imp|2026-05-20|-180.00|pool service ref12345678|amex gold')).toBe(a);
    expect(txnRef('imp|2026-05-20|-180.00|pool service ref12345678|amex gold|2')).not.toBe(a);
    expect(txnRef('')).toMatch(/^k[0-9a-f]{16}$/);
  });
  it('does not collide across many ids', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50_000; i++) seen.add(txnRef(`TRN-${i}`));
    expect(seen.size).toBe(50_000);
  });
});
