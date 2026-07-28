import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

// backfillHistory reads/writes via getDb(), which resolves DB_PATH at module
// load — so each test points DB_PATH at a fresh temp file and re-imports the
// module graph. With no connections configured, every provider fetch resolves
// empty without touching the network, so the reconstruction is deterministic:
// a cash account with no transactions is held flat at its current balance.
let dir: string;
let db: Database.Database;
let backfillHistory: typeof import('./backfill.js').backfillHistory;
let closeDb: () => void;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kevfin-backfill-'));
  process.env.DB_PATH = join(dir, 'test.db');
  vi.resetModules();
  const schema = await import('../db/schema.js');
  ({ closeDb } = schema);
  db = schema.getDb();
  ({ backfillHistory } = await import('./backfill.js'));

  db.prepare(`
    INSERT INTO accounts (id, connection_id, org_name, name, currency, balance, category, hidden)
    VALUES ('a1', NULL, 'Test Bank', 'Checking', 'USD', 1000, 'banking', 0)
  `).run();
});

afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

const putSnapshot = (date: string, nw: number) =>
  db.prepare(`INSERT INTO net_worth_snapshots (date, accounts_total, real_estate_total, net_worth)
              VALUES (?, ?, 0, ?)`).run(date, nw, nw);

const netWorthOn = (date: string) =>
  (db.prepare('SELECT net_worth AS n FROM net_worth_snapshots WHERE date = ?').get(date) as { n: number } | undefined)?.n;

const countSnapshots = () =>
  (db.prepare('SELECT COUNT(*) AS n FROM net_worth_snapshots').get() as { n: number }).n;

// A date inside the backfill window (which is the last 1825 days, excluding today).
const inWindow = new Date(Date.now() - 400 * 86_400_000).toISOString().slice(0, 10);

describe('backfillHistory', () => {
  it('reconstructs the full window', async () => {
    const written = await backfillHistory();
    expect(written).toBeGreaterThan(1800);
    expect(countSnapshots()).toBe(written);
    expect(netWorthOn(inWindow)).toBe(1000); // no transactions → held flat
  });

  // A reconstruction assumes today's holdings were always held, so it is a
  // weaker record than a snapshot actually observed on the day. The automatic
  // gap-filling path must only ever add.
  it('onlyMissing leaves an observed snapshot untouched', async () => {
    putSnapshot(inWindow, 424242);
    const written = await backfillHistory({ onlyMissing: true });

    expect(netWorthOn(inWindow)).toBe(424242);
    expect(written).toBeGreaterThan(1800);
    expect(countSnapshots()).toBe(written + 1); // the observed row plus what was added
  });

  it('a full rebuild does overwrite observed snapshots', async () => {
    putSnapshot(inWindow, 424242);
    await backfillHistory();
    expect(netWorthOn(inWindow)).toBe(1000);
  });

  it('onlyMissing writes nothing when history is already complete', async () => {
    await backfillHistory();
    const before = countSnapshots();
    expect(await backfillHistory({ onlyMissing: true })).toBe(0);
    expect(countSnapshots()).toBe(before);
  });

  it('onlyMissing fills just the holes', async () => {
    await backfillHistory();
    db.prepare('DELETE FROM net_worth_snapshots WHERE date >= ? AND date <= ?')
      .run('2025-01-01', '2025-01-10');
    const before = countSnapshots();

    expect(await backfillHistory({ onlyMissing: true })).toBe(10);
    expect(countSnapshots()).toBe(before + 10);
    expect(netWorthOn('2025-01-05')).toBe(1000);
  });
});
