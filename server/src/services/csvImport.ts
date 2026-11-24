import { getDb } from '../db/schema.js';
import { readFeedTransactions, type RawTxn } from './feedStore.js';
import {
  importTransactions, reconcileImported, isDuplicateTxn, acctLast4, merchantKey, normAcct, acctCompatible,
  getFeedTransactions, getCategoryLabeler, type DupTxn,
} from './budget.js';
import {
  parseCsvRecords, detectDelimiter, suggestMapping, suggestMappingFromData, looksHeaderless, sanitizeMapping, readRow,
  detectDateOrder, detectDecimalComma, signSummary, parseAmountCell, unguardText, txnRef, REF_HEADER,
  type CsvMapping, type ParsedCsvRow, type RowResult, type PreviewRow, type ImportPreview, type ImportCommitResult,
} from '../shared/csvMapping.js';

export type { RowStatus, PreviewRow, ImportPreview, ImportCommitResult } from '../shared/csvMapping.js';

// CSV import with column matching and a dry-run preview.
//
// The preview reads the file through a column mapping (guessed from the header
// or chosen by the user) and labels every row: new, a duplicate of something
// KevFin already has, or one that needs a look (a date or amount it can't read).
// It writes nothing.
//
// The commit re-runs the same reading on the server (the client's labels are
// never trusted), rewrites the readable rows into the plain layout the original
// importer accepts (Date, Merchant, Amount, Account, Category — ISO dates, plain
// numbers) and hands that to importTransactions + reconcileImported, unchanged.
// So row ids, de-duplication, reconciliation against the bank feed and category
// handling are exactly today's. Rows labelled duplicate are passed through too,
// on purpose: the ledger decides duplicates when it is read (budget.ts
// categorize), one-to-one and in table order, so dropping a duplicate row here
// could shift which rows match which and hide a genuine repeat charge. Passed
// through, they are ignored by id, removed by reconcile, or hidden on read —
// never shown or counted twice — exactly as they would be via the old import.
// The one exception is a row of KevFin's own transactions download recognised
// by its KevFin ID: that row IS a stored transaction, so it is never sent.
//
// Round trip: the transactions download shows what the Budget page shows (sign
// rules, edited amounts, tidied merchant names and renamed categories applied),
// so its rows can't be matched on those columns. Each row also carries a KevFin
// ID (a fingerprint of its transaction id); importing the file again recognises
// every row by it, adds nothing and changes nothing.

export const MAX_IMPORT_ROWS = 50_000;
const SAMPLE_ROWS = 5;

export class CsvImportError extends Error {}

// --- The ledger as the import sees it ------------------------------------------

export interface ImportedRow { id: string; date: string; amount: number; payee: string; merchant: string; account: string }
export interface LedgerSnapshot {
  feed: RawTxn[];                      // every stored bank-feed transaction
  brokerageAccountIds: Set<string>;    // their trades are left out of the budget
  imported: ImportedRow[];             // imported_txns, in table order
}

export function readLedger(): LedgerSnapshot {
  const db = getDb();
  const feed = readFeedTransactions(db);
  const brokerageAccountIds = new Set(
    (db.prepare("SELECT id FROM accounts WHERE category = 'brokerage'").all() as { id: string }[]).map(a => a.id),
  );
  const imported = db.prepare('SELECT id, date, amount, payee, merchant, account FROM imported_txns ORDER BY rowid').all() as ImportedRow[];
  return { feed, brokerageAccountIds, imported };
}

/**
 * readLedger after bringing the feed table up to date with the providers' caches
 * — the same sync every Budget read and reconcileImported do — so the preview
 * sees the feed the commit's reconcile will see. A failed provider read falls
 * back to the table as stored (the commit then reports what reconcile removed).
 */
export async function readSyncedLedger(): Promise<LedgerSnapshot> {
  try { await getFeedTransactions(); } catch (err) { console.warn('[csvImport] feed sync failed, using stored feed:', err); }
  return readLedger();
}

// --- Classifying rows --------------------------------------------------------------

