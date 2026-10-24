import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

/**
 * DB-backed regression tests for budget correctness fixes: refund netting,
 * CSV import/dedup behavior, rule-key normalisation, category removal and the
 * category routes. Same harness as budgetGolden.test.ts (throwaway DB, pinned
 * clock, seeded SimpleFIN cache) but with its own small fixture.
 */

const TMP = mkdtempSync(path.join(tmpdir(), 'kevfin-fixes-'));
process.env.DB_PATH = path.join(TMP, 'fixes.db');

const { refreshConnection } = await import('./simplefin.js');
const budget = await import('./budget.js');
const { getDb } = await import('../db/schema.js');
const { default: express } = await import('express');
const { default: budgetRouter } = await import('../routes/budget.js');

const NOW = new Date('2026-06-23T12:00:00Z');
const unix = (iso: string) => Math.floor(Date.parse(iso + 'T12:00:00Z') / 1000);

const LONG_KEY_PAYEE = 'abcdefghi abcdefghi abcdefghi abcdefghi XYZ'; // char 40 is a space

async function seed() {
  const db = getDb();
  let seq = 0;
  const tx = (date: string, amount: number, payee: string) =>
    ({ id: `fx-${seq++}`, posted: unix(date), amount: amount.toFixed(2), description: payee, payee });
  const checking = {
    org: { name: 'Chase' }, id: 'f-checking', name: 'Total Checking (1234)', currency: 'USD', balance: '5000.00',
    'balance-date': unix('2026-06-23'),
    transactions: [
      tx('2026-05-02', 3000, 'ACME PAYROLL'),
      // Refund netting: $100 charge, $30 refund -> $70 net, 1 expense row.
      tx('2026-05-10', -100, 'ZZ GROCER'),
      tx('2026-05-12', 30, 'ZZ GROCER'),
      // Over-refund: $50 charge, $80 refund -> bottoms out at 0 (category dropped).
      tx('2026-05-14', -50, 'ZZ GADGETS'),
      tx('2026-05-20', 80, 'ZZ GADGETS'),
      // A cross-month refund: April charge, May refund must not touch May spending.
      tx('2026-04-20', -40, 'ZZ GADGETS'),
      // 40-char merchant key that ends in a space (rule-key normalisation).
      tx('2026-05-15', -25, LONG_KEY_PAYEE),
      // One feed charge that two identical imported rows both look like.
      tx('2026-05-18', -12.34, 'DUPE CAFE'),
    ],
  };
  db.prepare('INSERT INTO simplefin_connections (id, access_url) VALUES (1, ?)')
    .run('https://demo:demo@bridge.example.invalid/simplefin');
  db.prepare('INSERT OR REPLACE INTO provider_cache (key, fetched_at, payload) VALUES (?, ?, ?)')
    .run('sf_cache_1', NOW.getTime(), JSON.stringify([checking]));
  await refreshConnection(1, 'https://demo:demo@bridge.example.invalid/simplefin');

  await budget.applyCategoryRule('zz grocer', 'Groceries', 'one');
  await budget.applyCategoryRule('zz gadgets', 'Electronics', 'one');
}

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

describe('refunds net against their category (clamped at 0)', () => {
  it('getBudget nets a refund into the category total, YTD, headline spending and cumulative curve', async () => {
    const b = await budget.getBudget('2026-05');
    const groceries = b.byCategory.find(c => c.category === 'Groceries')!;
    expect(groceries.spent).toBeCloseTo(70, 2);
    expect(groceries.count).toBe(1);        // only the expense row is counted
    expect(groceries.ytdSpent).toBeCloseTo(70, 2);
    // Over-refunded category disappears (May: -50 + 80 < 0) instead of going negative.
    expect(b.byCategory.find(c => c.category === 'Electronics')).toBeUndefined();
    // Headline spending is the sum of the clamped category rows: 70 + 25 (long key, Misc) + 12.34.
    expect(b.spending).toBeCloseTo(70 + 25 + 12.34, 2);
    expect(b.byCategory.filter(c => !c.excluded).reduce((s, c) => s + c.spent, 0)).toBeCloseTo(b.spending, 2);
    // Cumulative spend by day: after the refund on the 12th the running total is net.
    const d12 = b.dailyCumulative.find(d => d.day === 12)!;
    expect(d12.current).toBeCloseTo(70, 2);
  });

  it('getSpendingProjection and getCashFlow use the same netting', async () => {
    const p = await budget.getSpendingProjection();
    expect(p.months.find(m => m.month === '2026-05')!.spending).toBe(Math.round(70 + 25 + 12.34));
    expect(p.months.find(m => m.month === '2026-04')!.spending).toBe(40);
    const cf = await budget.getCashFlow('all');
    // All-time: groceries 70, electronics (40 + 50 - 80 = 10), 25, 12.34.
    expect(cf.spending).toBeCloseTo(70 + 10 + 25 + 12.34, 2);
  });
});

