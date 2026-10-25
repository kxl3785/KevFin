import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

/**
 * Rules review: attribution counts, shadow detection, descriptions and the
 * PATCH/DELETE routes. The pure core (buildRulesReview) is exercised with
 * synthetic rows; the DB-backed half seeds a throwaway SimpleFIN cache like
 * budgetFixes.test.ts.
 */

const TMP = mkdtempSync(path.join(tmpdir(), 'kevfin-rules-'));
process.env.DB_PATH = path.join(TMP, 'rules.db');

const { refreshConnection } = await import('./simplefin.js');
const budget = await import('./budget.js');
const review = await import('./rulesReview.js');
const { getDb } = await import('../db/schema.js');
const { default: express } = await import('express');
const { default: rulesRouter } = await import('../routes/rules.js');

const NOW = new Date('2026-06-23T12:00:00Z');
const unix = (iso: string) => Math.floor(Date.parse(iso + 'T12:00:00Z') / 1000);

const lab = { label: (c: string) => c, canon: (c: string) => c, emoji: () => undefined };
type RuleRow = import('./rulesReview.js').RuleRow;
type Txn = import('./rulesReview.js').RuleReviewTxn;
let rid = 0;
const row = (o: Partial<RuleRow> & { kind: string }): RuleRow =>
  ({ id: ++rid, merchant: null, base: null, contains: null, amount: null, category: 'Groceries', created_at: '2026-01-01 00:00:00', ...o });
const tx = (o: Partial<Txn> & { id: string }): Txn =>
  ({ date: '2026-05-01', amount: -10, payee: 'X', description: 'X', account: 'Chk', merchant: 'x', category: 'Miscellaneous', ruleId: null, ruleSource: 'auto', ...o });

describe('describeRule', () => {
  it('reads each kind in plain English', () => {
    expect(review.describeRule({ kind: 'merchant', merchant: 'amazon mktp', base: null, contains: null, amount: null })).toBe('Merchant is “amazon mktp”');
    expect(review.describeRule({ kind: 'base', merchant: null, base: 'shell oil', contains: null, amount: null })).toBe('Merchants like “shell oil”');
    expect(review.describeRule({ kind: 'smart', merchant: null, base: 'x', contains: 'parking', amount: 12 }))
      .toBe('Merchant like “x” · text contains “parking” · amount $12.00');
    expect(review.describeRule({ kind: 'smart', merchant: null, base: null, contains: 'parking', amount: 1234.5 }))
      .toBe('Text contains “parking” · amount $1,234.50');
    expect(review.describeRule({ kind: 'sign', merchant: 'bilt housing', base: null, contains: null, amount: null })).toBe('Reverse the sign of “bilt housing”');
    expect(review.describeRule({ kind: 'sign_base', merchant: null, base: 'bilt housing', contains: null, amount: null })).toBe('Reverse the sign of merchants like “bilt housing”');
  });
});

