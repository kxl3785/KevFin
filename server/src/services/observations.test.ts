import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { recordRealObservation, recordEstimatedObservation, getObservations } from './observations.js';

function memDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE balance_observations (
      account_id TEXT NOT NULL, date TEXT NOT NULL, balance REAL NOT NULL,
      estimated INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (account_id, date)
    );
  `);
  return db;
}

describe('balance observations', () => {
  let db: Database.Database;
  beforeEach(() => { db = memDb(); });

  it('an estimate never overwrites a real observation', () => {
    recordRealObservation(db, 'a', '2026-01-01', 100);
    recordEstimatedObservation(db, 'a', '2026-01-01', 95);
    expect(getObservations(db, 'a')).toEqual([{ date: '2026-01-01', balance: 100, estimated: false }]);
  });

  it('a real observation replaces (and demotes) an earlier estimate for the same day', () => {
    recordEstimatedObservation(db, 'a', '2026-01-01', 95);
    recordRealObservation(db, 'a', '2026-01-01', 100);
    expect(getObservations(db, 'a')).toEqual([{ date: '2026-01-01', balance: 100, estimated: false }]);
  });

  it('re-running the backfill refreshes stale estimates in place', () => {
    recordEstimatedObservation(db, 'a', '2026-01-01', 95);
    recordEstimatedObservation(db, 'a', '2026-01-01', 97);
    expect(getObservations(db, 'a')).toEqual([{ date: '2026-01-01', balance: 97, estimated: true }]);
  });

  it('a newer sync updates the same-day real observation', () => {
    recordRealObservation(db, 'a', '2026-01-01', 100);
    recordRealObservation(db, 'a', '2026-01-01', 102.5);
    expect(getObservations(db, 'a')).toEqual([{ date: '2026-01-01', balance: 102.5, estimated: false }]);
  });
});
