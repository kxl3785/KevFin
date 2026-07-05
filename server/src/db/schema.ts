import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { categorize } from '../util/categorize.js';
import { runMigrations } from './migrations.js';

// DB_PATH can be overridden via env (e.g. to point at a Docker volume mount).
// Falls back to project-root-relative path so the dev workflow is unchanged.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Exported so the backup/restore service can copy and swap the underlying file.
export const DB_PATH = process.env.DB_PATH ?? path.join(__dirname, '../../../data/kevfin.db');

let db: Database.Database | undefined;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    // DELETE (rollback) journaling keeps the DB as a single self-contained file
    // (no persistent -wal/-shm), which is safe for Dropbox/cloud sync.
    db.pragma('journal_mode = DELETE');
    migrate(db);
  }
  return db;
}

// Close the connection so the file can be replaced on disk (restore). The next
// getDb() transparently reopens and re-runs the idempotent migration.
export function closeDb(): void {
  if (db) {
    db.close();
    db = undefined;
  }
}

function migrate(db: Database.Database) {
  runMigrations(db);
  perBootMaintenance(db);
}

// Housekeeping that intentionally runs on EVERY boot (not once per schema
// version) — cheap fixups whose inputs can change between runs.
function perBootMaintenance(db: Database.Database) {
  // Drop negative EDGAR rows (holdings IS NULL) on every boot: a symbol wrongly
  // marked "nothing on EDGAR" by a bad crawl (e.g. requests rejected over the
  // User-Agent contact policy) must not stick for the 7-day TTL. Negatives are
  // cheap to recompute — plain stocks resolve against the in-memory fund-ticker
  // map without any network call.
  db.exec(`DELETE FROM edgar_fund_holdings WHERE holdings IS NULL`);

  // Backfill categories for accounts still on the default (keyword rules can
  // improve between releases, so retry on every boot).
  const uncategorized = db
    .prepare(`SELECT id, name FROM accounts WHERE category = 'other'`)
    .all() as { id: string; name: string }[];
  const setCat = db.prepare(`UPDATE accounts SET category = ? WHERE id = ?`);
  for (const a of uncategorized) {
    const c = categorize(a.name);
    if (c !== 'other') setCat.run(c, a.id);
  }
}
