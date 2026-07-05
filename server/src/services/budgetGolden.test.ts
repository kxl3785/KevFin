import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

/**
 * Golden characterization tests for the budget pipeline. They seed a fixed,
 * fully deterministic transaction feed into a throwaway DB, pin the clock, and
 * snapshot the exact JSON the budget endpoints produce. Their job is to make
 * refactors of the pipeline (storage changes, module splits, rule-table
 * consolidation) provably behavior-preserving: any change to these snapshots
 * must be intentional and explained in the commit that updates them.
 *
 * DB_PATH must be set before the schema module is imported (it reads the env
 * at module load), hence the dynamic imports below.
 */

const TMP = mkdtempSync(path.join(tmpdir(), 'kevfin-golden-'));
process.env.DB_PATH = path.join(TMP, 'golden.db');

const { refreshConnection } = await import('./simplefin.js');
const budget = await import('./budget.js');
const { getDb } = await import('../db/schema.js');

// The pinned "today": mid-month so getBudget's dailyCumulative has a partial
// current month, with 4 months of history behind it.
const NOW = new Date('2026-06-23T12:00:00Z');
const unix = (iso: string) => Math.floor(Date.parse(iso + 'T12:00:00Z') / 1000);

interface FeedTxn { id?: string; posted: number; amount: string; description: string; payee: string }
interface FeedAcct {
  org: { name: string }; id: string; name: string; currency: string; balance: string;
  'balance-date': number; transactions: FeedTxn[];
}

