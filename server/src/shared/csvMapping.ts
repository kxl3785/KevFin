// Reading a bank/budget CSV whose columns may be laid out any which way: split it
// into rows, guess which column is which from the header, work out how its dates
// and amounts are written, and turn one row into a transaction. Dependency-free
// and pure, so the server (import preview/commit) and the client (column-matching
// step, remembered mappings) share one implementation.
//
// The guiding constraint: a file in the layout the original importer already
// accepts (services/budget.ts importTransactions — Date / Merchant / Amount /
// Account / Category headers, ISO or M/D/YYYY dates) must come out of here with
// the same columns picked and the same values, so importing it through the
// column-matching flow is identical to importing it the old way.

// --- Splitting the file ------------------------------------------------------

/**
 * The column separator of a CSV: comma unless the header line clearly uses
 * semicolons (common in European spreadsheet exports, where the comma is the
 * decimal mark) or tabs. Counted outside double quotes on the first non-blank
 * line, with the same quote rule as parseCsvText (a quote opens a quoted section
 * only at the start of a field).
 */
export function detectDelimiter(text: string): ',' | ';' | '\t' {
  const body = text.replace(/^\uFEFF/, '');
  const line = body.split(/\r?\n/).find(l => l.trim() !== '') ?? '';
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let inQ = false, atStart = true;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') { if (line[i + 1] === '"') i++; else inQ = false; }
    } else if (c === '"' && atStart) { inQ = true; atStart = false; }
    else if (c === ',' || c === ';' || c === '\t') { counts[c]++; atStart = true; }
    else atStart = false;
  }
  if (counts[';'] > counts[','] && counts[';'] >= counts['\t']) return ';';
  if (counts['\t'] > counts[','] && counts['\t'] > counts[';']) return '\t';
  return ',';
}

/** One record of a CSV file and the row number a spreadsheet shows it on. */
export interface CsvRecord { cells: string[]; row: number }

/**
 * RFC 4180 parse: quoted fields may hold the separator, doubled quotes ("") and
 * line breaks. A leading UTF-8 byte-order mark is dropped (Excel adds one, and
 * so do KevFin's own exports) and the separator is configurable. Rows whose
 * every cell is blank are removed, as the original importer does.
 *
 * A double quote opens a quoted section only at the very start of a field, as
 * Excel reads it. Many banks don't quote their fields, so a merchant like
 * SUBWAY 12" SUB must stay one field rather than swallow the rest of the file.
 * (budget.ts parseCsv opens one anywhere; the import's canonical file quotes
 * every such field, so both read it the same.)
 *
 * `row` is the record's spreadsheet row number: the first line is row 1, blank
 * lines count (a spreadsheet shows them as empty rows), and a quoted field with
 * a line break inside stays on one row.
 */
export function parseCsvRecords(text: string, delimiter: string = detectDelimiter(text)): CsvRecord[] {
  const src = text.replace(/^\uFEFF/, '');
  const out: CsvRecord[] = [];
  let row: string[] = [], field = '', inQ = false, atStart = true, rowNo = 1;
  const endRecord = () => { row.push(field); out.push({ cells: row, row: rowNo }); row = []; field = ''; };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQ) {
      if (c === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"' && atStart) { inQ = true; atStart = false; }
    else if (c === delimiter) { row.push(field); field = ''; atStart = true; }
    else if (c === '\n' || c === '\r') {
      if (field !== '' || row.length) endRecord();
      if (c === '\r' && src[i + 1] === '\n') i++;
      rowNo++;
      atStart = true;
    } else { field += c; atStart = false; }
  }
  if (field !== '' || row.length) endRecord();
  return out.filter(r => r.cells.some(c => c.trim() !== ''));
}

/** parseCsvRecords without the row numbers. */
export function parseCsvText(text: string, delimiter: string = detectDelimiter(text)): string[][] {
  return parseCsvRecords(text, delimiter).map(r => r.cells);
}

// --- Matching columns ---------------------------------------------------------

export type CsvField = 'date' | 'merchant' | 'amount' | 'debit' | 'credit' | 'category' | 'account' | 'notes';
export const CSV_FIELDS: CsvField[] = ['date', 'merchant', 'amount', 'debit', 'credit', 'category', 'account', 'notes'];

/** Plain-language names for the column picker. */
export const CSV_FIELD_LABEL: Record<CsvField, string> = {
  date: 'Date',
  merchant: 'Description',
  amount: 'Amount',
  debit: 'Money out',
  credit: 'Money in',
  category: 'Category',
  account: 'Account',
  notes: 'Notes',
};

