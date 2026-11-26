import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

/**
 * Quick review's one-tap apply (applyReviewChoice + POST /api/budget/review/apply):
 * at most ONE smart rule from the ticked conditions, and every charge listed on the
 * card ends up in the chosen category. Same harness as assistantActions.test.ts:
 * a throwaway DB, a pinned clock and a seeded SimpleFIN cache.
 */

const TMP = mkdtempSync(path.join(tmpdir(), 'kevfin-review-'));
process.env.DB_PATH = path.join(TMP, 'review.db');

const { refreshConnection } = await import('./simplefin.js');
const budget = await import('./budget.js');
const { getDb } = await import('../db/schema.js');
const { default: express } = await import('express');
const { default: budgetRouter } = await import('../routes/budget.js');

const NOW = new Date('2026-06-23T12:00:00Z');
const unix = (iso: string) => Math.floor(Date.parse(iso + 'T12:00:00Z') / 1000);
let server: import('http').Server;
let base = '';

async function seed() {
  const db = getDb();
  let seq = 0;
  const tx = (date: string, amount: number, payee: string) =>
    ({ id: `rv-${seq++}`, posted: unix(date), amount: amount.toFixed(2), description: payee, payee });
  const checking = {
    org: { name: 'Chase' }, id: 'a-checking', name: 'Total Checking (1234)', currency: 'USD', balance: '5000.00',
    'balance-date': unix('2026-06-23'),
    transactions: [
      tx('2026-05-02', -9.99, 'ZQX STREAMFLIX'),   // rv-0
      tx('2026-06-02', -9.99, 'ZQX STREAMFLIX'),   // rv-1
      tx('2026-06-05', -24.5, 'ZQX STREAMFLIX'),   // rv-2
      tx('2026-06-07', -9.99, 'QQ BOOKS'),         // rv-3 (same amount, other payee)
      tx('2026-06-08', -40, 'QQ HARDWARE'),        // rv-4
      tx('2026-06-09', -15, 'ZELLE TO JORDAN'),    // rv-5
    ],
  };
  db.prepare('INSERT INTO simplefin_connections (id, access_url) VALUES (1, ?)')
    .run('https://demo:demo@bridge.example.invalid/simplefin');
  db.prepare('INSERT OR REPLACE INTO provider_cache (key, fetched_at, payload) VALUES (?, ?, ?)')
    .run('sf_cache_1', NOW.getTime(), JSON.stringify([checking]));
  await refreshConnection(1, 'https://demo:demo@bridge.example.invalid/simplefin');
}

const cat = async (id: string) => (await budget.getCategorizedTransactions()).find(t => t.id === id)!;
const rules = () => getDb().prepare(`SELECT kind, base, contains, amount, category FROM rules WHERE kind IN ('merchant','base','smart')`).all();
const pins = () => (getDb().prepare('SELECT COUNT(*) AS n FROM txn_category_overrides').get() as { n: number }).n;
const merchantOf = async (id: string) => (await cat(id)).merchant;

