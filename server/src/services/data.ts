import Database from 'better-sqlite3';
import { existsSync, mkdirSync, copyFileSync, rmSync, writeFileSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb, closeDb, DB_PATH } from '../db/schema.js';

// Operational data-lifecycle actions for the Setup hub: full-database backup,
// restore, reset, and a system-status read. These are deliberately separate
// from the snapshot export (which is a read-only, encrypted *view*): a backup is
// the live kevfin.db you can restore into a running app.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKUP_DIR = path.join(path.dirname(DB_PATH), 'backups');

// Core tables every KevFin database has — used to sanity-check an uploaded file
// before we let it replace the live one.
const REQUIRED_TABLES = ['accounts', 'net_worth_snapshots', 'meta'];

// All user-data tables, ordered so a full wipe doesn't trip foreign-key-like
// dependencies (there are no FKs, but this keeps the intent clear).
const DATA_TABLES = [
  'net_worth_snapshots', 'property_value_history', 'properties',
  'manual_assets', 'accounts', 'asset_class_overrides', 'cost_basis_overrides', 'imported_cost_basis',
  'simplefin_connections', 'plaid_items',
  'imported_txns', 'budget_targets', 'txn_rules', 'txn_base_rules',
  'txn_sign_rules', 'txn_smart_rules',
];

// --- meta helpers (small settings persisted in the DB) ----------------------

export function getMetaValue(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function setMetaValue(key: string, value: string): void {
  getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
}

// Daily midnight snapshot toggle. Defaults to on unless the operator seeded
// DAILY_SNAPSHOT=false in the env; once toggled in the UI the DB value wins so
// it takes effect at runtime without a restart.
export function isDailySnapshotEnabled(): boolean {
  const v = getMetaValue('daily_snapshot_enabled');
  if (v === null) return process.env.DAILY_SNAPSHOT !== 'false';
  return v === '1';
}

export function setDailySnapshotEnabled(enabled: boolean): void {
  setMetaValue('daily_snapshot_enabled', enabled ? '1' : '0');
}

// --- backup -----------------------------------------------------------------

// Write a consistent point-in-time copy of the live DB to a temp file using
// SQLite's online backup API (safe even mid-write), returning its path. Caller
// is responsible for streaming then deleting it.
export async function backupToTempFile(): Promise<string> {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const dest = path.join(BACKUP_DIR, `tmp-backup-${Date.now()}.db`);
  await getDb().backup(dest);
  return dest;
}

export function backupFilename(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `kevfin-backup-${ts}.db`;
}

// --- restore ----------------------------------------------------------------

export class RestoreError extends Error {}

// Validate an uploaded SQLite file, snapshot the current DB to backups/ as a
// safety net, then swap the file in and reopen. Returns row counts of the new DB.
export async function restoreFromBuffer(buf: Buffer): Promise<Record<string, number>> {
  if (buf.length < 16 || buf.toString('utf8', 0, 15) !== 'SQLite format 3') {
    throw new RestoreError('That file is not a SQLite database.');
  }

  mkdirSync(BACKUP_DIR, { recursive: true });
  const incoming = path.join(BACKUP_DIR, `incoming-${Date.now()}.db`);
  writeFileSync(incoming, buf);

  // Validate the uploaded file has the tables a KevFin DB must have.
  try {
    const probe = new Database(incoming, { readonly: true });
    try {
      const names = new Set(
        (probe.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[])
          .map(t => t.name),
      );
      const missing = REQUIRED_TABLES.filter(t => !names.has(t));
      if (missing.length) {
        throw new RestoreError(`This doesn't look like a KevFin backup (missing: ${missing.join(', ')}).`);
      }
    } finally {
      probe.close();
    }
  } catch (e) {
    rmSync(incoming, { force: true });
    if (e instanceof RestoreError) throw e;
    throw new RestoreError('Could not read that file as a database.');
  }

  // Safety copy of the current DB before we overwrite it.
  if (existsSync(DB_PATH)) {
    await getDb().backup(path.join(BACKUP_DIR, `pre-restore-${Date.now()}.db`));
  }

  // Swap: close the live connection, replace the file, drop any stray journal,
  // then reopen (which re-runs the idempotent migration).
  closeDb();
  copyFileSync(incoming, DB_PATH);
  for (const sfx of ['-wal', '-shm', '-journal']) rmSync(DB_PATH + sfx, { force: true });
  rmSync(incoming, { force: true });

  return countRows();
}

// --- reset ------------------------------------------------------------------

export type ResetMode = 'history' | 'all';

// Wipe data in-place. 'history' clears only the net-worth time series (it can be
// rebuilt via Backfill); 'all' empties every user-data table for a fresh start.
// API credentials live in server/.env and are never touched here.
export function resetData(mode: ResetMode): Record<string, number> {
  const db = getDb();
  if (mode === 'history') {
    db.prepare('DELETE FROM net_worth_snapshots').run();
  } else {
    // Some budget tables are created lazily by the budget service, so they may
    // not exist yet — only wipe the ones actually present.
    const present = new Set(
      (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[])
        .map(t => t.name),
    );
    const wipe = db.transaction(() => {
      for (const t of DATA_TABLES) if (present.has(t)) db.prepare(`DELETE FROM ${t}`).run();
    });
    wipe();
  }
  return countRows();
}

// --- status -----------------------------------------------------------------

function tableCount(name: string): number {
  try {
    return (getDb().prepare(`SELECT COUNT(*) AS n FROM ${name}`).get() as { n: number }).n;
  } catch {
    return 0;
  }
}

function countRows(): Record<string, number> {
  return {
    accounts: tableCount('accounts'),
    properties: tableCount('properties'),
    manualAssets: tableCount('manual_assets'),
    snapshots: tableCount('net_worth_snapshots'),
    importedTxns: tableCount('imported_txns'),
    connections: tableCount('simplefin_connections') + tableCount('plaid_items'),
  };
}

function appVersion(): string {
  try {
    const pkg = path.join(__dirname, '../../package.json');
    return JSON.parse(readFileSync(pkg, 'utf8')).version ?? '—';
  } catch {
    return '—';
  }
}

export function getSystemStatus() {
  const db = getDb();
  const maxAcct = (db.prepare('SELECT MAX(updated_at) AS t FROM accounts').get() as { t: string | null }).t;
  const lastSnap = (db.prepare('SELECT MAX(date) AS d FROM net_worth_snapshots').get() as { d: string | null }).d;

  return {
    dbPath: DB_PATH,
    version: appVersion(),
    dailySnapshotEnabled: isDailySnapshotEnabled(),
    lastSync: {
      accounts: maxAcct,
      realEstate: getMetaValue('last_real_estate_refresh'),
      snapshot: lastSnap,
    },
    counts: countRows(),
  };
}