/** A readable file row as importTransactions will store it. */
interface Candidate { index: number; txn: ParsedCsvRow; id: string; merchant: string }

// importTransactions' row id: date|amount|merchant key|account, with a |n suffix
// on the 2nd+ identical row in one file. Mirrored here (and pinned by a test
// against the real importer) so "already imported" can be told before writing.
// Rows in `skip` are never sent to the importer, so they don't take a number.
function candidatesOf(results: RowResult[], skip: Set<number>): Candidate[] {
  const seen = new Map<string, number>();
  const out: Candidate[] = [];
  results.forEach((r, index) => {
    if (!r.ok || skip.has(index)) return;
    const t = r.txn;
    const merchant = merchantKey(t.merchant, '');
    const baseId = `imp|${t.date}|${t.amount.toFixed(2)}|${merchant}|${t.account.toLowerCase().slice(0, 20)}`;
    const n = (seen.get(baseId) ?? 0) + 1;
    seen.set(baseId, n);
    out.push({ index, txn: t, merchant, id: n === 1 ? baseId : `${baseId}|${n}` });
  });
  return out;
}

const dayMs = (d: string) => Date.parse(d + 'T00:00:00Z');
const feedDate = (posted: number) => new Date(posted * 1000).toISOString().slice(0, 10);

// How a duplicate row was recognised, which decides what the commit does with it:
//  'ref'       KevFin ID of a stored transaction → never sent to the importer;
//  'id'        same row id as a stored import → INSERT OR IGNORE skips it;
//  'reconcile' reconcileImported deletes it right after it is stored;
//  'hidden'    stored, but the ledger hides it on read (it stays in the
//              Imported transactions list, counted nowhere).
type MatchKind = 'ref' | 'id' | 'reconcile' | 'hidden';

export interface ClassifyOptions {
  // Spreadsheet row number of each result (default: index + 1).
  rowNumbers?: number[];
  // The KevFin ID cell of each result, when the file is a KevFin download.
  refs?: (string | undefined)[];
}

