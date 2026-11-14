import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

/**
 * DB-backed tests for the fixes the AI assistant proposes and the user applies
 * (services/assistantActions.ts + the /api/assistant/action routes). Same
 * harness as budgetFixes.test.ts: a throwaway DB, a pinned clock and a seeded
 * SimpleFIN cache. Every apply path is exercised against real rows, along with
 * the refusals that keep model output from reaching the data unchecked.
 */

const TMP = mkdtempSync(path.join(tmpdir(), 'kevfin-actions-'));
process.env.DB_PATH = path.join(TMP, 'actions.db');

const { refreshConnection } = await import('./simplefin.js');
const budget = await import('./budget.js');
const { getDb } = await import('../db/schema.js');
const { previewAction, applyAction, ActionError } = await import('./assistantActions.js');
const { writeReportFile, REPORT_FILE } = await import('./assistant.js');
const { getReportWindow } = await import('../util/reportWindow.js');
const { default: express } = await import('express');
const { default: assistantRouter } = await import('../routes/assistant.js');

const NOW = new Date('2026-06-23T12:00:00Z');
const unix = (iso: string) => Math.floor(Date.parse(iso + 'T12:00:00Z') / 1000);

let assetId = 0;
let server: import('http').Server;
let base = '';

async function seed() {
  const db = getDb();
  let seq = 0;
  const tx = (date: string, amount: number, payee: string) =>
    ({ id: `ax-${seq++}`, posted: unix(date), amount: amount.toFixed(2), description: payee, payee });
  const checking = {
    org: { name: 'Chase' }, id: 'a-checking', name: 'Total Checking (1234)', currency: 'USD', balance: '5000.00',
    'balance-date': unix('2026-06-23'),
    transactions: [
      tx('2026-05-02', 3000, 'ACME PAYROLL'),
      tx('2026-05-10', -100, 'QQ MARKET'),
      tx('2026-05-17', -80, 'QQ MARKET'),
      tx('2026-05-18', -12.34, 'QQ CAFE'),
      tx('2026-05-20', 250, 'QQ CASHOUT'),
    ],
  };
  db.prepare('INSERT INTO simplefin_connections (id, access_url) VALUES (1, ?)')
    .run('https://demo:demo@bridge.example.invalid/simplefin');
  db.prepare('INSERT OR REPLACE INTO provider_cache (key, fetched_at, payload) VALUES (?, ?, ?)')
    .run('sf_cache_1', NOW.getTime(), JSON.stringify([checking]));
  await refreshConnection(1, 'https://demo:demo@bridge.example.invalid/simplefin');
  assetId = Number(db.prepare(`INSERT INTO manual_assets (name, category, value) VALUES ('Car', 'other', 18000)`).run().lastInsertRowid);
}