// How day and month are ordered in dates like 03/04/2025. ISO dates (2025-04-03)
// are unambiguous and always read year-month-day whatever this says.
export type DateOrder = 'mdy' | 'dmy';

/** Which column (0-based) feeds each field; null = not in this file. */
export interface CsvMapping {
  date: number | null;
  merchant: number | null;
  amount: number | null;
  debit: number | null;
  credit: number | null;
  category: number | null;
  account: number | null;
  notes: number | null;
  dateOrder: DateOrder;
  // Reverse every amount in the Amount column: for files that list purchases as
  // positive numbers. KevFin's convention is money out < 0, money in > 0. Has no
  // effect with Money in / Money out columns, whose sign is already explicit.
  flipSign: boolean;
  // False when the file has no header row (some banks export none): the first
  // row is then a transaction, and the columns are called Column 1, Column 2, …
  hasHeader: boolean;
}

export const EMPTY_MAPPING: CsvMapping = {
  date: null, merchant: null, amount: null, debit: null, credit: null,
  category: null, account: null, notes: null, dateOrder: 'mdy', flipSign: false, hasHeader: true,
};

// The original importer's header names (exact, after trim + lower-case). Tried
// first and in the same way (first column in file order that matches any name),
// so a file it accepts maps to the very same columns here.
const ORIGINAL_NAMES: Partial<Record<CsvField, string[]>> = {
  date: ['date', 'posted date', 'transaction date'],
  merchant: ['merchant', 'description', 'name', 'payee'],
  amount: ['amount'],
  account: ['account', 'account name'],
  category: ['category'],
};

// Extra synonyms seen in common bank exports, matched on a looser form of the
// header (punctuation and units dropped: "Amount (USD)" → "amount usd" → tried
// as-is and with the unit word removed). Only consulted when the original names
// found nothing for that field.
const MORE_NAMES: Record<CsvField, string[]> = {
  date: ['posting date', 'post date', 'trans date', 'transaction posted date', 'booking date', 'value date', 'date posted'],
  merchant: ['payee name', 'merchant name', 'transaction description', 'original description', 'details', 'counterparty'],
  amount: ['transaction amount', 'amount usd', 'net amount', 'value'],
  debit: ['debit', 'debits', 'debit amount', 'withdrawal', 'withdrawals', 'withdrawal amount', 'money out', 'paid out', 'outflow', 'spent'],
  credit: ['credit', 'credits', 'credit amount', 'deposit', 'deposits', 'deposit amount', 'money in', 'paid in', 'inflow', 'received'],
  category: ['category name', 'type of spending', 'budget category'],
  account: ['account number', 'card', 'card name', 'account type'],
  notes: ['notes', 'note', 'memo', 'comment', 'comments'],
};

