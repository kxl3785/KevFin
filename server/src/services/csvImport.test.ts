import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

/**
 * CSV import with column matching: preview labels, and the commit going through
 * the original importer. Same harness as budgetFixes.test.ts — a throwaway DB, a
 * pinned clock and a seeded SimpleFIN cache, so no network is touched.
 */

const TMP = mkdtempSync(path.join(tmpdir(), 'kevfin-csvimport-'));
process.env.DB_PATH = path.join(TMP, 'csvimport.db');

const { refreshConnection, clearSimpleFinCaches } = await import('./simplefin.js');
const budget = await import('./budget.js');
const { previewImport, commitImport, classifyRows, canonicalCsv, readSyncedLedger, CsvImportError } = await import('./csvImport.js');
const { exportTransactionsCsv } = await import('./csvExport.js');
const { readRow, suggestMapping, EMPTY_MAPPING } = await import('../shared/csvMapping.js');
const { getDb } = await import('../db/schema.js');
const { default: express } = await import('express');
const { default: budgetRouter } = await import('../routes/budget.js');

const NOW = new Date('2026-06-23T12:00:00Z');
const unix = (iso: string) => Math.floor(Date.parse(iso + 'T12:00:00Z') / 1000);

async function seed() {
  const db = getDb();
  let seq = 0;
  const tx = (date: string, amount: number, payee: string) =>
    ({ id: `ci-${seq++}`, posted: unix(date), amount: amount.toFixed(2), description: payee, payee });
  const checking = {
    org: { name: 'Chase' }, id: 'c-checking', name: 'Total Checking (1234)', currency: 'USD', balance: '5000.00',
    'balance-date': unix('2026-06-23'),
    transactions: [
      tx('2026-05-02', 3000, 'ACME PAYROLL'),
      tx('2026-05-10', -88.4, 'WHOLE FOODS MARKET'),
      tx('2026-05-12', -61.25, 'SHELL OIL 5521'),
    ],
  };
  const brokerage = {
    org: { name: 'Fidelity' }, id: 'c-brokerage', name: 'Individual Brokerage', currency: 'USD', balance: '1000.00',
    'balance-date': unix('2026-06-23'),
    transactions: [tx('2026-05-15', -500, 'BUY VTI')],
  };
  db.prepare('INSERT INTO simplefin_connections (id, access_url) VALUES (1, ?)')
    .run('https://demo:demo@bridge.example.invalid/simplefin');
  db.prepare('INSERT OR REPLACE INTO provider_cache (key, fetched_at, payload) VALUES (?, ?, ?)')
    .run('sf_cache_1', NOW.getTime(), JSON.stringify([checking, brokerage]));
  await refreshConnection(1, 'https://demo:demo@bridge.example.invalid/simplefin');
  db.prepare("UPDATE accounts SET category = 'brokerage' WHERE id = 'c-brokerage'").run();
  await budget.getCategorizedTransactions(); // syncs the feed into the transactions table
}

const importedTable = () =>
  getDb().prepare('SELECT id, date, amount, payee, merchant, account, category, accepted, cat_edited FROM imported_txns ORDER BY id').all();
const clearImported = () => getDb().prepare('DELETE FROM imported_txns').run();
// Imported rows the ledger actually shows (feed duplicates are hidden on read).
const visibleImported = async () => (await budget.getCategorizedTransactions()).filter(t => t.id.startsWith('imp|')).length;

// A file in the layout the original importer accepts, covering every path:
const LEGACY_CSV = [
  'Date,Merchant,Category,Account,Amount',
  '2026-05-10,Whole Foods Market,Groceries,Total Checking (1234),-88.40',      // 1 exact feed duplicate → reconcile removes it
  '05/13/2026,Shell,Gas,Total Checking (1234),-61.25',                       // 2 fuzzy: 1 day off, other wording, same last-4 → hidden on read
  '2026-05-20,"Blue Wave Pool, LLC",Home Services,Total Checking (1234),(180.00)', // 3 new (accounting negative, quoted comma)
  '2026-05-21,Corner Cafe,Coffee Shops,Amex Gold,-4.50',                     // 4 new
  '2026-05-21,Corner Cafe,Coffee Shops,Amex Gold,-4.50',                     // 5 new: same-file same-account repeat is a 2nd charge
  '2026-05-22,Mystery,,Amex Gold,lots',                                     // 6 needs a look (amount)
  'someday,Mystery,,Amex Gold,-1',                                          // 7 needs a look (date)
  '2026-05-23,,,,"$1,234.56"',                                              // 8 new: Unknown / Imported defaults
].join('\n');