describe('buildRulesReview (pure)', () => {
  const merchantRule = row({ kind: 'merchant', merchant: 'shell oil 12', category: 'Gas' });
  const baseRule = row({ kind: 'base', base: 'shell oil', category: 'Dining' });
  const smartRule = row({ kind: 'smart', contains: 'parking', category: 'Groceries' });
  const deadSmart = row({ kind: 'smart', contains: 'zzz-nothing', category: 'Groceries' });
  const sign = row({ kind: 'sign', merchant: 'bilt', category: null });
  const rows = [merchantRule, baseRule, smartRule, deadSmart, sign];

  const txns: Txn[] = [
    tx({ id: 'a', merchant: 'shell oil 12', payee: 'Shell Oil 12', category: 'Gas', amount: -40, date: '2026-05-03', ruleId: merchantRule.id, ruleSource: 'merchant' }),
    tx({ id: 'b', merchant: 'shell oil 99', payee: 'Shell Oil 99', category: 'Dining', amount: -30, date: '2026-05-09', ruleId: baseRule.id, ruleSource: 'base' }),
    // matches the smart rule's text AND the merchant rule: merchant rule wins -> smart shadowed
    tx({ id: 'c', merchant: 'shell oil 12', payee: 'Shell Oil 12', description: 'Shell parking', category: 'Gas', amount: -5.25, date: '2026-05-10', ruleId: merchantRule.id, ruleSource: 'merchant' }),
    tx({ id: 'd', merchant: 'city garage', payee: 'City Garage', description: 'Downtown parking', category: 'Groceries', amount: -8, date: '2026-05-11', ruleId: smartRule.id, ruleSource: 'smart' }),
    tx({ id: 'e', merchant: 'trader joes', payee: 'Trader Joes', category: 'Groceries', amount: -60, date: '2026-05-12' }),
    tx({ id: 'f', merchant: 'trader joes', payee: 'Trader Joes', category: 'Groceries', amount: -20, date: '2026-05-20' }),
  ];
  // Every rule matching each transaction, highest precedence first (as the categorizer reports it).
  const matches = new Map<string, number[]>([
    ['a', [merchantRule.id, baseRule.id]], ['b', [baseRule.id]],
    ['c', [merchantRule.id, smartRule.id, baseRule.id]], ['d', [smartRule.id]],
  ]);

  it('tallies decided and shadowed transactions per rule', () => {
    const r = review.buildRulesReview(txns, rows, lab, matches);
    const by = (id: number) => r.rules.find(x => x.id === id)!;
    const m = by(merchantRule.id);
    expect(m.matched).toBe(2);
    expect(m.total).toBe(45.25);
    expect(m.lastMatched).toBe('2026-05-10');
    expect(m.samples.map(s => s.date)).toEqual(['2026-05-10', '2026-05-03']);
    // The base rule matches a, b and c but only decides b.
    expect([by(baseRule.id).matched, by(baseRule.id).shadowed]).toEqual([1, 2]);
    // The smart rule decides d; c went to the merchant rule.
    expect([by(smartRule.id).matched, by(smartRule.id).shadowed]).toEqual([1, 1]);
    // A rule matching nothing is neither matched nor shadowed.
    const dead = by(deadSmart.id);
    expect([dead.matched, dead.shadowed, dead.total, dead.lastMatched]).toEqual([0, 0, 0, null]);
    expect(r.auto).toEqual([{ merchant: 'trader joes', payee: 'Trader Joes', category: 'Groceries', count: 2, total: 80, lastDate: '2026-05-20' }]);
    expect(r.signRules).toEqual([{ id: sign.id, kind: 'sign', description: 'Reverse the sign of “bilt”' }]);
    // Precedence order: merchant, then smart, then base.
    expect(r.rules.map(x => x.kind)).toEqual(['merchant', 'smart', 'smart', 'base']);
  });

  it('does not count import-decided rows as auto, matched or shadowed', () => {
    const imp = tx({ id: 'imp|1', merchant: 'shell oil 12', category: 'Groceries', ruleSource: 'import' });
    const r = review.buildRulesReview([imp], rows, lab, new Map([['imp|1', [merchantRule.id]]]));
    expect(r.auto).toEqual([]);
    expect(r.rules.every(x => x.matched === 0 && x.shadowed === 0)).toBe(true);
  });

  it('caps the auto list at 200 merchants, most frequent first', () => {
    const many = Array.from({ length: 250 }, (_, i) => tx({ id: `m${i}`, merchant: `shop ${i}` }));
    many.push(tx({ id: 'm-extra', merchant: 'shop 7' }));
    const r = review.buildRulesReview(many, [], lab, new Map());
    expect(r.auto).toHaveLength(200);
    expect(r.auto[0].merchant).toBe('shop 7');
    expect(r.auto[0].count).toBe(2);
  });
});

async function seed() {
  const db = getDb();
  let seq = 0;
  const t = (date: string, amount: number, payee: string) =>
    ({ id: `rr-${seq++}`, posted: unix(date), amount: amount.toFixed(2), description: payee, payee });
  const checking = {
    org: { name: 'Chase' }, id: 'r-checking', name: 'Total Checking (1234)', currency: 'USD', balance: '5000.00',
    'balance-date': unix('2026-06-23'),
    transactions: [
      t('2026-05-02', -20, 'ZZ MARKET #12'),
      t('2026-05-09', -30, 'ZZ MARKET #99'),
      t('2026-05-11', -15, 'ZZ MARKET #12'),
      t('2026-05-12', -12, 'QQ LOT PARKING'),
      t('2026-05-14', -45, 'YY MYSTERY SHOP'),
      t('2026-05-15', -45, 'YY MYSTERY SHOP'),
    ],
  };
  db.prepare('INSERT INTO simplefin_connections (id, access_url) VALUES (1, ?)')
    .run('https://demo:demo@bridge.example.invalid/simplefin');
  db.prepare('INSERT OR REPLACE INTO provider_cache (key, fetched_at, payload) VALUES (?, ?, ?)')
    .run('sf_cache_1', NOW.getTime(), JSON.stringify([checking]));
  await refreshConnection(1, 'https://demo:demo@bridge.example.invalid/simplefin');

  await budget.applyCategoryRule('zz market #12', 'Groceries', 'all'); // exact + base 'zz market'
  await budget.applySmartRules([{ base: 'zz market', contains: 'market', category: 'Restaurants & Bars' }]); // outranked by the exact rule for #12, wins for #99
  await budget.applySmartRules([{ contains: 'parking', category: 'Gas' }]);
}