const strictHeader = (h: string) => h.replace(/^﻿/, '').trim().toLowerCase();
const looseHeader = (h: string) =>
  strictHeader(h).replace(/[_\-./()[\]:#*]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Guess the mapping from a header row. Returns column indexes; a field with no
 * plausible column is null. A file with an Amount column never also maps Money
 * in / Money out (one amount source per row). Dates default to month-first
 * (how the original importer reads 03/04/2025); detectDateOrder refines it.
 */
export function suggestMapping(headers: string[]): CsvMapping {
  const strict = headers.map(strictHeader);
  const loose = headers.map(looseHeader);
  const used = new Set<number>();
  const pick = (field: CsvField): number | null => {
    const orig = ORIGINAL_NAMES[field];
    if (orig) {
      const i = strict.findIndex((h, j) => !used.has(j) && orig.includes(h));
      if (i >= 0) { used.add(i); return i; }
    }
    const names = [...(orig ?? []), ...MORE_NAMES[field]];
    const i = loose.findIndex((h, j) => !used.has(j) && names.includes(h));
    if (i >= 0) { used.add(i); return i; }
    return null;
  };
  // Order matters only for the claim on a column: the original importer's fields
  // first, so they pick exactly what it picks.
  const date = pick('date');
  const merchant = pick('merchant');
  const amount = pick('amount');
  const account = pick('account');
  const category = pick('category');
  const debit = amount == null ? pick('debit') : null;
  const credit = amount == null ? pick('credit') : null;
  const notes = pick('notes');
  return { date, merchant, amount, debit, credit, category, account, notes, dateOrder: 'mdy', flipSign: false, hasHeader: true };
}

/**
 * Whether a file's first row is really a transaction rather than column names:
 * none of its cells is a header name we know for a date or an amount, yet one
 * cell reads as a date and another as an amount (05/01/2026, -12.50, …).
 */
export function looksHeaderless(firstRow: string[]): boolean {
  const m = suggestMapping(firstRow);
  if (m.date != null || m.amount != null || m.debit != null || m.credit != null) return false;
  const dateCol = firstRow.findIndex(c => parseDateCell(c) != null);
  return dateCol >= 0 && firstRow.some((c, i) => i !== dateCol && c.trim() !== '' && parseAmountCell(c) != null);
}

/**
 * A guess for a file with no header row, from its first rows: the first column
 * that mostly reads as dates, the first other column that mostly reads as
 * amounts, and the wordiest remaining column as the description. Anything less
 * clear is left for the user to pick.
 */
export function suggestMappingFromData(rows: string[][]): CsvMapping {
  const sample = rows.slice(0, 20);
  const width = sample.reduce((w, r) => Math.max(w, r.length), 0);
  const filled = (col: number) => sample.map(r => (r[col] ?? '').trim()).filter(Boolean);
  const mostly = (col: number, ok: (c: string) => boolean) => {
    const cells = filled(col);
    return cells.length > 0 && cells.length >= sample.length / 2 && cells.filter(ok).length >= cells.length * 0.8;
  };
  const cols = [...Array(width).keys()];
  const date = cols.find(c => mostly(c, v => parseDateCell(v) != null)) ?? null;
  const amount = cols.find(c => c !== date && mostly(c, v => parseAmountCell(v) != null)) ?? null;
  let merchant: number | null = null, longest = 0;
  for (const c of cols) {
    if (c === date || c === amount) continue;
    const cells = filled(c).filter(v => parseAmountCell(v) == null && parseDateCell(v) == null);
    const avg = cells.length ? cells.reduce((s, v) => s + v.length, 0) / cells.length : 0;
    if (cells.length >= sample.length / 2 && avg > longest) { merchant = c; longest = avg; }
  }
  return { ...EMPTY_MAPPING, date, amount, merchant, hasHeader: false };
}

/**
 * Clean a mapping that arrived over the wire: every column index must be an
 * integer inside the file, unknown keys are dropped, and anything malformed
 * falls back to "not mapped". When both an Amount and Money in/out are chosen,
 * Amount wins (the row reader uses one source).
 */
export function sanitizeMapping(input: unknown, columnCount: number): CsvMapping {
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const col = (v: unknown): number | null =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < columnCount ? v : null;
  const m: CsvMapping = {
    date: col(src.date), merchant: col(src.merchant), amount: col(src.amount),
    debit: col(src.debit), credit: col(src.credit), category: col(src.category),
    account: col(src.account), notes: col(src.notes),
    dateOrder: src.dateOrder === 'dmy' ? 'dmy' : 'mdy',
    flipSign: src.flipSign === true,
    hasHeader: src.hasHeader !== false,
  };
  if (m.amount != null) { m.debit = null; m.credit = null; }
  return m;
}

// --- Dates --------------------------------------------------------------------

const pad2 = (n: number) => String(n).padStart(2, '0');

function validYmd(y: number, m: number, d: number): string | null {
  if (!(y >= 1900 && y <= 2100) || !(m >= 1 && m <= 12) || d < 1) return null;
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate(); // days in that month (leap-aware)
  return d <= dim ? `${y}-${pad2(m)}-${pad2(d)}` : null;
}

// Two-digit years follow the JavaScript date parser the original importer fell
// back on: 00–49 → 2000s, 50–99 → 1900s.
const fullYear = (y: string) => (y.length === 4 ? Number(y) : Number(y) + (Number(y) < 50 ? 2000 : 1900));

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})/;
const YMD_RE = /^(\d{4})[/.\-](\d{1,2})[/.\-](\d{1,2})(?!\d)/;
const NUMERIC_RE = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4}|\d{2})(?!\d)/;
const MONTH_WORD_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\b/i;

/**
 * A cell as YYYY-MM-DD, or null when it isn't a real calendar date.
 *  - 2025-04-03 (anything after the day, like a time, is ignored), 2025/4/3, 2025-4-3
 *  - 04/03/2025, 04-03-2025, 04.03.25 — month first, or day first with 'dmy'
 *  - "Apr 3, 2025" / "3 April 2025": handed to the JavaScript date parser and
 *    read from local components, exactly as the original importer did
 * Unlike the original importer this rejects impossible dates (2025-02-30,
 * 13/45/2025) instead of storing them.
 */
