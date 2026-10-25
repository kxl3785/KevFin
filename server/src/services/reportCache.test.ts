import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations, MIGRATIONS } from '../db/migrations.js';
import { getQuarterlyReport, getStoredReport } from './reportCache.js';

// 2026-10-02 falls inside Q4's report window, which reports on Q3 2026.
const NOW = new Date('2026-10-02T12:00:00Z');

describe('report_cache migration', () => {
  it('creates the table on a fresh database', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const cols = db.prepare('PRAGMA table_info(report_cache)').all() as { name: string }[];
    expect(cols.map(c => c.name)).toEqual(['quarter_label', 'html', 'generated_at']);
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS[MIGRATIONS.length - 1].version);
  });
});

describe('getQuarterlyReport', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });

  it('generates and stores on a miss, then serves the stored copy without regenerating', async () => {
    const generate = vi.fn(async () => '<html>v1</html>');
    const first = await getQuarterlyReport({}, { db, generate, now: NOW });
    expect(first.html).toBe('<html>v1</html>');
    expect(getStoredReport({ db, now: NOW })).toMatchObject({ quarterLabel: 'Q3 2026', html: '<html>v1</html>' });

    const second = await getQuarterlyReport({}, { db, generate, now: NOW });
    expect(second).toEqual(first);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('fresh=true regenerates and replaces the stored copy', async () => {
    let n = 0;
    const generate = vi.fn(async () => `<html>v${++n}</html>`);
    await getQuarterlyReport({}, { db, generate, now: NOW });
    const regen = await getQuarterlyReport({ fresh: true }, { db, generate, now: NOW });
    expect(regen.html).toBe('<html>v2</html>');
    expect(generate).toHaveBeenCalledTimes(2);
    expect(getStoredReport({ db, now: NOW })?.html).toBe('<html>v2</html>');
    expect((db.prepare('SELECT COUNT(*) AS n FROM report_cache').get() as { n: number }).n).toBe(1);
  });

  it('concurrent calls share a single generation', async () => {
    let release!: (html: string) => void;
    const generate = vi.fn(() => new Promise<string>(r => { release = r; }));
    const calls = [
      getQuarterlyReport({ fresh: true }, { db, generate, now: NOW }),
      getQuarterlyReport({ fresh: true }, { db, generate, now: NOW }),
      getQuarterlyReport({}, { db, generate, now: NOW }),
    ];
    release('<html>shared</html>');
    const results = await Promise.all(calls);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(new Set(results.map(r => r.html))).toEqual(new Set(['<html>shared</html>']));
  });

  it('a failed generation stores nothing and lets the next call retry', async () => {
    const generate = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('<html>ok</html>');
    await expect(getQuarterlyReport({}, { db, generate, now: NOW })).rejects.toThrow('boom');
    expect(getStoredReport({ db, now: NOW })).toBeNull();
    expect((await getQuarterlyReport({}, { db, generate, now: NOW })).html).toBe('<html>ok</html>');
  });
});