let server: import('http').Server;
let base = '';

beforeAll(async () => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  await seed();
  const app = express();
  app.use(express.json());
  app.use('/api/budget', budgetRouter);
  await new Promise<void>(r => { server = app.listen(0, '127.0.0.1', () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/budget`;
});

afterAll(() => {
  vi.useRealTimers();
  server?.close();
  rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => { clearImported(); });

describe('previewImport', () => {
  it('suggests the mapping, labels every row and counts them', () => {
    const p = previewImport(LEGACY_CSV);
    expect(p.headers).toEqual(['Date', 'Merchant', 'Category', 'Account', 'Amount']);
    expect(p.mapping).toEqual({ ...EMPTY_MAPPING, date: 0, merchant: 1, category: 2, account: 3, amount: 4 });
    expect(p.dateOrder).toMatchObject({ order: 'mdy', ambiguous: false, numericCount: 1 });
    expect(p.missing).toEqual([]);
    // Row numbers are the ones a spreadsheet shows: the header is row 1.
    expect(p.rows.map(r => [r.row, r.status, r.reason])).toEqual([
      [2, 'duplicate', 'Already in your linked accounts'],
      [3, 'duplicate', 'Already in your linked accounts'],
      [4, 'new', undefined],
      [5, 'new', undefined],
      [6, 'new', undefined],
      [7, 'review', 'Can’t read the amount'],
      [8, 'review', 'Can’t read the date'],
      [9, 'new', undefined],
    ]);
    // The unreadable cell travels separately, so the screen can hide it in privacy mode.
    expect(p.rows.slice(5, 7).map(r => r.value)).toEqual(['lots', 'someday']);
    expect(p.refColumn).toBeNull();
    expect(p.rows[2]).toMatchObject({ date: '2026-05-20', merchant: 'Blue Wave Pool, LLC', amount: -180, category: 'Home Services' });
    expect(p.rows[7]).toMatchObject({ merchant: 'Unknown', account: 'Imported', amount: 1234.56 });
    expect(p.counts).toEqual({ total: 8, new: 4, duplicate: 2, review: 2 });
    expect(p.sample.length).toBe(5);
    expect(p.sample[0][1]).toBe('Whole Foods Market');
  });

  it('writes nothing', () => {
    const before = getDb().prepare('SELECT COUNT(*) AS n FROM imported_txns').get();
    const changes = getDb().prepare('SELECT total_changes() AS n').get();
    previewImport(LEGACY_CSV);
    previewImport(LEGACY_CSV, { date: 0, amount: 4, flipSign: true });
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM imported_txns').get()).toEqual(before);
    expect(getDb().prepare('SELECT total_changes() AS n').get()).toEqual(changes);
  });

  it('reports missing required columns and labels every row as needing a look', () => {
    const p = previewImport('Foo,Bar\n1,2\n');
    expect(p.missing).toEqual(['date', 'amount']);
    expect(p.counts).toEqual({ total: 1, new: 0, duplicate: 0, review: 1 });
    expect(p.rows[0].reason).toBe('No date column chosen');
  });

  it('handles a header-only file and rejects an empty one', () => {
    const p = previewImport('﻿Date,Amount\r\n');
    expect(p.counts).toEqual({ total: 0, new: 0, duplicate: 0, review: 0 });
    expect(p.rows).toEqual([]);
    expect(() => previewImport('')).toThrow(CsvImportError);
    expect(() => previewImport('\n\n , \n')).toThrow(/empty/);
  });

  it('flags ambiguous day/month order and reads the file the way the user picks', () => {
    const csv = 'Date,Description,Amount\n03/04/2026,A,-1\n05/06/2026,B,-2\n';
    const p = previewImport(csv);
    expect(p.dateOrder).toMatchObject({ ambiguous: true, order: 'mdy' });
    expect(p.rows.map(r => r.date)).toEqual(['2026-03-04', '2026-05-06']);
    const dmy = previewImport(csv, { ...p.mapping, dateOrder: 'dmy' });
    expect(dmy.rows.map(r => r.date)).toEqual(['2026-04-03', '2026-06-05']);
  });

  it('detects a day-first file from the data and suggests it', () => {
    const p = previewImport('Date,Description,Amount\n25/04/2026,A,-1\n03/05/2026,B,-2\n');
    expect(p.suggested.dateOrder).toBe('dmy');
    expect(p.rows.map(r => r.date)).toEqual(['2026-04-25', '2026-05-03']);
  });

  it('hints at a flip when purchases look positive, and applies the flip only when asked', () => {
    const csv = 'Date,Description,Amount\n2026-05-01,A,10\n2026-05-02,B,20\n2026-05-03,C,30\n2026-05-04,Refund,-5\n';
    const p = previewImport(csv);
    expect(p.sign).toEqual({ positive: 3, negative: 1, suggestFlip: true });
    expect(p.rows.map(r => r.amount)).toEqual([10, 20, 30, -5]);
    const flipped = previewImport(csv, { ...p.mapping, flipSign: true });
    expect(flipped.rows.map(r => r.amount)).toEqual([-10, -20, -30, 5]);
    expect(flipped.sign.suggestFlip).toBe(true); // the hint describes the file as written
  });

  it('reads separate money in / money out columns and a semicolon file', () => {
    const p = previewImport('Buchungstag;Empfänger;Debit;Credit\n2026-05-01;Bäckerei;3,20;\n2026-05-02;Gehalt;;2.500,00\n');
    expect(p.delimiter).toBe(';');
    expect(p.mapping).toMatchObject({ date: null, debit: 2, credit: 3 }); // German date header isn't guessed
    const m = previewImport('Buchungstag;Empfänger;Debit;Credit\n2026-05-01;Bäckerei;3,20;\n2026-05-02;Gehalt;;2.500,00\n',
      { ...p.mapping, date: 0, merchant: 1 });
    expect(m.rows.map(r => [r.merchant, r.amount])).toEqual([['Bäckerei', -3.2], ['Gehalt', 2500]]);
    expect(m.sign.suggestFlip).toBe(false);
  });

  it('marks a cross-account repeat inside the file, but not a same-account repeat', () => {
    const p = previewImport([
      'Date,Merchant,Amount,Account',
      '2026-06-01,Gym,-40,Card A',
      '2026-06-02,Gym,-40,Card B',   // same charge seen from another account export
      '2026-06-01,Gym,-40,Card A',   // a genuine 2nd charge on the same card
    ].join('\n'));
    expect(p.rows.map(r => [r.status, r.reason])).toEqual([
      ['new', undefined], ['duplicate', 'Same as row 2 in this file'], ['new', undefined],
    ]);
  });

  it('ignores brokerage trades when looking for duplicates on read', () => {
    // -500 on 05-16 vs the brokerage BUY on 05-15 at a different account: not a dupe.
    const p = previewImport('Date,Merchant,Amount,Account\n2026-05-16,BUY VTI,-500,Other\n');
    expect(p.rows[0].status).toBe('new');
  });
});

describe('commitImport', () => {
  it('stores exactly what the original importer stores for its own layout', async () => {
    budget.importTransactions(LEGACY_CSV);
    const legacyRecon = await budget.reconcileImported();
    const legacy = importedTable();
    const legacyVisible = await visibleImported();
    clearImported();

    const p = previewImport(LEGACY_CSV);
    const r = await commitImport(LEGACY_CSV, p.mapping);
    expect(importedTable()).toEqual(legacy);
    expect(r.reconciled).toBe(legacyRecon.removed);
    // Of the two duplicates, Whole Foods is removed by reconcile and Shell is
    // stored but hidden on read (so it is still listed under Imported transactions).
    expect(r).toEqual({ added: 4, duplicates: 2, listedDuplicates: 1, needsLook: 2, reconciled: 1 });
    // The rows labelled new are exactly the rows the ledger gains.
    expect(await visibleImported()).toBe(legacyVisible);
    expect(legacyVisible).toBe(p.counts.new);
  });

  it('is idempotent: a second commit of the same file labels everything a duplicate and adds nothing', async () => {
    const p = previewImport(LEGACY_CSV);
    await commitImport(LEGACY_CSV, p.mapping);
    const after = importedTable();
    const again = previewImport(LEGACY_CSV);
    expect(again.counts).toEqual({ total: 8, new: 0, duplicate: 6, review: 2 });
    expect(again.rows.filter(x => x.reason === 'Already imported').length).toBe(5);
    await commitImport(LEGACY_CSV, again.mapping);
    expect(importedTable()).toEqual(after);
  });

  it('predicts what the ledger will do with two identical rows on a feed charge’s day', async () => {
    // Pre-existing ledger behaviour, mirrored rather than changed: reconcile deletes
    // the first copy (exact match with the feed), and the read-time merge then
    // hides the second against that same feed charge, so neither shows. The
    // preview says so instead of promising a new row.
    const csv = 'Date,Merchant,Amount,Account\n2026-05-10,WHOLE FOODS MARKET,-88.40,Total Checking (1234)\n2026-05-10,WHOLE FOODS MARKET,-88.40,Total Checking (1234)\n';
    const p = previewImport(csv);
    expect(p.rows.map(r => r.status)).toEqual(['duplicate', 'duplicate']);
    const before = await visibleImported();
    await commitImport(csv, p.mapping);
    expect(await visibleImported()).toBe(before + p.counts.new);
  });

  it('imports a custom layout (money in/out, day-first, flip off) with the right signs and dates', async () => {
    const csv = 'Posting Date,Payee Name,Withdrawal,Deposit,Memo\n02/06/2026,Hardware Co,25.10,,nails\n03/06/2026,Refund Co,,7.00,\n31/05/2026,Bad,abc,,\n';
    const p = previewImport(csv);
    expect(p.suggested).toMatchObject({ date: 0, merchant: 1, debit: 2, credit: 3, notes: 4, dateOrder: 'dmy' });
    const r = await commitImport(csv, p.suggested);
    expect(r).toEqual({ added: 2, duplicates: 0, listedDuplicates: 0, needsLook: 1, reconciled: 0 });
    expect(importedTable().map(x => { const t = x as { date: string; amount: number; payee: string; account: string }; return [t.date, t.amount, t.payee, t.account]; }))
      .toEqual([['2026-06-02', -25.1, 'Hardware Co', 'Imported'], ['2026-06-03', 7, 'Refund Co', 'Imported']]);
  });

  it('refuses to import without a date or amount column, and without a mapping', async () => {
    await expect(commitImport(LEGACY_CSV, { amount: 4 })).rejects.toThrow(/date/);
    await expect(commitImport(LEGACY_CSV, { date: 0 })).rejects.toThrow(/amount/);
    await expect(commitImport(LEGACY_CSV, undefined)).rejects.toThrow(CsvImportError);
    expect(importedTable()).toEqual([]);
  });

  it('round-trips text that the export guarded against formulas', async () => {
    const csv = "Date,Merchant,Amount,Account\n2026-06-05,'=Weird Shop,-9,'-Card\n";
    await commitImport(csv, previewImport(csv).mapping);
    expect(importedTable()).toMatchObject([{ payee: '=Weird Shop', account: '-Card' }]);
  });
});

describe('export → import round trip (csv-math-1, -2, -3)', () => {
  // Everything the app shows and stores, to prove a round trip changes nothing.
  const categoryNames = () => (getDb().prepare('SELECT name FROM budget_categories ORDER BY name').all() as { name: string }[]).map(r => r.name);
  const ledger = async () => (await budget.getCategorizedTransactions()).map(t => [t.id, t.date, t.amount, t.payee, t.category, t.account]);
  const tidy = () => {
    const db = getDb();
    db.prepare("DELETE FROM rules WHERE kind IN ('sign', 'sign_base')").run();
    db.prepare('DELETE FROM txn_amount_overrides').run();
    budget.renameCategory('Groceries', '');
  };
  beforeEach(tidy);
  afterAll(tidy);

  it('adds nothing and changes nothing, with a sign rule, an edited amount, a tidied payee and a renamed category', async () => {
    // A stored import whose payee the Budget page shows tidied ("Pool Service").
    budget.importTransactions('Date,Merchant,Amount,Account,Category\n2026-05-20,Pool Service REF12345678,-180,Amex Gold,\n2026-05-21,Corner Cafe,-4.5,Amex Gold,Coffee Shops\n2026-05-21,Corner Cafe,-4.5,Amex Gold,Coffee Shops\n');
    const all = await budget.getCategorizedTransactions();
    budget.setSignFlip('acme payroll', true);                                   // feed row shown with the opposite sign
    budget.setTxnAmount(all.find(t => t.merchant === 'shell oil 5521')!.id, 70); // feed row shown as -70, stored -61.25
    budget.renameCategory('Groceries', 'Food Shopping');                       // Whole Foods shown as "Food Shopping"

    const csv = await exportTransactionsCsv({});
    expect(csv).toContain('-3000');       // the flipped paycheck as displayed
    expect(csv).toContain(',-70,');       // the edited amount as displayed
    expect(csv).toContain('Pool Service,'); // the tidied payee
    expect(csv).toContain('Food Shopping');  // the display label

    const tableBefore = importedTable(), ledgerBefore = await ledger(), catsBefore = categoryNames();
    const p = previewImport(csv);
    expect(p.refColumn).toBe(5);
    expect(p.counts).toEqual({ total: ledgerBefore.length, new: 0, duplicate: ledgerBefore.length, review: 0 });
    expect(new Set(p.rows.map(r => r.reason))).toEqual(new Set(['From your KevFin download']));
    const r = await commitImport(csv, p.mapping);
    expect(r).toEqual({ added: 0, duplicates: ledgerBefore.length, listedDuplicates: 0, needsLook: 0, reconciled: 0 });
    expect(importedTable()).toEqual(tableBefore);
    expect(await ledger()).toEqual(ledgerBefore);
    expect(categoryNames()).toEqual(catsBefore);
  });

  it('imports only the rows added to a downloaded file, with display labels stored under the real category', async () => {
    budget.renameCategory('Groceries', 'Food Shopping');
    const csv = await exportTransactionsCsv({});
    const edited = csv + '2026-06-10,Farm Stand,-22,Food Shopping,Amex Gold,\r\n';
    const catsBefore = categoryNames();
    const p = previewImport(edited);
    expect(p.counts.new).toBe(1);
    expect(p.rows.at(-1)).toMatchObject({ status: 'new', merchant: 'Farm Stand', category: 'Food Shopping' });
    const r = await commitImport(edited, p.mapping);
    expect(r.added).toBe(1);
    // "Food Shopping" is the label of Groceries: stored as Groceries, no new category.
    expect(importedTable()).toMatchObject([{ payee: 'Farm Stand', amount: -22, category: 'Groceries' }]);
    expect(categoryNames()).toEqual(catsBefore);
    expect((await budget.getCategorizedTransactions()).find(t => t.payee === 'Farm Stand')?.category).toBe('Groceries');
  });

  it('matches a KevFin ID once: a pasted copy of a row is checked by the usual rules', async () => {
    const csv = await exportTransactionsCsv({});
    const lines = csv.split('\r\n');
    const p = previewImport([...lines.slice(0, -1), lines[1], ''].join('\r\n'));
    expect(p.rows[0]).toMatchObject({ status: 'duplicate', reason: 'From your KevFin download' });
    expect(p.rows.at(-1)!.reason).not.toBe('From your KevFin download');
  });
});

describe('files without a header row (csv-ui-2, PS-2, csv-math-4)', () => {
  const HEADERLESS = [
    '"05/01/2026","-12.50","*","","COFFEE SHOP"',
    '"05/02/2026","-40.00","*","","GAS STATION"',
    '"05/03/2026","2500.00","*","","PAYROLL"',
  ].join('\r\n');

  it('is spotted, keeps its first transaction and names columns by number only', () => {
    const p = previewImport(HEADERLESS);
    expect(p.headers).toEqual(['Column 1', 'Column 2', 'Column 3', 'Column 4', 'Column 5']);
    expect(p.mapping).toEqual({ ...EMPTY_MAPPING, date: 0, amount: 1, merchant: 4, hasHeader: false });
    expect(p.counts).toEqual({ total: 3, new: 3, duplicate: 0, review: 0 });
    expect(p.rows.map(r => [r.row, r.merchant, r.amount])).toEqual([[1, 'COFFEE SHOP', -12.5], [2, 'GAS STATION', -40], [3, 'PAYROLL', 2500]]);
    expect(p.headers.join(' ')).not.toMatch(/COFFEE|12\.50|05\/01/);
  });

  it('commits every row, reading the file the way the preview did', async () => {
    const p = previewImport(HEADERLESS);
    const r = await commitImport(HEADERLESS, p.mapping);
    expect(r).toMatchObject({ added: 3, duplicates: 0, needsLook: 0 });
    expect(importedTable().map(x => (x as { payee: string }).payee).sort()).toEqual(['COFFEE SHOP', 'GAS STATION', 'PAYROLL']);
  });

  it('follows the user: a header file read as headerless gains a row, and back', () => {
    const asData = previewImport(LEGACY_CSV, { ...previewImport(LEGACY_CSV).mapping, hasHeader: false });
    expect(asData.counts.total).toBe(9);
    expect(asData.rows[0]).toMatchObject({ row: 1, status: 'review' }); // "Date" isn't a date
    const back = previewImport(HEADERLESS, { ...previewImport(HEADERLESS).mapping, hasHeader: true });
    expect(back.counts.total).toBe(2);
  });

  it('leaves files with a header exactly as before', () => {
    expect(previewImport(LEGACY_CSV).mapping.hasHeader).toBe(true);
    expect(previewImport('Date,Amount\n2026-05-01,-1\n').counts.total).toBe(1);
  });
});

describe('reading awkward files', () => {
  it('keeps every row when a merchant has an unquoted inch mark (csv-math-5)', () => {
    const p = previewImport('Date,Description,Amount\n2026-01-01,SUBWAY 12" SUB,-9.00\n2026-01-02,SHELL,-30.00\n2026-01-03,GYM,-40.00\n');
    expect(p.rows.map(r => [r.merchant, r.amount])).toEqual([['SUBWAY 12" SUB', -9], ['SHELL', -30], ['GYM', -40]]);
  });
  it('reads 1.234 as one thousand two hundred thirty-four in a decimal-comma file (csv-math-8)', () => {
    const p = previewImport('Datum;Text;Betrag\n2026-01-01;Miete;-1.234\n2026-01-02;Bäcker;-3,20\n', { date: 0, merchant: 1, amount: 2 });
    expect(p.rows.map(r => r.amount)).toEqual([-1234, -3.2]);
    // A US file is unchanged.
    expect(previewImport('Date,Description,Amount\n2026-01-01,A,-1.234\n').rows[0].amount).toBe(-1.234);
  });
  it('numbers rows as a spreadsheet does, blank lines included (csv-ui-11)', () => {
    const p = previewImport('Date,Merchant,Amount\n\n2026-05-01,A,-1\n2026-05-02,B,-2');
    expect(p.rows.map(r => [r.merchant, r.row])).toEqual([['A', 3], ['B', 4]]);
  });
  it('ignores "purchases are positive" with money in / money out columns (csv-ui-3)', () => {
    const csv = 'Date,Description,Debit,Credit\n05/01/2026,COFFEE,4.50,\n05/02/2026,PAYROLL,,2500.00\n';
    const p = previewImport(csv, { ...EMPTY_MAPPING, date: 0, merchant: 1, debit: 2, credit: 3, flipSign: true });
    expect(p.rows.map(r => r.amount)).toEqual([-4.5, 2500]);
  });
});

describe('a feed the table has not caught up with (csv-math-11)', () => {
  it('the synced preview and the commit agree with what the ledger gains', async () => {
    // The provider cache gains a charge (as after "Refresh now") that the feed
    // table hasn't been synced with yet.
    const db = getDb();
    const row = db.prepare("SELECT payload FROM provider_cache WHERE key = 'sf_cache_1'").get() as { payload: string };
    const accts = JSON.parse(row.payload);
    const original = row.payload;
    accts[0].transactions.push({ id: 'ci-late', posted: unix('2026-06-20'), amount: '-55.50', description: 'NEW CAFE', payee: 'NEW CAFE' });
    db.prepare("UPDATE provider_cache SET payload = ? WHERE key = 'sf_cache_1'").run(JSON.stringify(accts));
    clearSimpleFinCaches(); // read the cache from the DB, as after a restart
    try {
      const csv = 'Date,Merchant,Amount,Account\n2026-06-20,NEW CAFE,-55.50,Total Checking (1234)\n';
      expect(previewImport(csv).rows[0].status).toBe('new'); // the unsynced table alone misses it
      const p = previewImport(csv, undefined, await readSyncedLedger());
      expect(p.rows[0]).toMatchObject({ status: 'duplicate', reason: 'Already in your linked accounts' });
      const r = await commitImport(csv, p.mapping);
      expect(r.added).toBe(0);
      expect((await budget.getCategorizedTransactions()).filter(t => t.amount === -55.5).length).toBe(1);
      expect(importedTable()).toEqual([]);
    } finally {
      db.prepare("UPDATE provider_cache SET payload = ? WHERE key = 'sf_cache_1'").run(original);
      clearSimpleFinCaches();
      db.prepare("DELETE FROM transactions WHERE id = 'ci-late'").run();
    }
  });
});

describe('canonicalCsv', () => {
  it('quotes text so the original parser reads it back verbatim', () => {
    const rows = [{ date: '2026-01-02', amount: -1234.5, merchant: 'A "quoted", name', account: 'Line\nbreak', category: '', notes: '' }];
    expect(canonicalCsv(rows)).toBe('Date,Merchant,Amount,Account,Category\n2026-01-02,"A ""quoted"", name",-1234.5,"Line\nbreak",');
  });
});

describe('classifyRows (pure)', () => {
  const m = suggestMapping(['Date', 'Merchant', 'Amount', 'Account']);
  const rows = (cells: string[][]) => cells.map(c => readRow(c, m));
  it('labels against an empty ledger: everything readable is new', () => {
    const out = classifyRows(rows([['2026-01-01', 'A', '-1', 'X'], ['bad', 'B', '-1', 'X']]), { feed: [], brokerageAccountIds: new Set(), imported: [] });
    expect(out.map(r => r.status)).toEqual(['new', 'review']);
  });
  it('matches a stored import from another file within 3 days', () => {
    const out = classifyRows(rows([['2026-01-03', 'Gym', '-40', 'Visa 9999']]), {
      feed: [], brokerageAccountIds: new Set(),
      imported: [{ id: 'imp|other', date: '2026-01-01', amount: -40, payee: 'Gym', merchant: 'gym', account: 'Card' }],
    });
    expect(out[0]).toMatchObject({ status: 'duplicate', reason: 'Already imported from another file' });
  });
  it('does not match beyond the 3-day window', () => {
    const out = classifyRows(rows([['2026-01-05', 'Gym', '-40', 'Visa 9999']]), {
      feed: [], brokerageAccountIds: new Set(),
      imported: [{ id: 'imp|other', date: '2026-01-01', amount: -40, payee: 'Gym', merchant: 'gym', account: 'Card' }],
    });
    expect(out[0].status).toBe('new');
  });
  it('handles no rows', () => {
    expect(classifyRows([], { feed: [], brokerageAccountIds: new Set(), imported: [] })).toEqual([]);
  });
});

describe('routes', () => {
  const post = async (p: string, body: unknown) => {
    const res = await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json() as any };
  };
  it('POST /import/preview returns the labels and writes nothing', async () => {
    const r = await post('/import/preview', { csv: LEGACY_CSV });
    expect(r.status).toBe(200);
    expect(r.json.counts).toEqual({ total: 8, new: 4, duplicate: 2, review: 2 });
    expect(importedTable()).toEqual([]);
  });
  it('POST /import/preview rejects a missing or empty file in plain words', async () => {
    expect(await post('/import/preview', {})).toEqual({ status: 400, json: { error: 'Choose a CSV file first.' } });
    expect((await post('/import/preview', { csv: '   ' })).status).toBe(400);
  });
  it('POST /import/commit imports and returns the counts', async () => {
    const r = await post('/import/commit', { csv: LEGACY_CSV, mapping: previewImport(LEGACY_CSV).mapping });
    expect(r).toEqual({ status: 200, json: { added: 4, duplicates: 2, listedDuplicates: 1, needsLook: 2, reconciled: 1 } });
  });
  it('POST /import/commit explains a missing column', async () => {
    const r = await post('/import/commit', { csv: LEGACY_CSV, mapping: { amount: 4 } });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/date/);
  });
  it('the original POST /import is unchanged', async () => {
    const r = await post('/import', { csv: LEGACY_CSV });
    expect(r).toEqual({ status: 200, json: { imported: 6, skipped: 2, reconciled: 1 } });
  });
});