export function parseDateCell(raw: string, order: DateOrder = 'mdy'): string | null {
  const t = (raw ?? '').trim();
  if (!t) return null;
  let m = t.match(ISO_RE) ?? t.match(YMD_RE);
  if (m) return validYmd(Number(m[1]), Number(m[2]), Number(m[3]));
  m = t.match(NUMERIC_RE);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]), y = fullYear(m[3]);
    return order === 'dmy' ? validYmd(y, b, a) : validYmd(y, a, b);
  }
  // Written-out month names only: the JS parser also "reads" bare numbers like
  // "2" or "45123" as dates, which would silently invent a date.
  if (!MONTH_WORD_RE.test(t) || !/\d{4}/.test(t)) return null;
  const d = new Date(t);
  if (isNaN(d.getTime())) return null;
  return validYmd(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

export interface DateOrderGuess {
  order: DateOrder;
  // True when the file's numeric dates fit BOTH orders (every first and second
  // part is 12 or under), so the reader has to choose; also true when the file
  // contradicts itself (some dates only fit month-first, others only day-first).
  ambiguous: boolean;
  // How many cells were of the 03/04/2025 kind; 0 means order doesn't matter.
  numericCount: number;
  conflicting: boolean;
}

/**
 * Decide day/month order from the whole column. A first part over 12 can only be
 * a day (31/01/2025 → day first); a second part over 12 can only be a day in
 * month-first files (01/31/2025). With no such tell-tale anywhere, the file is
 * ambiguous and we keep month-first — what the original importer assumed.
 */
export function detectDateOrder(cells: string[]): DateOrderGuess {
  let numeric = 0, onlyDmy = 0, onlyMdy = 0;
  for (const c of cells) {
    const t = (c ?? '').trim();
    if (ISO_RE.test(t) || YMD_RE.test(t)) continue;
    const m = t.match(NUMERIC_RE);
    if (!m) continue;
    numeric++;
    const a = Number(m[1]), b = Number(m[2]);
    if (a > 12 && b <= 12) onlyDmy++;
    else if (b > 12 && a <= 12) onlyMdy++;
  }
  const conflicting = onlyDmy > 0 && onlyMdy > 0;
  const order: DateOrder = onlyDmy > onlyMdy ? 'dmy' : 'mdy';
  return { order, ambiguous: numeric > 0 && (conflicting || (onlyDmy === 0 && onlyMdy === 0)), numericCount: numeric, conflicting };
}

// --- Amounts ------------------------------------------------------------------

const CURRENCY_CODE_RE = /^(usd|eur|gbp|cad|aud|nzd|chf|jpy|inr|mxn)|(usd|eur|gbp|cad|aud|nzd|chf|jpy|inr|mxn)$/i;

/**
 * A money cell as a number, or null when blank or unreadable. Understands:
 *  - currency symbols and codes: $1,234.56 · €12 · 12.00 USD
 *  - negatives as -12, 12-, −12 (Unicode minus) or accounting-style (12.00)
 *  - thousands separators: 1,234,567.89 · 1.234.567,89 · 1 234,56
 *  - a comma decimal mark: 12,50 (one comma followed by one or two digits)
 * A lone comma followed by exactly three digits (1,234) is read as thousands, as
 * the original importer did. With `decimalComma` (a file whose amounts use a
 * comma as the decimal mark — see detectDecimalComma) a lone dot followed by
 * exactly three digits (1.234) is read as thousands too; otherwise a lone dot is
 * always the decimal mark (12.345 stays 12.345). Never returns NaN, ±Infinity
 * or -0.
 */
export function parseAmountCell(raw: string, decimalComma = false): number | null {
  let s = (raw ?? '').replace(/[\s  ]/g, '');
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[$€£¥₹]/g, '').replace(CURRENCY_CODE_RE, '');
  if (/^[-−]/.test(s)) { neg = !neg; s = s.slice(1); }
  else if (/[-−]$/.test(s)) { neg = !neg; s = s.slice(0, -1); }
  else if (s.startsWith('+')) s = s.slice(1);
  // Symbols can sit inside the sign: -$12.00, ($12.00), $-12.00.
  s = s.replace(/[$€£¥₹]/g, '');
  if (/^[-−]/.test(s)) { neg = !neg; s = s.slice(1); }
  if (!/^[\d.,]*\d[\d.,]*$/.test(s)) return null;

  const lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.');
  let normalized: string;
  if (lastComma >= 0 && lastDot >= 0) {
    // Both present: whichever comes last is the decimal mark.
    normalized = lastDot > lastComma ? s.replace(/,/g, '') : s.replace(/\./g, '').replace(',', '.');
  } else if (lastComma >= 0) {
    const commas = s.split(',').length - 1;
    // 12,5 / 12,50 → decimal comma; 1,234 / 1,234,567 → thousands.
    normalized = commas === 1 && /,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
  } else {
    const dots = s.split('.').length - 1;
    // 1.234.567 → thousands; 1.234 → thousands only in a decimal-comma file.
    normalized = dots > 1 || (decimalComma && /^\d{1,3}\.\d{3}$/.test(s)) ? s.replace(/\./g, '') : s;
  }
  if (!/^\d+(\.\d+)?$|^\.\d+$|^\d+\.$/.test(normalized)) return null;
  const n = Number(normalized) * (neg ? -1 : 1);
  if (!Number.isFinite(n)) return null;
  return n === 0 ? 0 : n; // never -0
}

