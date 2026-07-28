import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { remainingMortgageBalance } from '../util/amortization.js';

// recomputeMortgageBalances reads/writes via getDb(), which resolves DB_PATH at
// module load. So we point DB_PATH at a fresh temp file and re-import the module
// graph (vi.resetModules) before each test to get an isolated database.
let dir: string;
let db: Database.Database;
let recomputeMortgageBalances: () => void;
let closeDb: () => void;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kevfin-mortgage-'));
  process.env.DB_PATH = join(dir, 'test.db');
  vi.resetModules();
  const schema = await import('../db/schema.js');
  ({ closeDb } = schema);
  db = schema.getDb(); // creates the file and runs the (idempotent) migration
  ({ recomputeMortgageBalances } = await import('./mortgage.js'));
});

afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

function addProperty(p: {
  address: string;
  principal?: number | null;
  rate?: number | null;
  start?: string | null;
  termYears?: number | null;
  balance?: number;
}) {
  db.prepare(
    `INSERT INTO properties
       (address, mortgage_principal, mortgage_rate, mortgage_start, mortgage_term_years, mortgage_balance)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(p.address, p.principal ?? null, p.rate ?? null, p.start ?? null, p.termYears ?? null, p.balance ?? 0);
}

const balanceOf = (address: string) =>
  (db.prepare(`SELECT mortgage_balance AS b FROM properties WHERE address = ?`).get(address) as { b: number }).b;

describe('recomputeMortgageBalances', () => {
  it('recomputes balance from the amortization schedule, defaulting term to 30yr', () => {
    addProperty({ address: '1 Main St', principal: 300000, rate: 6, start: '2020-01-15', termYears: null, balance: 0 });
    recomputeMortgageBalances();
    // term null → 30-year default
    expect(balanceOf('1 Main St')).toBeCloseTo(remainingMortgageBalance(300000, 6, '2020-01-15', 30), 2);
  });

  it('honors an explicit term length', () => {
    addProperty({ address: '2 Oak Ave', principal: 300000, rate: 6, start: '2020-01-15', termYears: 15 });
    recomputeMortgageBalances();
    const got = balanceOf('2 Oak Ave');
    expect(got).toBeCloseTo(remainingMortgageBalance(300000, 6, '2020-01-15', 15), 2);
    // a 15yr loan pays down faster than the 30yr default
    expect(got).toBeLessThan(remainingMortgageBalance(300000, 6, '2020-01-15', 30));
  });

  it('leaves properties without full loan terms untouched', () => {
    addProperty({ address: '3 Manual Rd', principal: null, rate: null, start: null, balance: 250000 });
    recomputeMortgageBalances();
    expect(balanceOf('3 Manual Rd')).toBe(250000); // manual balance preserved
  });

  it('updates every qualifying property in one pass', () => {
    addProperty({ address: 'A', principal: 200000, rate: 5, start: '2018-06-01', termYears: 30 });
    addProperty({ address: 'B', principal: 500000, rate: 7, start: '2021-03-01', termYears: 30 });
    addProperty({ address: 'C', principal: null, balance: 99999 }); // skipped
    recomputeMortgageBalances();
    expect(balanceOf('A')).toBeCloseTo(remainingMortgageBalance(200000, 5, '2018-06-01', 30), 2);
    expect(balanceOf('B')).toBeCloseTo(remainingMortgageBalance(500000, 7, '2021-03-01', 30), 2);
    expect(balanceOf('C')).toBe(99999);
  });
});

describe('mortgageBalanceAsOf', () => {
  const loan = {
    mortgage_balance: 111111,      // a stale/manual value that must lose to the schedule
    mortgage_principal: 400000,
    mortgage_rate: 6,
    mortgage_start: '2020-01-15',
    mortgage_term_years: 30,
  };

  // Net worth history subtracted TODAY's balance from every historical date, so
  // each past snapshot was credited with principal that hadn't been paid yet —
  // overstating past equity and understating measured growth.
  it('reports more owed in the past than today', async () => {
    const { mortgageBalanceAsOf } = await import('./mortgage.js');
    const then = mortgageBalanceAsOf(loan, '2021-01-15');
    const now = mortgageBalanceAsOf(loan, '2026-01-15');
    expect(then).toBeGreaterThan(now);
    expect(then).toBeCloseTo(remainingMortgageBalance(400000, 6, '2020-01-15', 30, new Date('2021-01-15T00:00:00')), 2);
  });

  it('matches the amortization schedule at the requested date', async () => {
    const { mortgageBalanceAsOf } = await import('./mortgage.js');
    for (const d of ['2020-01-15', '2022-07-01', '2030-03-31']) {
      expect(mortgageBalanceAsOf(loan, d))
        .toBeCloseTo(remainingMortgageBalance(400000, 6, '2020-01-15', 30, new Date(d + 'T00:00:00')), 2);
    }
  });

  it('is zero once the loan matures', async () => {
    const { mortgageBalanceAsOf } = await import('./mortgage.js');
    expect(mortgageBalanceAsOf(loan, '2055-01-15')).toBe(0);
  });

  it('falls back to the stored balance when terms are unknown', async () => {
    const { mortgageBalanceAsOf } = await import('./mortgage.js');
    const manual = { ...loan, mortgage_principal: null };
    expect(mortgageBalanceAsOf(manual, '2021-01-15')).toBe(111111);
    expect(mortgageBalanceAsOf({ ...loan, mortgage_start: null }, '2021-01-15')).toBe(111111);
    expect(mortgageBalanceAsOf({ ...loan, mortgage_rate: null }, '2021-01-15')).toBe(111111);
  });
});