const txns = () => budget.getCategorizedTransactions();
const byPayee = async (payee: string) => (await txns()).filter(t => t.payee === payee);
const count = (table: string) => (getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const post = (route: string, body: unknown) =>
  fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

beforeAll(async () => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  await seed();
  const app = express();
  app.use(express.json());
  app.use('/api/assistant', assistantRouter);
  await new Promise<void>(r => { server = app.listen(0, '127.0.0.1', () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/assistant`;
});

afterAll(() => {
  vi.useRealTimers();
  server?.close();
  rmSync(TMP, { recursive: true, force: true });
});

describe('recategorize_merchant', () => {
  const action = { type: 'recategorize_merchant', merchant: 'QQ Market', category: 'Groceries', scope: 'merchant' };

  it('previews the reach and the before/after categories without changing anything', async () => {
    const rules = count('rules');
    const before = (await byPayee('QQ MARKET')).map(t => t.category);
    const p = await previewAction(action);
    expect(p.title).toBe('Move 2 transactions from “qq market” to Groceries');
    expect(p.before).toBe([...new Set(before)].join(', '));
    expect(p.after).toBe('Groceries');
    expect(p.noop).toBe(false);
    expect(count('rules')).toBe(rules);
    expect((await byPayee('QQ MARKET')).map(t => t.category)).toEqual(before);
  });

  it('applies through the merchant rule the Budget screen uses', async () => {
    const r = await applyAction(action);
    expect(r).toEqual({ done: 'Moved 2 transactions from “qq market” to Groceries.', changed: true });
    expect((await byPayee('QQ MARKET')).map(t => t.category)).toEqual(['Groceries', 'Groceries']);
    expect(getDb().prepare(`SELECT category FROM rules WHERE kind = 'merchant' AND merchant = 'qq market'`).get())
      .toEqual({ category: 'Groceries' });
  });

  it('is a no-op the second time', async () => {
    expect((await previewAction(action)).noop).toBe(true);
    const rules = count('rules');
    expect(await applyAction(action)).toEqual({ done: 'Already in place — nothing needed changing.', changed: false });
    expect(count('rules')).toBe(rules);
  });

  it('refuses a merchant with no transactions', async () => {
    await expect(applyAction({ ...action, merchant: 'no such shop' })).rejects.toThrow(/no transactions from a merchant/);
  });

  it('refuses a category that does not already exist, and writes no rule', async () => {
    const rules = count('rules');
    const cats = count('budget_categories');
    const was = (await byPayee('QQ CAFE'))[0].category;
    await expect(applyAction({ ...action, merchant: 'qq cafe', category: 'Totally New Category' })).rejects.toThrow(/not one of your budget categories/);
    expect(count('rules')).toBe(rules);
    expect(count('budget_categories')).toBe(cats);
    expect((await byPayee('QQ CAFE'))[0].category).toBe(was); // not quietly filed under Miscellaneous
  });
});

describe('set_sign_flip', () => {
  const action = { type: 'set_sign_flip', merchant: 'qq cashout', flipped: true };

  it('reverses the sign for the merchant, then is a no-op, then undoes', async () => {
    expect((await byPayee('QQ CASHOUT'))[0].amount).toBe(250);
    const p = await previewAction(action);
    expect(p.title).toBe('Reverse income/expense for 1 transaction from “qq cashout”');
    expect(p.noop).toBe(false);

    expect((await applyAction(action)).changed).toBe(true);
    expect(budget.getSignFlipMatcher()('qq cashout')).toBe(true);
    expect((await byPayee('QQ CASHOUT'))[0].amount).toBe(-250);
    expect((await applyAction(action)).changed).toBe(false);

    expect((await applyAction({ ...action, flipped: false })).changed).toBe(true);
    expect(budget.getSignFlipMatcher()('qq cashout')).toBe(false);
    expect((await byPayee('QQ CASHOUT'))[0].amount).toBe(250);
  });

  it('refuses an unknown merchant', async () => {
    await expect(previewAction({ ...action, merchant: 'nobody' })).rejects.toBeInstanceOf(ActionError);
  });
});

describe('set_transaction_amount', () => {
  it('corrects one amount, keeping its direction', async () => {
    const cafe = (await byPayee('QQ CAFE'))[0];
    expect(cafe.amount).toBeCloseTo(-12.34, 2);
    const action = { type: 'set_transaction_amount', id: cafe.id, amount: 21.5 };

    const p = await previewAction(action);
    expect(p.title).toBe('Change the amount of “QQ CAFE” on 2026-05-18');
    expect(p.before).toBe('$12.34');
    expect(p.after).toBe('$21.50');

    expect(await applyAction(action)).toEqual({ done: 'Changed “QQ CAFE” on 2026-05-18 from $12.34 to $21.50.', changed: true });
    const after = (await byPayee('QQ CAFE'))[0];
    expect(after.amount).toBeCloseTo(-21.5, 2);
    expect(after.amountEdited).toBe(true);
    expect((await applyAction(action)).changed).toBe(false);
  });

  it('refuses an id that is not a transaction, and out-of-range amounts', async () => {
    const overrides = count('txn_amount_overrides');
    await expect(applyAction({ type: 'set_transaction_amount', id: 'made-up-id', amount: 5 })).rejects.toThrow(/not in your data/);
    const cafe = (await byPayee('QQ CAFE'))[0];
    for (const amount of [0, -5, 1e12, Number.NaN, '5']) {
      await expect(applyAction({ type: 'set_transaction_amount', id: cafe.id, amount })).rejects.toBeInstanceOf(ActionError);
    }
    expect(count('txn_amount_overrides')).toBe(overrides);
  });
});

describe('manual asset edits', () => {
  const row = () => getDb().prepare('SELECT name, category, value FROM manual_assets WHERE id = ?').get(assetId);

  it('changes the value', async () => {
    const action = { type: 'set_manual_asset_value', id: assetId, value: 16250 };
    const p = await previewAction(action);
    expect(p).toMatchObject({ title: 'Change the value of “Car”', before: '$18,000.00', after: '$16,250.00', noop: false });
    expect((await applyAction(action)).done).toBe('Changed “Car” from $18,000.00 to $16,250.00.');
    expect(row()).toEqual({ name: 'Car', category: 'other', value: 16250 });
    expect((await applyAction(action)).changed).toBe(false);
  });

  it('changes the category', async () => {
    const action = { type: 'set_manual_asset_category', id: assetId, category: 'brokerage' };
    expect(await previewAction(action)).toMatchObject({ before: 'Other', after: 'Investments', noop: false });
    expect((await applyAction(action)).changed).toBe(true);
    expect(row()).toEqual({ name: 'Car', category: 'brokerage', value: 16250 });
  });

  it('refuses an asset that does not exist, or a made-up category', async () => {
    await expect(applyAction({ type: 'set_manual_asset_value', id: 99999, value: 1 })).rejects.toThrow(/not in your data/);
    await expect(applyAction({ type: 'set_manual_asset_category', id: assetId, category: 'yacht' })).rejects.toBeInstanceOf(ActionError);
    expect(row()).toEqual({ name: 'Car', category: 'brokerage', value: 16250 });
  });
});

describe('linked account edits', () => {
  const row = () => getDb().prepare('SELECT category, hidden FROM accounts WHERE id = ?').get('a-checking') as { category: string; hidden: number };

  it('changes the category', async () => {
    const start = row().category;
    const target = start === 'brokerage' ? 'banking' : 'brokerage';
    const action = { type: 'set_account_category', id: 'a-checking', category: target };
    expect((await previewAction(action)).title).toBe('Change the category of Total Checking (1234) (Chase)');
    expect((await applyAction(action)).changed).toBe(true);
    expect(row().category).toBe(target);
    expect((await applyAction(action)).changed).toBe(false);
  });

  it('hides and shows the account, re-snapshotting net worth', async () => {
    const snapshot = () => (getDb().prepare('SELECT accounts_total FROM net_worth_snapshots ORDER BY date DESC LIMIT 1').get() as { accounts_total: number }).accounts_total;
    const hide = { type: 'set_account_hidden', id: 'a-checking', hidden: true };
    const p = await previewAction(hide);
    expect(p).toMatchObject({ title: 'Hide Total Checking (1234) (Chase)', before: 'Shown — counted in net worth', noop: false });

    expect((await applyAction(hide)).changed).toBe(true);
    expect(row().hidden).toBe(1);
    const hiddenTotal = snapshot();
    expect((await applyAction({ ...hide, hidden: false })).changed).toBe(true);
    expect(row().hidden).toBe(0);
    expect(snapshot() - hiddenTotal).toBeCloseTo(5000, 2); // the checking balance is back in
  });

  it('refuses an account that does not exist', async () => {
    await expect(applyAction({ type: 'set_account_hidden', id: 'not-an-account', hidden: true })).rejects.toThrow(/not in your data/);
    await expect(applyAction({ type: 'set_account_category', id: 'not-an-account', category: 'banking' })).rejects.toThrow(/not in your data/);
  });
});

describe('untrusted input', () => {
  it('refuses unknown action types and malformed bodies before touching the database', async () => {
    const before = { accounts: count('accounts'), rules: count('rules'), assets: count('manual_assets'), txns: count('transactions') };
    for (const input of [
      undefined, null, 'hide everything', [],
      { type: 'delete_account', id: 'a-checking' },
      { type: 'delete_transaction', id: 'ax-1' },
      { type: 'set_key', name: 'PLAID_SECRET', value: 'x' },
      { type: 'set_account_hidden', id: 'a-checking', hidden: 'yes' },
      { type: 'recategorize_merchant', merchant: 'qq market' },
    ]) {
      await expect(applyAction(input)).rejects.toBeInstanceOf(ActionError);
      await expect(previewAction(input)).rejects.toBeInstanceOf(ActionError);
    }
    expect({ accounts: count('accounts'), rules: count('rules'), assets: count('manual_assets'), txns: count('transactions') }).toEqual(before);
  });

  it('does not handle forecast inputs (those live in the browser)', async () => {
    const action = { type: 'set_forecast_assumption', field: 'investReturn', value: 0.06 };
    await expect(previewAction(action)).rejects.toThrow(/changed in the app itself/);
    await expect(applyAction(action)).rejects.toThrow(/changed in the app itself/);
  });

  it('ignores extra fields riding along with a valid action', async () => {
    const r = await applyAction({ type: 'set_manual_asset_value', id: assetId, value: 16000, name: 'Renamed', category: 'credit', hidden: true });
    expect(r.changed).toBe(true);
    expect(getDb().prepare('SELECT name, category, value FROM manual_assets WHERE id = ?').get(assetId))
      .toEqual({ name: 'Car', category: 'brokerage', value: 16000 });
  });
});

describe('the /api/assistant/action routes', () => {
  it('preview returns the server-built description', async () => {
    const res = await post('/action/preview', { action: { type: 'set_manual_asset_value', id: assetId, value: 15000 } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ preview: expect.objectContaining({ title: 'Change the value of “Car”', before: '$16,000.00', after: '$15,000.00', noop: false }) });
    // Preview changed nothing.
    expect((getDb().prepare('SELECT value FROM manual_assets WHERE id = ?').get(assetId) as { value: number }).value).toBe(16000);
  });

  it('apply performs exactly one action and says what it did', async () => {
    const res = await post('/action/apply', { action: { type: 'set_manual_asset_value', id: assetId, value: 15000 } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ done: 'Changed “Car” from $16,000.00 to $15,000.00.', changed: true });
  });

  it('answers 422 with a readable reason for anything invalid', async () => {
    for (const body of [
      {},
      { action: { type: 'drop_tables' } },
      { action: { type: 'set_manual_asset_value', id: 424242, value: 1 } },
      { actions: [{ type: 'set_manual_asset_value', id: assetId, value: 1 }] }, // a batch is not a thing
    ]) {
      for (const route of ['/action/preview', '/action/apply']) {
        const res = await post(route, body);
        expect(res.status).toBe(422);
        expect((await res.json()).error).toEqual(expect.any(String));
      }
    }
    expect((getDb().prepare('SELECT value FROM manual_assets WHERE id = ?').get(assetId) as { value: number }).value).toBe(15000);
  });
});

describe('the report file for a report-aware chat', () => {
  it('is not written when no report has been generated', () => {
    const dir = mkdtempSync(path.join(TMP, 'chat-'));
    expect(writeReportFile(dir)).toBeNull();
    expect(existsSync(path.join(dir, REPORT_FILE))).toBe(false);
  });

  it('holds the stored report as text, without regenerating it', () => {
    const { quarterLabel } = getReportWindow(new Date());
    getDb().prepare('INSERT INTO report_cache (quarter_label, html, generated_at) VALUES (?, ?, ?)').run(
      quarterLabel,
      '<html><head><style>p{}</style></head><body><h1>Quarterly report</h1><p>Net worth rose $1,250.</p>' +
        '<svg role="img" aria-label="Cash 20%, stocks 80%"><circle/></svg><script>window.print()</script></body></html>',
      '2026-06-20T08:00:00.000Z',
    );
    const dir = mkdtempSync(path.join(TMP, 'chat-'));
    const file = writeReportFile(dir);
    expect(file?.name).toBe(REPORT_FILE);
    expect(file?.desc).toContain(quarterLabel);
    expect(file?.desc).toContain('generated 2026-06-20');
    expect(readFileSync(path.join(dir, REPORT_FILE), 'utf8')).toBe('Quarterly report\n\nNet worth rose $1,250.\n\n[Chart: Cash 20%, stocks 80%]');
    // Still exactly the one stored copy.
    expect(count('report_cache')).toBe(1);
  });
});