function classify(results: RowResult[], ledger: LedgerSnapshot, opts: ClassifyOptions = {}): { rows: PreviewRow[]; how: (MatchKind | undefined)[] } {
  const rowNo = (i: number) => opts.rowNumbers?.[i] ?? i + 1;
  const out: PreviewRow[] = results.map((r, i) => r.ok
    ? { row: rowNo(i), status: 'new', ...r.txn }
    : { row: rowNo(i), status: 'review', reason: r.reason, ...(r.value != null ? { value: r.value } : {}) });
  const how: (MatchKind | undefined)[] = results.map(() => undefined);
  const mark = (i: number, kind: MatchKind, reason: string) => { how[i] = kind; Object.assign(out[i], { status: 'duplicate', reason }); };

  // 0. A row of KevFin's own download, by its KevFin ID: one stored transaction
  //    per id (a pasted copy of the row is matched by the usual rules instead).
  const exported = new Set<number>();
  if (opts.refs) {
    const known = new Map<string, boolean>(); // ref → already matched by a row
    for (const t of ledger.feed) known.set(txnRef(t.id), false);
    for (const r of ledger.imported) known.set(txnRef(r.id), false);
    results.forEach((r, i) => {
      const ref = opts.refs![i];
      if (!r.ok || !ref || known.get(ref) !== false) return;
      known.set(ref, true);
      exported.add(i);
      mark(i, 'ref', 'From your KevFin download');
    });
  }

  // 1. Same row id as a stored import.
  const candidates = candidatesOf(results, exported);
  const existingIds = new Set(ledger.imported.map(r => r.id));
  const fresh: Candidate[] = [];
  for (const c of candidates) {
    if (existingIds.has(c.id)) mark(c.index, 'id', 'Already imported');
    else fresh.push(c);
  }

  // 2. reconcileImported, over the stored rows then the new ones (rowid order).
  const mk = (date: string, amount: number, merchant: string) => `${date}|${amount.toFixed(2)}|${merchant}`;
  type SfEntry = { acct: string; consumed: boolean };
  const byMerchantKey = new Map<string, SfEntry[]>(), byDateAmt = new Map<string, SfEntry[]>();
  const push = (m: Map<string, SfEntry[]>, k: string, e: SfEntry) => (m.get(k) ?? m.set(k, []).get(k)!).push(e);
  for (const t of ledger.feed) {
    const e: SfEntry = { acct: normAcct(t.accountName), consumed: false };
    push(byMerchantKey, mk(feedDate(t.posted), t.amount, merchantKey(t.payee, t.description)), e);
    push(byDateAmt, `${feedDate(t.posted)}|${t.amount.toFixed(2)}`, e);
  }
  const reconciles = (r: { date: string; amount: number; merchant: string; account: string }): boolean => {
    let match = byMerchantKey.get(mk(r.date, r.amount, r.merchant))?.find(e => !e.consumed);
    if (!match) {
      const ra = normAcct(r.account);
      match = byDateAmt.get(`${r.date}|${r.amount.toFixed(2)}`)?.find(e => !e.consumed && acctCompatible(e.acct, ra));
    }
    if (match) match.consumed = true;
    return !!match;
  };
  const keptExisting = ledger.imported.filter(r => !reconciles(r));
  const keptFresh: Candidate[] = [];
  for (const c of fresh) {
    if (reconciles({ date: c.txn.date, amount: c.txn.amount, merchant: c.merchant, account: c.txn.account })) {
      mark(c.index, 'reconcile', 'Already in your linked accounts');
    } else keptFresh.push(c);
  }

  // 3. The read-time merge, seeded with non-brokerage feed transactions.
  type Entry = DupTxn & { consumed: boolean; importedAcct?: string; fileRow?: number };
  const byAmount = new Map<string, Entry[]>();
  const add = (e: Entry) => { const k = e.amount.toFixed(2); (byAmount.get(k) ?? byAmount.set(k, []).get(k)!).push(e); };
  for (const t of ledger.feed) {
    if (ledger.brokerageAccountIds.has(t.accountId)) continue;
    add({ amount: t.amount, day: dayMs(feedDate(t.posted)), merchant: merchantKey(t.payee, t.description), acct: acctLast4(t.accountName), consumed: false });
  }
  const consume = (r: DupTxn, importedAcct: string): Entry | undefined => {
    const cand = (byAmount.get(r.amount.toFixed(2)) ?? []).find(e =>
      !e.consumed && !(e.importedAcct !== undefined && e.importedAcct === importedAcct) && isDuplicateTxn(r, e));
    if (cand) cand.consumed = true;
    return cand;
  };
  for (const r of keptExisting) {
    const dup: DupTxn = { amount: r.amount, day: dayMs(r.date), merchant: merchantKey(r.merchant, r.payee), acct: acctLast4(r.account) };
    const importedAcct = r.account.toLowerCase();
    if (!consume(dup, importedAcct)) add({ ...dup, consumed: false, importedAcct });
  }
  for (const c of keptFresh) {
    const dup: DupTxn = { amount: c.txn.amount, day: dayMs(c.txn.date), merchant: merchantKey(c.merchant, c.txn.merchant), acct: acctLast4(c.txn.account) };
    const importedAcct = c.txn.account.toLowerCase();
    const hit = consume(dup, importedAcct);
    if (!hit) { add({ ...dup, consumed: false, importedAcct, fileRow: rowNo(c.index) }); continue; }
    const reason = hit.fileRow != null ? `Same as row ${hit.fileRow} in this file`
      : hit.importedAcct !== undefined ? 'Already imported from another file' : 'Already in your linked accounts';
    mark(c.index, 'hidden', reason);
  }
  return { rows: out, how };
}