// Fixed feed: no randomness, no relative dates. Covers income clustering
// (payee variants of one employer), transfer-pair detection across accounts,
// credit-card payments with a tracked card, a brokerage account (excluded),
// id-less rows (synthetic ids), and every rule type applied in seed().
function buildFeed(): FeedAcct[] {
  const checking: FeedAcct = {
    org: { name: 'Chase' }, id: 'g-checking', name: 'Total Checking (1234)',
    currency: 'USD', balance: '12000.00', 'balance-date': unix('2026-06-23'), transactions: [],
  };
  const savings: FeedAcct = {
    org: { name: 'Ally' }, id: 'g-savings', name: 'Online Savings (5678)',
    currency: 'USD', balance: '45000.00', 'balance-date': unix('2026-06-23'), transactions: [],
  };
  const card: FeedAcct = {
    org: { name: 'Chase' }, id: 'g-card', name: 'Sapphire Credit Card (4167)',
    currency: 'USD', balance: '-2400.00', 'balance-date': unix('2026-06-23'), transactions: [],
  };
  const brokerage: FeedAcct = {
    org: { name: 'Fidelity' }, id: 'g-brokerage', name: 'Individual Brokerage',
    currency: 'USD', balance: '180000.00', 'balance-date': unix('2026-06-23'), transactions: [],
  };

  let seq = 0;
  const tx = (a: FeedAcct, date: string, amount: number, payee: string, description = payee, id?: string) =>
    a.transactions.push({ id: id ?? `g-tx-${seq++}`, posted: unix(date), amount: amount.toFixed(2), description, payee });

  for (const [y, m] of [[2026, 2], [2026, 3], [2026, 4], [2026, 5]] as const) {
    const d = (day: number) => `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const inJune = m === 5; // current (partial) month: only days <= 23 exist
    // Income: one employer under two payee variants (exercises source clustering).
    tx(checking, d(15), 3120.44, 'REFORMED RADIOLO PAYROLL');
    if (!inJune || 28 <= 23) tx(checking, d(28), 3120.44, 'REFORMED RADIOLOGY DIRECT DEP');
    // Bills and spending.
    tx(checking, d(3), -2800, 'ROCKET MORTGAGE PMT');
    tx(checking, d(8), -132.55, 'PG&E ELECTRIC');
    tx(card, d(5), -15.49, 'NETFLIX');
    tx(card, d(4), -128.3, 'WHOLE FOODS MARKET');
    tx(card, d(11), -74.15, "TRADER JOE'S");
    tx(card, d(9), -6.75, 'STARBUCKS');
    tx(card, d(16), -23.4, 'CHIPOTLE');
    tx(card, d(10), -58.2, 'SHELL');
    tx(card, d(17), -64.99, 'AMAZON', 'AMZN MKTP US*XX91Y');
    // Un-ruled merchant → Miscellaneous → review queue.
    tx(card, d(19), -45, 'LOCAL VENDOR LLC');
    // Card payment pair: outflow from checking, matching credit on the card.
    tx(checking, d(27 > 23 && inJune ? 20 : 27), -2400, 'CHASE CARD PAYMENT THANK YOU');
    if (!inJune) tx(card, d(28), 2400, 'Payment Thank You - Mobile');
    // Transfer pair the keywords miss: equal-and-opposite legs across accounts.
    tx(checking, d(6), -500, 'ACH WITHDRAWAL 99182');
    tx(savings, d(7), 500, 'MOBILE DEPOSIT');
    // Brokerage trades: must be excluded from budgeting entirely.
    tx(brokerage, d(12), -5000, 'BUY VTI');
    if (m % 3 === 2) tx(brokerage, d(15), 180.4, 'VANGUARD DIVIDEND REINVEST');
  }

  // Sign-flip target: posts positive but is really money out (rule set in seed()).
  tx(checking, '2026-05-02', 1800, 'BILT HOUSING #42');
  // Amount-override target (id referenced in seed()).
  tx(card, '2026-05-21', -112.4, 'SAFEWAY', 'SAFEWAY', 'g-override-me');
  // Two identical id-less same-day rows: synthetic-id occurrence handling.
  tx(card, '2026-05-09', -6.75, 'STARBUCKS', 'STARBUCKS');
  checking.transactions.push({ posted: unix('2026-05-14'), amount: '-19.99', description: 'GENERIC POS', payee: 'GENERIC POS' });
  checking.transactions.push({ posted: unix('2026-05-14'), amount: '-19.99', description: 'GENERIC POS', payee: 'GENERIC POS' });

  return [checking, savings, card, brokerage];
}

async function seed() {
  const db = getDb();
  db.prepare('INSERT INTO simplefin_connections (id, access_url) VALUES (1, ?)')
    .run('https://demo:demo@bridge.example.invalid/simplefin');
  db.prepare('INSERT OR REPLACE INTO provider_cache (key, fetched_at, payload) VALUES (?, ?, ?)')
    .run('sf_cache_1', NOW.getTime(), JSON.stringify(buildFeed()));
  await refreshConnection(1, 'https://demo:demo@bridge.example.invalid/simplefin');

  // Every rule type, exactly as the UI would create them.
  await budget.applyCategoryRule('local vendor llc', 'Home Services', 'all');
  await budget.applySmartRules([{ contains: 'safeway', category: 'Groceries' }]);
  budget.setSignFlip('bilt housing #42', true);
  budget.setTxnAmount('g-override-me', 99.99);
  budget.setTarget('Groceries', 850);
  budget.setTarget('Travel & Vacation', 6000, 'annual');

  // CSV import: one exact duplicate of a feed row (must dedup away) and one
  // genuinely new row carrying a Monarch-style category.
  budget.importTransactions([
    'Date,Merchant,Amount,Account,Category',
    '2026-05-04,Whole Foods Market,-128.30,Sapphire Credit Card (4167),Groceries',
    '2026-05-23,Blue Wave Pool Service,-180.00,Total Checking (1234),Home Services',
  ].join('\n'));
}

beforeAll(async () => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  await seed();
});

afterAll(() => {
  vi.useRealTimers();
  rmSync(TMP, { recursive: true, force: true });
});

describe('budget pipeline golden outputs', () => {
  it('getBudget (current month)', async () => {
    expect(await budget.getBudget()).toMatchSnapshot();
  });

  it('getBudget (full prior month)', async () => {
    expect(await budget.getBudget('2026-05')).toMatchSnapshot();
  });

  it('getTransactionsList', async () => {
    expect(await budget.getTransactionsList('all')).toMatchSnapshot();
  });

  it('getCashFlow (12m, detailed)', async () => {
    expect(await budget.getCashFlow('12m', true)).toMatchSnapshot();
  });

  it('getCashFlowTransactions (category drill-down)', async () => {
    expect(await budget.getCashFlowTransactions('12m', 'category', 'Groceries')).toMatchSnapshot();
  });

  it('getSpendingProjection', async () => {
    expect(await budget.getSpendingProjection()).toMatchSnapshot();
  });

  it('getReviewQueue', async () => {
    expect(await budget.getReviewQueue()).toMatchSnapshot();
  });

  it('getCategoryGroups and state snapshot', () => {
    expect(budget.getCategoryGroups()).toMatchSnapshot();
    expect(budget.getCategoryState()).toMatchSnapshot();
  });
});
