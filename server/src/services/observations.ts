import type Database from 'better-sqlite3';

// Append-only per-asset balance history. Every sync and daily snapshot records
// what each account/property/manual asset was actually worth on a given day
// ("real" observations); the backfill fills dates before real data exists with
// reconstructed values ("estimated"). Real always wins: an estimate can never
// overwrite a real observation, while re-running the backfill refreshes stale
// estimates in place. net_worth_snapshots stays the (derived) chart source for
// now — this table is the durable per-asset record that outlives it.
//
// account_id is accounts.id for provider accounts, 'property:<id>' for a
// property's equity (value − mortgage), 'manual:<id>' for manual assets.

type Db = Database.Database;

export function recordRealObservation(db: Db, accountId: string, date: string, balance: number): void {
  db.prepare(`
    INSERT INTO balance_observations (account_id, date, balance, estimated)
    VALUES (?, ?, ?, 0)
    ON CONFLICT(account_id, date) DO UPDATE SET balance = excluded.balance, estimated = 0
  `).run(accountId, date, balance);
}

export function recordEstimatedObservation(db: Db, accountId: string, date: string, balance: number): void {
  db.prepare(`
    INSERT INTO balance_observations (account_id, date, balance, estimated)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(account_id, date) DO UPDATE SET balance = excluded.balance
      WHERE balance_observations.estimated = 1
  `).run(accountId, date, balance);
}

export function getObservations(db: Db, accountId: string): { date: string; balance: number; estimated: boolean }[] {
  const rows = db.prepare(
    'SELECT date, balance, estimated FROM balance_observations WHERE account_id = ? ORDER BY date'
  ).all(accountId) as { date: string; balance: number; estimated: number }[];
  return rows.map(r => ({ date: r.date, balance: r.balance, estimated: !!r.estimated }));
}