/**
 * Whether a file writes amounts with a comma as the decimal mark (12,50 or
 * 1.234,56), decided once for the whole file so an ambiguous cell like 1.234 is
 * read the same way as its neighbours. True for a semicolon-separated file (the
 * usual European spreadsheet export) or when any amount cell ends in a comma and
 * one or two digits.
 */
export function detectDecimalComma(cells: string[], delimiter: string): boolean {
  if (delimiter === ';') return true;
  return cells.some(c => /^\d[\d.]*,\d{1,2}$/.test((c ?? '').replace(/[^\d.,]/g, '')));
}

// --- One row → one transaction ----------------------------------------------------

export interface ParsedCsvRow {
  date: string;      // YYYY-MM-DD
  amount: number;    // KevFin sign: money out < 0
  merchant: string;  // trimmed; 'Unknown' when blank (as the original importer)
  account: string;   // trimmed; 'Imported' when blank or unmapped
  category: string;  // trimmed; '' when blank
  notes: string;
}

// `value` is the cell that couldn't be read, kept out of `reason` so the screen
// can hide it in privacy mode (it may be an amount).
export type RowResult = { ok: true; txn: ParsedCsvRow } | { ok: false; reason: string; value?: string };

// KevFin's own exports guard text cells that start with = + - @ tab or CR with a
// leading apostrophe (so a spreadsheet won't run them as formulas). Drop that
// apostrophe on the way back in, so an export → import round trip is lossless.
export function unguardText(s: string): string {
  return /^'[=+\-@\t\r]/.test(s) ? s.slice(1) : s;
}

const cell = (row: string[], i: number | null) => (i == null ? '' : (row[i] ?? ''));
const show = (s: string) => (s.length > 24 ? s.slice(0, 23) + '…' : s);

/**
 * Read one data row through a mapping. Reasons are short, plain-language, and
 * never quote the cell itself (that goes in `value`). `decimalComma` is the
 * file-wide decimal mark from detectDecimalComma.
 */
export function readRow(row: string[], m: CsvMapping, opts: { decimalComma?: boolean } = {}): RowResult {
  if (m.date == null) return { ok: false, reason: 'No date column chosen' };
  const rawDate = cell(row, m.date).trim();
  if (!rawDate) return { ok: false, reason: 'Date is blank' };
  const date = parseDateCell(rawDate, m.dateOrder);
  if (!date) return { ok: false, reason: 'Can’t read the date', value: show(rawDate) };

  const money = (raw: string) => parseAmountCell(raw, opts.decimalComma === true);
  let amount: number;
  if (m.amount != null) {
    const raw = cell(row, m.amount).trim();
    if (!raw) return { ok: false, reason: 'Amount is blank' };
    const n = money(raw);
    if (n == null) return { ok: false, reason: 'Can’t read the amount', value: show(raw) };
    // The flip applies to an Amount column only.
    amount = m.flipSign ? -n : n;
  } else if (m.debit != null || m.credit != null) {
    // Separate columns: money out is subtracted and money in added, whatever sign
    // the bank wrote them with (some write debits as -45.00, some as 45.00). The
    // sign is explicit here, so "purchases are positive" never applies.
    const rawOut = cell(row, m.debit).trim(), rawIn = cell(row, m.credit).trim();
    if (!rawOut && !rawIn) return { ok: false, reason: 'Money in and money out are both blank' };
    const out = rawOut ? money(rawOut) : 0;
    const inn = rawIn ? money(rawIn) : 0;
    if (out == null) return { ok: false, reason: 'Can’t read the amount', value: show(rawOut) };
    if (inn == null) return { ok: false, reason: 'Can’t read the amount', value: show(rawIn) };
    amount = Math.abs(inn) - Math.abs(out);
  } else {
    return { ok: false, reason: 'No amount column chosen' };
  }
  if (amount === 0) amount = 0; // never -0

  const text = (i: number | null) => unguardText(cell(row, i).trim()).trim();
  return {
    ok: true,
    txn: {
      date,
      amount,
      merchant: text(m.merchant) || 'Unknown',
      account: text(m.account) || 'Imported',
      category: text(m.category),
      notes: text(m.notes),
    },
  };
}

