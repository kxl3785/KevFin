import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

// getTaxBuckets feeds the Forecast's starting pools. Manual assets named like a
// tax-advantaged account (e.g. a Trump Account no aggregator can reach) must be
// bucketed alongside connected accounts; everything else keeps the old behavior.
let dir: string;
let closeDb: () => void;
let db: Database.Database;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kevfin-taxbuckets-'));
  process.env.DB_PATH = join(dir, 'test.db');
  vi.resetModules();
  const schema = await import('../db/schema.js');
  ({ closeDb } = schema);
  db = schema.getDb();
}, 60_000);

afterEach(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); });

const addAccount = (id: string, name: string, balance: number, category = 'investment', hidden = 0) =>
  db.prepare('INSERT INTO accounts (id, org_name, name, balance, category, hidden) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, 'Fidelity', name, balance, category, hidden);
const addManual = (name: string, value: number, rate: number | null = null) =>
  Number(db.prepare('INSERT INTO manual_assets (name, value, interest_rate) VALUES (?, ?, ?)').run(name, value, rate).lastInsertRowid);

describe('getTaxBuckets', () => {
  it('buckets a manual Trump Account as college, next to connected accounts', async () => {
    addAccount('a1', 'Roth IRA', 50_000);
    addAccount('a2', 'Individual', 20_000);
    const id = addManual('Trump Account', 1_400);
    const { getTaxBuckets } = await import('./netWorth.js');

    const { totals, accounts } = getTaxBuckets();
    expect(totals).toEqual({ taxable: 20_000, pretax: 0, roth: 50_000, hsa: 0, college: 1_400 });
    expect(accounts).toContainEqual({ id: `manual:${id}`, name: 'Trump Account', org_name: 'Manual assets', balance: 1_400, bucket: 'college' });
  });

  it('includes other tax-advantaged manual assets (e.g. a hand-entered pension)', async () => {
    addManual('State Pension', 80_000);
    const { getTaxBuckets } = await import('./netWorth.js');
    expect(getTaxBuckets().totals.pretax).toBe(80_000);
  });

  it('leaves out manual assets that classify as taxable, rated ones, and liabilities', async () => {
    addManual('Car', 15_000);                  // taxable → keeps legacy spreading
    addManual('Old 401k', 30_000, 5);          // rated → grown in its own sleeve
    addManual('Trump Account loan', -500);     // liability
    const { getTaxBuckets } = await import('./netWorth.js');

    const { totals, accounts } = getTaxBuckets();
    expect(accounts).toEqual([]);
    expect(totals).toEqual({ taxable: 0, pretax: 0, roth: 0, hsa: 0, college: 0 });
  });

  it('still excludes hidden and credit accounts', async () => {
    addAccount('a1', 'Roth IRA', 50_000, 'investment', 1);
    addAccount('c1', 'Sapphire', -2_000, 'credit');
    const { getTaxBuckets } = await import('./netWorth.js');
    expect(getTaxBuckets().accounts).toEqual([]);
  });
});