beforeAll(async () => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  await seed();
  const app = express();
  app.use(express.json());
  app.use('/api/budget', budgetRouter);
  await new Promise<void>(r => { server = app.listen(0, '127.0.0.1', () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/budget`;
});
afterAll(() => { vi.useRealTimers(); server?.close(); rmSync(TMP, { recursive: true, force: true }); });
beforeEach(() => {
  getDb().prepare('DELETE FROM rules').run();
  getDb().prepare('DELETE FROM txn_category_overrides').run();
});

const post = (route: string, body: unknown) =>
  fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('review apply', () => {
  it('payee rule: one smart rule, the whole payee filed, no pins', async () => {
    const m = await merchantOf('rv-0');
    const r = await budget.applyReviewChoice({ ids: ['rv-0', 'rv-1', 'rv-2'], category: 'Subscriptions', merchant: m, rule: 'payee' });
    expect(r).toMatchObject({ ruleCreated: true, matched: 3, pinned: 0 });
    expect(rules()).toEqual([{ kind: 'smart', base: budget.merchantBase(m), contains: null, amount: null, category: 'Subscriptions' }]);
    for (const id of ['rv-0', 'rv-1', 'rv-2']) expect((await cat(id)).category).toBe('Subscriptions');
    expect((await cat('rv-3')).category).not.toBe('Subscriptions');
  });

  it('narrowed rule (payee + amount): one rule, and the listed charge it misses is pinned', async () => {
    const m = await merchantOf('rv-0');
    const r = await budget.applyReviewChoice({ ids: ['rv-0', 'rv-1', 'rv-2'], category: 'Subscriptions', merchant: m, rule: { base: budget.merchantBase(m), amount: 9.99 } });
    expect(r).toMatchObject({ ruleCreated: true, matched: 2, pinned: 1 });
    expect(rules()).toHaveLength(1);
    const odd = await cat('rv-2');
    expect(odd.category).toBe('Subscriptions');
    expect(odd.ruleSource).toBe('manual');
    expect((await cat('rv-3')).category).not.toBe('Subscriptions'); // same amount, other payee
  });

  it('text rule reaches past the payee', async () => {
    const r = await budget.applyReviewChoice({ ids: ['rv-3'], category: 'Shopping', merchant: await merchantOf('rv-3'), rule: { contains: 'qq' } });
    expect(r).toMatchObject({ ruleCreated: true, matched: 2, pinned: 0 });
    expect((await cat('rv-4')).category).toBe('Shopping');
  });

  it('nothing ticked: no rule, only the listed charges change', async () => {
    const r = await budget.applyReviewChoice({ ids: ['rv-5'], category: 'Gifts', merchant: await merchantOf('rv-5'), rule: null });
    expect(r).toMatchObject({ ruleCreated: false, matched: 0, pinned: 1 });
    expect(rules()).toEqual([]);
    expect((await cat('rv-5')).category).toBe('Gifts');
  });

  it('a later merchant-wide choice releases the pins it covers', async () => {
    const m = await merchantOf('rv-5');
    await budget.applyReviewChoice({ ids: ['rv-5'], category: 'Gifts', merchant: m, rule: null });
    await budget.applyCategoryRule(m, 'Shopping', 'one');
    expect(pins()).toBe(0);
    expect((await cat('rv-5')).category).toBe('Shopping');
  });

  it('a pin outranks an existing broader rule that would keep the charge elsewhere', async () => {
    const m = await merchantOf('rv-0');
    await budget.applyCategoryRule(m, 'Miscellaneous', 'one'); // exact merchant rule, highest precedence
    const r = await budget.applyReviewChoice({ ids: ['rv-0'], category: 'Subscriptions', merchant: m, rule: { amount: 9.99 } });
    expect(r.pinned).toBe(1);
    expect((await cat('rv-0')).category).toBe('Subscriptions');
  });

  it('route: validates the body and refuses unknown categories without writing', async () => {
    expect((await post('/review/apply', { ids: [], category: 'Gifts' })).status).toBe(400);
    expect((await post('/review/apply', { ids: ['rv-5'], category: '' })).status).toBe(400);
    expect((await post('/review/apply', { ids: ['rv-5'], category: 'Gifts', rule: 5 })).status).toBe(400);
    expect((await post('/review/apply', { ids: ['rv-5'], category: 'No Such Category', rule: null })).status).toBe(400);
    expect(rules()).toEqual([]);
    expect(pins()).toBe(0);
    const ok = await post('/review/apply', { ids: ['rv-5'], category: 'Gifts', rule: null });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ category: 'Gifts', ruleCreated: false, pinned: 1 });
  });

  it('suggest works before a category is chosen', async () => {
    const res = await post('/rule/suggest', { merchant: await merchantOf('rv-0'), payee: 'Streamflix', amount: -9.99 });
    expect(res.status).toBe(200);
    const d = await res.json() as { conditions: { kind: string; count: number }[] };
    expect(d.conditions.find(c => c.kind === 'merchant')?.count).toBe(3);
    expect(d.conditions.find(c => c.kind === 'amount')?.count).toBe(3);
  });
});