/**
 * Label each readable row. Mirrors, in order, what happens to it after commit:
 *  0. it carries the KevFin ID of a stored transaction (the file is a KevFin
 *     transactions download) → it is that transaction, and is not sent;
 *  1. its id is already stored → INSERT OR IGNORE skips it ("Already imported");
 *  2. reconcileImported would delete it (same date and amount as a feed
 *     transaction, with the same merchant or a compatible account);
 *  3. the ledger would hide it on read (budget.ts categorize: same amount within
 *     3 days and the same merchant or account last-4, via isDuplicateTxn, one-to-
 *     one against feed transactions and imports from a different file/account).
 * Rows from the same account string in one file are distinct charges (two $4.50
 * coffees), never duplicates of each other — the ledger's own rule.
 */
export function classifyRows(results: RowResult[], ledger: LedgerSnapshot, opts: ClassifyOptions = {}): PreviewRow[] {
  return classify(results, ledger, opts).rows;
}

// --- Preview -------------------------------------------------------------------------

interface FileRead {
  headers: string[];
  data: string[][];
  rowNumbers: number[];   // spreadsheet row of each data row
  delimiter: ',' | ';' | '\t';
  hasHeader: boolean;
}

function readFile(csv: string, hasHeader: boolean | 'detect'): FileRead {
  if (typeof csv !== 'string' || !csv.trim()) throw new CsvImportError('That file is empty.');
  const delimiter = detectDelimiter(csv);
  const records = parseCsvRecords(csv, delimiter);
  if (!records.length) throw new CsvImportError('That file is empty.');
  const header = hasHeader === 'detect' ? !looksHeaderless(records[0].cells) : hasHeader;
  const body = header ? records.slice(1) : records;
  if (body.length > MAX_IMPORT_ROWS) {
    throw new CsvImportError(`That file has more than ${MAX_IMPORT_ROWS.toLocaleString('en-US')} rows. Split it into smaller files and import each one.`);
  }
  const data = body.map(r => r.cells);
  // Without a header row the columns are just numbered — never named after the
  // first transaction's cells.
  const headers = header
    ? records[0].cells.map((h, i) => h.replace(/^\uFEFF/, '').trim() || `Column ${i + 1}`)
    : Array.from({ length: data.reduce((w, r) => Math.max(w, r.length), 0) }, (_, i) => `Column ${i + 1}`);
  return { headers, data, rowNumbers: body.map(r => r.row), delimiter, hasHeader: header };
}

// Everything the preview and the commit compute, so the commit acts on exactly
// what the preview showed.
function analyse(csv: string, mappingInput: unknown, ledger: LedgerSnapshot): { preview: ImportPreview; how: (MatchKind | undefined)[] } {
  // Whether row 1 is a header is guessed until the mapping says (the screen
  // always sends it once a file is open, and the user can change it).
  const given = mappingInput != null && typeof mappingInput === 'object' ? mappingInput as Record<string, unknown> : null;
  const headerSetting = typeof given?.hasHeader === 'boolean' ? given.hasHeader : 'detect';
  const { headers, data, rowNumbers, delimiter, hasHeader } = readFile(csv, headerSetting);
  const width = data.reduce((w, r) => Math.max(w, r.length), headers.length);
  const guess = hasHeader ? suggestMapping(headers) : suggestMappingFromData(data);
  const dateCells = (col: number | null) => (col == null ? [] : data.map(r => r[col] ?? ''));
  const suggested: CsvMapping = { ...guess, dateOrder: detectDateOrder(dateCells(guess.date)).order, hasHeader };
  const mapping = given == null ? suggested : { ...sanitizeMapping(given, width), hasHeader };
  const dateOrder = detectDateOrder(dateCells(mapping.date));

  // One decimal mark for the whole file, from every amount cell it has.
  const amountCols = [mapping.amount, mapping.debit, mapping.credit].filter((c): c is number => c != null);
  const decimalComma = detectDecimalComma(amountCols.flatMap(c => dateCells(c)), delimiter);
  const results = data.map(r => readRow(r, mapping, { decimalComma }));

  // A KevFin transactions download: recognise its rows by the KevFin ID column.
  const refColumn = hasHeader ? headers.findIndex(h => h.trim().toLowerCase() === REF_HEADER.toLowerCase()) : -1;
  const refs = refColumn >= 0 ? data.map(r => unguardText((r[refColumn] ?? '').trim()) || undefined) : undefined;
  const { rows, how } = classify(results, ledger, { rowNumbers, refs });

  // The sign hint is about the file as written, so it looks at the raw amount
  // column (before any flip); with separate in/out columns the sign is explicit.
  const raw = mapping.amount == null ? []
    : data.map(r => parseAmountCell(r[mapping.amount!] ?? '', decimalComma)).filter((n): n is number => n != null);
  const sign = mapping.amount == null ? { positive: 0, negative: 0, suggestFlip: false } : signSummary(raw);

  const missing: ImportPreview['missing'] = [];
  if (mapping.date == null) missing.push('date');
  if (mapping.amount == null && mapping.debit == null && mapping.credit == null) missing.push('amount');

  const counts = { total: rows.length, new: 0, duplicate: 0, review: 0 };
  for (const r of rows) counts[r.status]++;
  return {
    preview: {
      headers, delimiter, suggested, mapping, dateOrder, sign, counts, rows, sample: data.slice(0, SAMPLE_ROWS), missing,
      refColumn: refColumn >= 0 ? refColumn : null,
    },
    how,
  };
}