let server: import('http').Server;
let api = '';
const send = (method: string, p: string, body?: unknown) =>
  fetch(`${api}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

beforeAll(async () => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  await seed();
  const app = express();
  app.use(express.json());
  app.use('/api/budget/rules', rulesRouter);
  await new Promise<void>(r => { server = app.listen(0, '127.0.0.1', () => r()); });
  api = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/budget/rules`;
});

afterAll(() => {
  vi.useRealTimers();
  server?.close();
  rmSync(TMP, { recursive: true, force: true });
});

describe('GET /api/budget/rules (against the real categorizer)', () => {
  it('reports counts, shadowing and the auto-categorized merchants', async () => {
    const r = await (await send('GET', '/')).json() as import('./rulesReview.js').RulesReview;
    expect(r.precedence).toHaveLength(4);
    const byDesc = (d: string) => r.rules.find(x => x.description === d)!;
    const exact = byDesc('Merchant is “zz market #12”');
    expect(exact.category).toBe('Groceries');
    expect(exact.matched).toBe(2);
    expect(exact.total).toBe(35);
    // The smart rule matches all three ZZ MARKET rows; it decides #99 and loses the two #12 rows.
    const smart = byDesc('Merchant like “zz market” · text contains “market”');
    expect(smart.matched).toBe(1);
    expect(smart.shadowed).toBe(2);
    // The base rule matches the same three rows but is always outranked.
    const baseRule = byDesc('Merchants like “zz market”');
    expect(baseRule.matched).toBe(0);
    expect(baseRule.shadowed).toBe(3);
    expect(byDesc('Text contains “parking”').matched).toBe(1);
    // Only the merchant with no rule shows up as auto-categorized.
    expect(r.auto.map(a => [a.merchant, a.count, a.total])).toEqual([['yy mystery shop', 2, 90]]);
  });
});

describe('PATCH / DELETE /api/budget/rules/:id', () => {
  const rules = () => getDb().prepare('SELECT id, kind, category FROM rules').all() as { id: number; kind: string; category: string | null }[];

  it('changes a rule category and rejects bad input', async () => {
    const smart = rules().find(r => r.kind === 'smart')!;
    expect((await send('PATCH', `/${smart.id}`, { category: 'Restaurants & Bars' })).status).toBe(200);
    expect(rules().find(r => r.id === smart.id)!.category).toBe('Restaurants & Bars');
    expect((await send('PATCH', `/${smart.id}`, { category: 'Not A Category' })).status).toBe(400);
    expect((await send('PATCH', `/${smart.id}`, {})).status).toBe(400);
    expect((await send('PATCH', '/abc', { category: 'Restaurants & Bars' })).status).toBe(400);
    expect((await send('PATCH', '/1.5', { category: 'Restaurants & Bars' })).status).toBe(400);
    expect((await send('PATCH', '/99999', { category: 'Restaurants & Bars' })).status).toBe(404);
    expect(rules().find(r => r.id === smart.id)!.category).toBe('Restaurants & Bars');
  });

  it('refuses to retarget a sign rule but deletes any kind', async () => {
    await budget.setSignFlip('qq lot parking', true);
    const sign = rules().find(r => r.kind === 'sign' || r.kind === 'sign_base')!;
    expect((await send('PATCH', `/${sign.id}`, { category: 'Restaurants & Bars' })).status).toBe(400);
    const r = await (await send('GET', '/')).json() as import('./rulesReview.js').RulesReview;
    expect(r.signRules.map(s => s.id)).toContain(sign.id);
    expect((await send('DELETE', `/${sign.id}`)).status).toBe(200);
    expect(rules().some(x => x.id === sign.id)).toBe(false);
    expect((await send('DELETE', `/${sign.id}`)).status).toBe(404);
    expect((await send('DELETE', '/nope')).status).toBe(400);
  });
});

describe('ruleId / ruleSource on categorized transactions', () => {
  it('records which rule decided each category', async () => {
    const txns = await budget.getCategorizedTransactions();
    const byPayee = (p: string) => txns.filter(t => t.payee.toUpperCase().startsWith(p));
    const rules = getDb().prepare('SELECT id, kind, merchant, contains FROM rules').all() as { id: number; kind: string; merchant: string | null; contains: string | null }[];
    for (const t of byPayee('ZZ MARKET #12')) expect([t.ruleSource, t.ruleId]).toEqual(['merchant', rules.find(r => r.kind === 'merchant')!.id]);
    for (const t of byPayee('ZZ MARKET #99')) expect(t.ruleSource).toBe('smart');
    for (const t of byPayee('QQ LOT')) expect([t.ruleSource, t.ruleId]).toEqual(['smart', rules.find(r => r.contains === 'parking')!.id]);
    for (const t of byPayee('YY MYSTERY')) expect([t.ruleSource, t.ruleId]).toEqual(['auto', null]);
  });
});