describe('rule key normalisation', () => {
  it('a stored 40-char merchant key that ends in a space still matches when sent back', async () => {
    const txns = await budget.getCategorizedTransactions();
    const t = txns.find(x => x.payee.startsWith('abcdefghi'))!;
    expect(t.merchant).toHaveLength(40);
    expect(t.merchant.endsWith(' ')).toBe(true);
    await budget.applyCategoryRule(t.merchant, 'Groceries', 'one');
    const after = (await budget.getCategorizedTransactions()).find(x => x.id === t.id)!;
    expect(after.category).toBe('Groceries');
  });
});

describe('CSV import', () => {
  it('skips blank / non-numeric amounts instead of importing $0', () => {
    const r = budget.importTransactions([
      'Date,Merchant,Amount,Account',
      '2026-03-01,Blank Amt,,Imp Acct 9999',
      '2026-03-02,Junk Amt,n/a,Imp Acct 9999',
      '2026-03-03,Zero Is Fine,0,Imp Acct 9999',
    ].join('\n'));
    expect(r).toEqual({ imported: 1, skipped: 2 });
    getDb().prepare(`DELETE FROM imported_txns`).run();
  });

  it('imports genuinely identical rows in one file, stays idempotent on re-import', () => {
    const csv = [
      'Date,Merchant,Amount,Account',
      '2026-03-10,Twin Coffee,-4.50,Imp Acct 9999',
      '2026-03-10,Twin Coffee,-4.50,Imp Acct 9999',
      '2026-03-10,Twin Coffee,-4.50,Imp Acct 9999',
    ].join('\n');
    expect(budget.importTransactions(csv)).toEqual({ imported: 3, skipped: 0 });
    expect(budget.importTransactions(csv)).toEqual({ imported: 0, skipped: 3 });
    expect(budget.getImported().filter(r => r.payee === 'Twin Coffee')).toHaveLength(3);
    getDb().prepare(`DELETE FROM imported_txns`).run();
  });

  it('does not merge distinct same-amount charges from one export (Mon & Wed coffee)', async () => {
    budget.importTransactions([
      'Date,Merchant,Amount,Account',
      '2026-03-09,Mon Coffee,-4.51,Imp Acct 9999',
      '2026-03-11,Mon Coffee,-4.51,Imp Acct 9999',
    ].join('\n'));
    const kept = (await budget.getCategorizedTransactions()).filter(t => t.merchant === 'mon coffee');
    expect(kept).toHaveLength(2);
    // ...but the same charge exported under a DIFFERENT account string is a cross-export dupe.
    budget.importTransactions('Date,Merchant,Amount,Account\n2026-03-10,Mon Coffee,-4.51,Other Export 9999');
    expect((await budget.getCategorizedTransactions()).filter(t => t.merchant === 'mon coffee')).toHaveLength(2);
    getDb().prepare(`DELETE FROM imported_txns`).run();
  });

  it('reconcile against the feed is one-to-one', async () => {
    budget.importTransactions([
      'Date,Merchant,Amount,Account',
      '2026-05-18,Dupe Cafe,-12.34,Total Checking (1234)',
      '2026-05-18,Dupe Cafe,-12.34,Total Checking (1234)',
    ].join('\n'));
    const { removed } = await budget.reconcileImported();
    expect(removed).toBe(1); // one feed charge consumes one import, not both
    expect(budget.getImported().filter(r => r.payee === 'Dupe Cafe')).toHaveLength(1);
    getDb().prepare(`DELETE FROM imported_txns`).run();
  });
});

describe('removeCategory', () => {
  it('deletes merchant, base and smart rules that point at the category', async () => {
    const name = budget.addCategory('Pets Extra');
    await budget.applyCategoryRule('pet merchant', name, 'all');
    await budget.applySmartRules([{ contains: 'pet food', category: name }]);
    const count = () => (getDb().prepare(`SELECT COUNT(*) AS n FROM rules WHERE category = ?`).get(name) as { n: number }).n;
    expect(count()).toBeGreaterThanOrEqual(3);
    budget.removeCategory(name);
    expect(count()).toBe(0);
  });
});

describe('category routes', () => {
  it('PATCH/DELETE /category/:name use the (already decoded) param — "50% off" does not throw', async () => {
    const created = budget.addCategory('50% off');
    const enc = encodeURIComponent(created);
    const patch = await fetch(`${base}/category/${enc}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'Half price' }),
    });
    expect(patch.status).toBe(200);
    expect(budget.getCategoryLabeler().label(created)).toBe('Half price');
    const del = await fetch(`${base}/category/${enc}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(budget.getActiveCategories()).not.toContain(created);
  });

  it('POST /categories/restore rejects an empty or malformed body without wiping anything', async () => {
    const before = budget.getActiveCategories().length;
    expect(before).toBeGreaterThan(0);
    for (const body of [{}, { categories: [] }, { categories: [{ sort: 1 }] }, { categories: 'nope' }]) {
      const r = await fetch(`${base}/categories/restore`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      expect(r.status).toBe(400);
    }
    expect(budget.getActiveCategories().length).toBe(before);
  });

  it('POST /categories/restore still round-trips a real snapshot', async () => {
    const snap = budget.getCategoryState();
    const r = await fetch(`${base}/categories/restore`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(snap),
    });
    expect(r.status).toBe(200);
    expect(budget.getActiveCategories().length).toBe(snap.categories.length);
  });
});
