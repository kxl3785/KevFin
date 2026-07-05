import type Database from 'better-sqlite3';

// The durable transaction store. Provider payloads (SimpleFIN / Plaid) are
// cached for ~a day and cover a rolling 2-year window; before this table
// existed, budget history silently aged out of that window. Every read of the
// feed now syncs the cached payload into `transactions` (append/refresh within
// the provider window, never touching older rows), and consumers read from the
// table — so history accumulates for as long as the app runs.
//
// Categorization stays read-time in the budget service: it is holistic
// (transfer-pair detection, feed↔import dedup, tracked-card logic all operate
// over the whole ledger at once), so rows here are the raw normalized feed.
//
// Everything takes the db handle explicitly so the migration runner can use
// this module without an import cycle (schema → migrations → here).

type Db = Database.Database;

export type FeedSource = 'simplefin' | 'plaid';

// The provider transaction window (both providers fetch this much history).
// Reconciliation below is scoped to it: inside the window the payload is
// authoritative (pending reversals disappear), outside it rows are permanent.
export const FEED_WINDOW_DAYS = 730;

export interface RawTxn {
  id: string; posted: number; transactedAt: number | null; amount: number; description: string; payee: string; memo: string;
  accountId: string; accountName: string;
}

// The slice of a SimpleFIN /accounts payload the feed mapping needs
// (structural, so both the live service and the migration backfill can pass
// their own parsed payloads).
export interface SimpleFinFeedAccount {
  id: string;
  name: string;
  transactions?: { id?: string; posted: number; transacted_at?: number; amount: string; description?: string; payee?: string; memo?: string }[];
}

/** Map SimpleFIN payload accounts to RawTxns (payload order preserved). */
export function rawTxnsFromSimpleFin(accounts: SimpleFinFeedAccount[]): RawTxn[] {
  const out: RawTxn[] = [];
  // Occurrence counter for rows the provider sends without an id. Two identical
  // same-day charges (same account/posted/amount) used to collapse onto one
  // synthetic id; the second and later occurrences get a "#n" suffix. The
  // first occurrence keeps the unsuffixed id so existing per-id overrides
  // (amount edits) written under the old scheme still apply.
  const synthSeen = new Map<string, number>();
  const synthId = (acctId: string, posted: number, amount: string | number) => {
    const key = `${acctId}-${posted}-${amount}`;
    const n = (synthSeen.get(key) ?? 0) + 1;
    synthSeen.set(key, n);
    return n === 1 ? key : `${key}#${n}`;
  };
  for (const a of accounts) {
    for (const t of a.transactions ?? []) {
      out.push({
        id: t.id ?? synthId(a.id, t.posted, t.amount),
        posted: t.posted,
        transactedAt: t.transacted_at ?? null,
        amount: parseFloat(t.amount) || 0,
        description: t.description ?? '',
        payee: t.payee ?? '',
        memo: t.memo ?? '',
        accountId: a.id,
        accountName: a.name,
      });
    }
  }
  return out;
}

/**
 * Sync one source's current payload into the transactions table:
 *  - upsert every row (provider-amended fields refresh in place);
 *  - inside the provider window, delete rows for accounts PRESENT in the
 *    payload that the payload no longer contains (reversed pending charges) —
 *    the payload is authoritative there;
 *  - rows older than the window, or for accounts absent from this payload,
 *    are never touched. That asymmetry is the whole point of the table.
 */
export function syncFeedTransactions(db: Db, source: FeedSource, txns: RawTxn[], sinceUnix: number): void {
  const upsert = db.prepare(`
    INSERT INTO transactions (id, account_id, account_name, source, posted, transacted_at, amount, payee, description, memo)
    VALUES (@id, @accountId, @accountName, @source, @posted, @transactedAt, @amount, @payee, @description, @memo)
    ON CONFLICT(id) DO UPDATE SET
      account_id    = excluded.account_id,
      account_name  = excluded.account_name,
      posted        = excluded.posted,
      transacted_at = excluded.transacted_at,
      amount        = excluded.amount,
      payee         = excluded.payee,
      description   = excluded.description,
      memo          = excluded.memo,
      updated_at    = datetime('now')
  `);
  const inWindowIds = db.prepare(
    `SELECT id FROM transactions WHERE source = ? AND account_id = ? AND posted >= ?`
  );
  const del = db.prepare('DELETE FROM transactions WHERE id = ?');

  db.transaction(() => {
    const payloadIds = new Set(txns.map(t => t.id));
    const accountIds = new Set(txns.map(t => t.accountId));
    for (const t of txns) upsert.run({ ...t, source });
    for (const acct of accountIds) {
      for (const row of inWindowIds.all(source, acct, sinceUnix) as { id: string }[]) {
        if (!payloadIds.has(row.id)) del.run(row.id);
      }
    }
  })();
}

/**
 * The full durable feed, in insertion order (rowid). Insertion order matches
 * the old in-memory [...simplefin, ...plaid] concatenation on first sync, and
 * downstream consumers that care about ordering sort explicitly.
 */
export function readFeedTransactions(db: Db): RawTxn[] {
  const rows = db.prepare(`
    SELECT id, account_id, account_name, posted, transacted_at, amount, payee, description, memo
    FROM transactions ORDER BY rowid
  `).all() as {
    id: string; account_id: string; account_name: string; posted: number;
    transacted_at: number | null; amount: number; payee: string; description: string; memo: string;
  }[];
  return rows.map(r => ({
    id: r.id, posted: r.posted, transactedAt: r.transacted_at, amount: r.amount,
    description: r.description, payee: r.payee, memo: r.memo,
    accountId: r.account_id, accountName: r.account_name,
  }));
}