/**
 * Dry run: read the file through `mappingInput` (or the guessed mapping when
 * none is given) and label every row. Reads the database, writes nothing. The
 * route passes readSyncedLedger() so the feed is as fresh as the commit's.
 */
export function previewImport(csv: string, mappingInput?: unknown, ledger: LedgerSnapshot = readLedger()): ImportPreview {
  return analyse(csv, mappingInput, ledger).preview;
}

// --- Commit -----------------------------------------------------------------------------

/** The readable rows, rewritten in the original importer's own layout. */
export function canonicalCsv(rows: ParsedCsvRow[]): string {
  const lines = [['Date', 'Merchant', 'Amount', 'Account', 'Category'].join(',')];
  for (const t of rows) {
    // Text is quoted as RFC 4180 needs and re-parsed verbatim by budget.ts
    // parseCsv; String(amount) is a plain number its parseFloat reads back exactly.
    lines.push([t.date, rawText(t.merchant), String(t.amount), rawText(t.account), rawText(t.category)].join(','));
  }
  return lines.join('\n');
}
// Quote text for the canonical file WITHOUT the export's formula guard (this file
// is read back by our own parser, never opened in a spreadsheet).
function rawText(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Import the file through `mappingInput`. Only readable rows are sent to the
 * existing importer; rows that need a look, and rows of a KevFin download
 * recognised by their KevFin ID, are left out. Returns the counts the preview
 * showed, as recomputed at commit time, plus what reconcile removed.
 */
export async function commitImport(csv: string, mappingInput: unknown): Promise<ImportCommitResult> {
  if (mappingInput == null || typeof mappingInput !== 'object') throw new CsvImportError('Choose which columns to import first.');
  const { preview, how } = analyse(csv, mappingInput, await readSyncedLedger());
  if (preview.missing.includes('date')) throw new CsvImportError('Choose the column that holds the date.');
  if (preview.missing.includes('amount')) throw new CsvImportError('Choose the column that holds the amount (or the money in and money out columns).');
  // A category as the Budget page labels it (a renamed one, say, from a KevFin
  // download) is stored under its real name, so it doesn't become a new category.
  const lab = getCategoryLabeler();
  const readable = preview.rows
    .filter((r, i) => r.status !== 'review' && how[i] !== 'ref')
    .map(r => ({ date: r.date!, amount: r.amount!, merchant: r.merchant!, account: r.account!, category: r.category ? lab.canon(r.category) : '', notes: r.notes ?? '' }));
  let reconciled = 0;
  if (readable.length) {
    importTransactions(canonicalCsv(readable));
    reconciled = (await reconcileImported()).removed;
  }
  return {
    added: preview.counts.new, duplicates: preview.counts.duplicate,
    listedDuplicates: how.filter(k => k === 'hidden').length,
    needsLook: preview.counts.review, reconciled,
  };
}