/**
 * Sign check: most rows in a bank or card file are purchases, which KevFin stores
 * as negative. When most readable amounts are positive the file probably lists
 * purchases as positive numbers, and the reader may want to flip it. Only a hint:
 * the flip is never turned on automatically.
 */
export function signSummary(amounts: number[]): { positive: number; negative: number; suggestFlip: boolean } {
  let positive = 0, negative = 0;
  for (const a of amounts) { if (a > 0) positive++; else if (a < 0) negative++; }
  return { positive, negative, suggestFlip: positive >= 3 && positive > negative * 2 };
}

/**
 * A stable key for "a file laid out like this one", used to remember the last
 * mapping per layout. Built from the normalized header names, so a re-export
 * from the same bank (new rows, same columns) finds its mapping again. Only
 * meaningful for a file with a header row: the caller must not build one from a
 * headerless file's first row (that row is a transaction).
 */
export function headerSignature(headers: string[]): string {
  return headers.map(looseHeader).join('|');
}

// --- Recognising KevFin's own export ----------------------------------------

/** The transactions export's last column: a short fingerprint of each row's id. */
export const REF_HEADER = 'KevFin ID';

/**
 * A short, stable fingerprint of a transaction id ('k' + 16 hex digits), written
 * in the transactions export so importing that file again recognises every row
 * exactly, whatever the display rules (sign flips, edited amounts, cleaned-up
 * merchant names, renamed categories) did to the other columns. Hashed rather
 * than the raw id, which is long and repeats the row's own text. The leading
 * letter keeps a spreadsheet from reading it as a number. 64 bits (two mixed
 * 32-bit lanes), dependency-free.
 */
export function txnRef(id: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < id.length; i++) {
    const c = id.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 'k' + (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

// --- Wire shapes for POST /api/budget/import/preview and /commit -----------------

export type RowStatus = 'new' | 'duplicate' | 'review';

export interface PreviewRow {
  row: number;            // the row a spreadsheet shows it on (a header is row 1)
  status: RowStatus;
  reason?: string;        // why it's a duplicate / needs a look
  value?: string;         // the unreadable cell behind a "needs a look" reason
  date?: string;
  merchant?: string;
  amount?: number;
  account?: string;
  category?: string;
  notes?: string;
}

export interface ImportPreview {
  headers: string[];
  delimiter: ',' | ';' | '\t';
  suggested: CsvMapping;      // the guess from the header (and the date column)
  mapping: CsvMapping;        // the mapping these results were computed with
  dateOrder: DateOrderGuess;  // what the date column says about day/month order
  sign: { positive: number; negative: number; suggestFlip: boolean };
  counts: { total: number; new: number; duplicate: number; review: number };
  rows: PreviewRow[];         // every data row, in file order
  sample: string[][];         // the first few raw data rows, for the column picker
  missing: ('date' | 'amount')[]; // required fields the mapping doesn't cover
  // The KevFin ID column of a file downloaded from KevFin (found by its header),
  // whose rows are recognised by that id; null for any other file.
  refColumn: number | null;
}

export interface ImportCommitResult {
  added: number;       // rows that were new
  duplicates: number;  // rows already in KevFin (not added twice)
  // Of those, rows that are still saved to the Imported transactions list but
  // hidden from every total because they match a transaction KevFin already has.
  listedDuplicates: number;
  needsLook: number;   // rows left out because a date or amount couldn't be read
  reconciled: number;  // imported rows reconcile removed as matching the bank feed
}
