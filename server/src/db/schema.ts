import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { categorize } from '../util/categorize.js';

// DB_PATH can be overridden via env (e.g. to point at a Docker volume mount).
// Falls back to project-root-relative path so the dev workflow is unchanged.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH ?? path.join(__dirname, '../../../data/kevfin.db');

let db: Database.Database;

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

function migrate(db: Database.Database) {
  // One-time cleanup of the original Plaid-only accounts table. It is identified
  // by having `plaid_item_id` but NOT the `source` column that the current
  // (SimpleFIN + Plaid hybrid) schema adds. Never drop the current table —
  // doing so wipes account data on every restart.
  const cols = (db.prepare(`SELECT name FROM pragma_table_info('accounts')`).all() as { name: string }[])
    .map(c => c.name);
  const isLegacyAccounts = cols.includes('plaid_item_id') && !cols.includes('source');
  if (isLegacyAccounts) {
    db.exec(`DROP TABLE IF EXISTS accounts;`);
  }

  // Legacy Plaid items table used `id` as PK; the current one uses `item_id`.
  const piCols = (db.prepare(`SELECT name FROM pragma_table_info('plaid_items')`).all() as { name: string }[])
    .map(c => c.name);
  if (piCols.length > 0 && !piCols.includes('item_id')) {
    db.exec(`DROP TABLE IF EXISTS plaid_items;`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS simplefin_connections (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      access_url  TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS plaid_items (
      item_id          TEXT PRIMARY KEY,
      access_token     TEXT NOT NULL,
      institution_name TEXT NOT NULL,
      created_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id            TEXT PRIMARY KEY,            -- provider account id
      source        TEXT NOT NULL DEFAULT 'simplefin',  -- 'simplefin' | 'plaid'
      connection_id INTEGER,                     -- simplefin_connections.id (simplefin)
      plaid_item_id TEXT,                        -- plaid_items.item_id (plaid)
      org_name      TEXT NOT NULL,              -- institution, e.g. "Fidelity"
      name          TEXT NOT NULL,              -- account name
      currency      TEXT NOT NULL DEFAULT 'USD',
      balance       REAL NOT NULL DEFAULT 0,
      category      TEXT NOT NULL DEFAULT 'other',
      custom_name   TEXT,
      hidden        INTEGER NOT NULL DEFAULT 0,
      balance_date  TEXT,
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS manual_assets (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      category   TEXT NOT NULL DEFAULT 'other',
      value      REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS properties (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      address          TEXT NOT NULL UNIQUE,
      zestimate        REAL,
      mortgage_balance REAL NOT NULL DEFAULT 0,
      updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS net_worth_snapshots (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      date              TEXT NOT NULL UNIQUE,
      accounts_total    REAL NOT NULL,
      real_estate_total REAL NOT NULL,
      net_worth         REAL NOT NULL
    );
  `);

  // Upgrade path: add category to accounts created before categorization existed,
  // then backfill categories for any rows still on the default.
  try {
    db.exec(`ALTER TABLE accounts ADD COLUMN category TEXT NOT NULL DEFAULT 'other'`);
  } catch { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE accounts ADD COLUMN custom_name TEXT`);
  } catch { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE accounts ADD COLUMN source TEXT NOT NULL DEFAULT 'simplefin'`);
  } catch { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE accounts ADD COLUMN plaid_item_id TEXT`);
  } catch { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE accounts ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0`);
  } catch { /* column already exists */ }

  // Mortgage amortization inputs. When principal + rate + start are all set,
  // mortgage_balance is recomputed from a standard amortization schedule
  // (see services/mortgage.ts) instead of being entered manually.
  try { db.exec(`ALTER TABLE properties ADD COLUMN mortgage_principal REAL`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE properties ADD COLUMN mortgage_rate REAL`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE properties ADD COLUMN mortgage_start TEXT`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE properties ADD COLUMN mortgage_term_years INTEGER`); } catch { /* exists */ }

  // Per-property opt-out of the investment asset-allocation view (e.g. a primary
  // residence). Does not affect net worth — only the allocation breakdown.
  try { db.exec(`ALTER TABLE properties ADD COLUMN excluded_from_allocation INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }

  // Manually-entered per-property home-value (Zestimate) history. When present
  // for a property, the backfill uses these points directly instead of the
  // (smoothed) ZHVI curve — capturing the real month-to-month movement.
  db.exec(`
    CREATE TABLE IF NOT EXISTS property_value_history (
      property_id INTEGER NOT NULL,
      date        TEXT NOT NULL,
      value       REAL NOT NULL,
      PRIMARY KEY (property_id, date)
    )
  `);

  // Manual asset-class overrides for the allocation view, keyed by the holding's
  // display symbol (or name when untickered). Lets the user fix mis-bucketed or
  // "Uncategorized" holdings; applied consistently across every allocation panel.
  db.exec(`
    CREATE TABLE IF NOT EXISTS asset_class_overrides (
      symbol      TEXT PRIMARY KEY,
      asset_class TEXT NOT NULL,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const uncategorized = db
    .prepare(`SELECT id, name FROM accounts WHERE category = 'other'`)
    .all() as { id: string; name: string }[];
  const setCat = db.prepare(`UPDATE accounts SET category = ? WHERE id = ?`);
  for (const a of uncategorized) {
    const c = categorize(a.name);
    if (c !== 'other') setCat.run(c, a.id);
  }
}
