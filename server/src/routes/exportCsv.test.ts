import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

/**
 * GET /api/export/{transactions,holdings,net-worth}.csv against a throwaway DB:
 * first completely empty, then with a small seeded feed, an import and history.
 * DB_PATH is set before the schema module loads (hence the dynamic imports).
 */

const TMP = mkdtempSync(path.join(tmpdir(), 'kevfin-exportcsv-'));
process.env.DB_PATH = path.join(TMP, 'exportcsv.db');

const { refreshConnection } = await import('../services/simplefin.js');
const budget = await import('../services/budget.js');
const { getDb } = await import('../db/schema.js');
const { default: express } = await import('express');
const { default: exportRoutes } = await import('./export.js');
const { txnRef } = await import('../shared/csvMapping.js');

const NOW = new Date('2026-06-23T12:00:00Z');
const unix = (iso: string) => Math.floor(Date.parse(iso + 'T12:00:00Z') / 1000);

let server: import('http').Server;
let base = '';

async function get(p: string) {
  const res = await fetch(`${base}${p}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, type: res.headers.get('content-type'), disposition: res.headers.get('content-disposition'), buf, text: buf.toString('utf8') };
}

beforeAll(async () => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  const app = express();
  app.use(express.json());
  app.use('/api/export', exportRoutes);
  await new Promise<void>(r => { server = app.listen(0, '127.0.0.1', () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/export`;
});

afterAll(() => {
  vi.useRealTimers();
  server?.close();
  rmSync(TMP, { recursive: true, force: true });
});

describe('with an empty database', () => {
  it.each([
    ['/transactions.csv', 'transactions', 'Date,Merchant,Amount,Category,Account,KevFin ID'],
    ['/holdings.csv', 'holdings', 'Symbol,Name,Account,Shares,Value,Cost basis,Asset class,Note'],
    ['/net-worth.csv', 'net-worth', 'Date,Accounts and other assets,Real estate equity,Net worth'],
  ])('%s is a header-only CSV download with a BOM and a dated filename', async (p, kind, header) => {
    const r = await get(p);
    expect(r.status).toBe(200);
    expect(r.type).toBe('text/csv; charset=utf-8');
    expect(r.disposition).toBe(`attachment; filename="kevfin-${kind}-2026-06-23.csv"`);
    expect([...r.buf.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM bytes
    expect(r.text).toBe(`﻿${header}\r\n`);
  });
});

describe('with data', () => {
  beforeAll(async () => {
    const db = getDb();
    let seq = 0;
    const tx = (date: string, amount: number, payee: string) =>
      ({ id: `ex-${seq++}`, posted: unix(date), amount: amount.toFixed(2), description: payee, payee });
    const checking = {
      org: { name: 'Chase' }, id: 'e-checking', name: 'Total Checking (1234)', currency: 'USD', balance: '5000.00',
      'balance-date': unix('2026-06-23'),
      transactions: [
        tx('2026-05-02', 3000, 'ACME PAYROLL'),
        tx('2026-05-10', -88.4, 'Café Olé'),
        tx('2026-06-01', -12, '=HYPERLINK("http://x")'),
      ],
    };
    db.prepare('INSERT INTO simplefin_connections (id, access_url) VALUES (1, ?)')
      .run('https://demo:demo@bridge.example.invalid/simplefin');
    db.prepare('INSERT OR REPLACE INTO provider_cache (key, fetched_at, payload) VALUES (?, ?, ?)')
      .run('sf_cache_1', NOW.getTime(), JSON.stringify([checking]));
    await refreshConnection(1, 'https://demo:demo@bridge.example.invalid/simplefin');
    budget.importTransactions('Date,Merchant,Amount,Account,Category\n2026-05-20,"Pool, Inc.",-180,Amex,Home Services\n');
    budget.renameCategory('Paychecks', 'Salary'); // the export shows display labels
    const snap = db.prepare('INSERT INTO net_worth_snapshots (date, accounts_total, real_estate_total, net_worth) VALUES (?, ?, ?, ?)');
    snap.run('2026-06-02', 5100.1, 300000, 305100.1);
    snap.run('2026-06-01', 5000, 300000, 305000);
  });

  it('exports every transaction oldest first, with labels, guarded text and UTF-8 accents', async () => {
    const r = await get('/transactions.csv');
    expect(r.text.slice(1).split('\r\n')).toEqual([
      'Date,Merchant,Amount,Category,Account,KevFin ID',
      `2026-05-02,ACME PAYROLL,3000,Salary,Total Checking (1234),${txnRef('ex-0')}`, // renamed label,
      `2026-05-10,Café Olé,-88.4,Miscellaneous,Total Checking (1234),${txnRef('ex-1')}`,
      `2026-05-20,"Pool, Inc.",-180,Home Services,Amex,${txnRef('imp|2026-05-20|-180.00|pool, inc.|amex')}`,
      `2026-06-01,"'=HYPERLINK(""http://x"")",-12,Miscellaneous,Total Checking (1234),${txnRef('ex-2')}`,
      '',
    ]);
  });

  it('narrows to an inclusive from / to range', async () => {
    const r = await get('/transactions.csv?from=2026-05-10&to=2026-05-20');
    expect(r.text.slice(1).split('\r\n').slice(1, -1).map(l => l.slice(0, 10))).toEqual(['2026-05-10', '2026-05-20']);
    expect((await get('/transactions.csv?from=2026-06-02')).text).toBe('﻿Date,Merchant,Amount,Category,Account,KevFin ID\r\n');
  });

  it('rejects a malformed or backwards range with a 400', async () => {
    expect((await get('/transactions.csv?from=yesterday')).status).toBe(400);
    expect((await get('/transactions.csv?to=2026-02-30')).status).toBe(400);
    const back = await get('/transactions.csv?from=2026-06-01&to=2026-05-01');
    expect(back.status).toBe(400);
    expect(JSON.parse(back.text).error).toMatch(/on or before/);
  });

  it('exports the daily net worth history oldest first', async () => {
    const r = await get('/net-worth.csv');
    expect(r.text.slice(1).split('\r\n')).toEqual([
      'Date,Accounts and other assets,Real estate equity,Net worth',
      '2026-06-01,5000,300000,305000',
      '2026-06-02,5100.1,300000,305100.1',
      '',
    ]);
  });

  it('exports holdings (none held here) without failing', async () => {
    const r = await get('/holdings.csv');
    expect(r.status).toBe(200);
    expect(r.text).toBe('﻿Symbol,Name,Account,Shares,Value,Cost basis,Asset class,Note\r\n');
  });
});
