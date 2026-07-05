import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  rawTxnsFromSimpleFin, syncFeedTransactions, readFeedTransactions, type RawTxn,
} from './feedStore.js';

const DAY = 86400;
const NOW = 1_800_000_000; // fixed unix seconds
const WINDOW_START = NOW - 730 * DAY;

function memDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE transactions (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, account_name TEXT NOT NULL,
      source TEXT NOT NULL, posted INTEGER NOT NULL, transacted_at INTEGER,
      amount REAL NOT NULL, payee TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
      memo TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

const txn = (id: string, posted: number, over: Partial<RawTxn> = {}): RawTxn => ({
  id, posted, transactedAt: null, amount: -10, description: 'd', payee: 'p', memo: '',
  accountId: 'acct-1', accountName: 'Checking', ...over,
});

describe('syncFeedTransactions', () => {
  let db: Database.Database;
  beforeEach(() => { db = memDb(); });

  it('keeps rows that have aged out of the provider window (the durability fix)', () => {
    // Day 1: the payload still contains an old transaction near the window edge.
    const oldTxn = txn('old', WINDOW_START + DAY);
    syncFeedTransactions(db, 'simplefin', [oldTxn, txn('new', NOW - DAY)], WINDOW_START);

    // Much later: the provider window has moved past 'old', so the payload no
    // longer includes it. It must survive — that history is otherwise lost.
    const laterWindowStart = WINDOW_START + 90 * DAY;
    syncFeedTransactions(db, 'simplefin', [txn('new', NOW - DAY)], laterWindowStart);

    expect(readFeedTransactions(db).map(t => t.id)).toEqual(['old', 'new']);
  });

  it('removes in-window rows the payload no longer contains (reversed pending charges)', () => {
    syncFeedTransactions(db, 'simplefin', [txn('keep', NOW - DAY), txn('reversed', NOW - DAY)], WINDOW_START);
    syncFeedTransactions(db, 'simplefin', [txn('keep', NOW - DAY)], WINDOW_START);
    expect(readFeedTransactions(db).map(t => t.id)).toEqual(['keep']);
  });

  it('never reconciles across sources or into accounts absent from the payload', () => {
    syncFeedTransactions(db, 'plaid', [txn('plaid-1', NOW - DAY)], WINDOW_START);
    syncFeedTransactions(db, 'simplefin', [txn('sf-other-acct', NOW - DAY, { accountId: 'acct-2' })], WINDOW_START);
    // A SimpleFIN payload for acct-1 only: plaid rows and acct-2 rows untouched.
    syncFeedTransactions(db, 'simplefin', [txn('sf-1', NOW - DAY)], WINDOW_START);
    expect(readFeedTransactions(db).map(t => t.id)).toEqual(['plaid-1', 'sf-other-acct', 'sf-1']);
  });

  it('refreshes provider-amended fields in place', () => {
    syncFeedTransactions(db, 'simplefin', [txn('t', NOW - DAY, { amount: -10, payee: 'PENDING FOO' })], WINDOW_START);
    syncFeedTransactions(db, 'simplefin', [txn('t', NOW - DAY, { amount: -12.5, payee: 'FOO STORE' })], WINDOW_START);
    const [t] = readFeedTransactions(db);
    expect(t.amount).toBe(-12.5);
    expect(t.payee).toBe('FOO STORE');
  });

  it('preserves insertion order across syncs', () => {
    syncFeedTransactions(db, 'simplefin', [txn('a', NOW - 3 * DAY)], WINDOW_START);
    syncFeedTransactions(db, 'plaid', [txn('b', NOW - 5 * DAY)], WINDOW_START);
    syncFeedTransactions(db, 'simplefin', [txn('a', NOW - 3 * DAY), txn('c', NOW - DAY)], WINDOW_START);
    expect(readFeedTransactions(db).map(t => t.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('rawTxnsFromSimpleFin synthetic ids', () => {
  it('keeps the first occurrence unsuffixed and suffixes duplicates', () => {
    const txns = rawTxnsFromSimpleFin([{
      id: 'a1', name: 'Checking',
      transactions: [
        { posted: 100, amount: '-5.00' },
        { posted: 100, amount: '-5.00' },
        { id: 'real', posted: 100, amount: '-5.00' },
      ],
    }]);
    expect(txns.map(t => t.id)).toEqual(['a1-100--5.00', 'a1-100--5.00#2', 'real']);
  });
});
