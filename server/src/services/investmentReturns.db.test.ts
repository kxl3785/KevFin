import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// End-to-end through getReturns' SQL against a throwaway IN-MEMORY database
// (DB_PATH=':memory:' — no file is created), with the benchmark price fetch
// stubbed so nothing touches the network.
vi.mock('./performance.js', () => ({
  benchmarkWindowReturn: vi.fn(async (id: string, from: string, to: string) =>
    ({ id, label: 'S&P 500 (SPY)', from, to, periodReturn: 0.05, annualized: null })),
}));

type Mod = typeof import('./investmentReturns.js');
let getReturns: Mod['getReturns'];
let closeDb: () => void;
let db: import('better-sqlite3').Database;

const isoDaysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const unixDaysAgo = (n: number) => Math.floor((Date.now() - n * 86_400_000) / 1000);

beforeEach(async () => {
  process.env.DB_PATH = ':memory:';
  vi.resetModules();
  const schema = await import('../db/schema.js');
  expect(schema.DB_PATH).toBe(':memory:'); // never the real data/kevfin.db
  ({ closeDb } = schema);
  db = schema.getDb();
  ({ getReturns } = await import('./investmentReturns.js'));
}, 60_000);

afterEach(() => closeDb());

describe('getReturns (database wiring)', () => {
  it('uses real balances only, reads transactions, applies stored overrides', async () => {
    const acct = db.prepare(`INSERT INTO accounts (id, org_name, name, balance, category, hidden) VALUES (?, ?, ?, ?, ?, 0)`);
    acct.run('b1', 'Fidelity', 'Individual Brokerage', 1210, 'brokerage');
    acct.run('r1', 'Vanguard', 'Roth IRA', 500, 'brokerage');
    acct.run('s1', 'Ally', 'Online Savings', 9000, 'banking');

    const obs = db.prepare(`INSERT INTO balance_observations (account_id, date, balance, estimated) VALUES (?, ?, ?, ?)`);
    obs.run('b1', isoDaysAgo(40), 5, 1);       // an ESTIMATED row: must be ignored
    obs.run('b1', isoDaysAgo(3), 1000, 0);
    obs.run('b1', isoDaysAgo(2), 1100, 0);
    obs.run('b1', isoDaysAgo(1), 1200, 0);
    obs.run('b1', isoDaysAgo(0), 1210, 0);

    const txn = db.prepare(`INSERT INTO transactions (id, account_id, account_name, source, posted, amount, payee, description, memo)
                            VALUES (?, ?, ?, 'simplefin', ?, ?, ?, ?, '')`);
    txn.run('x-div', 'b1', 'Individual Brokerage', unixDaysAgo(20), 150, 'VANGUARD DIVIDEND REINVEST', 'VANGUARD DIVIDEND REINVEST');
    txn.run('x-dep', 'b1', 'Individual Brokerage', unixDaysAgo(1), 100, 'EFT', 'Electronic Funds Transfer Received');

    let r = await getReturns(30);
    const b1 = r.accounts.find(a => a.id === 'b1')!;
    expect(b1.included).toBe(true);
    expect(b1.measuredFrom).toBe(isoDaysAgo(3)); // first real balance after the transactions begin
    expect(b1.timeWeighted.periodReturn).toBeCloseTo(1.1 * (1210 / 1200) - 1, 10);
    expect(r.accounts.find(a => a.id === 'r1')!.included).toBe(false);
    expect(r.accounts.some(a => a.id === 's1')).toBe(false); // bank accounts aren't investment returns
    expect(r.flows.map(f => f.id)).toEqual(['x-dep']);
    expect(r.benchmark).toMatchObject({ periodReturn: 0.05, from: isoDaysAgo(3) });

    // The include/exclude switch is read from the prefs store.
    db.prepare(`INSERT INTO meta (key, value) VALUES ('pref:mon.returnsFlowOverrides', ?)`).run(JSON.stringify({ 'x-dep': 'exclude' }));
    r = await getReturns(30);
    expect(r.flows[0]).toMatchObject({ id: 'x-dep', included: false });
    expect(r.accounts.find(a => a.id === 'b1')!.timeWeighted.periodReturn).toBeCloseTo(0.21, 10);
  });

  it('leaves out an account whose provider stopped sending new balances', async () => {
    // Every account has fresh-looking real observations (the daily snapshot
    // re-records the cached balance), but two providers last reported long ago:
    // SimpleFIN via balance_date, Plaid via the row's updated_at.
    const acct = db.prepare(`INSERT INTO accounts (id, org_name, name, balance, category, hidden, source, balance_date, updated_at)
                             VALUES (?, ?, ?, ?, 'brokerage', 0, ?, ?, ?)`);
    const old = `${isoDaysAgo(30)}T16:00:00.000Z`;
    acct.run('sf-stale', 'Fidelity', 'Stale SimpleFIN', 1000, 'simplefin', old, `${isoDaysAgo(0)} 06:00:00`);
    acct.run('pl-stale', 'Schwab', 'Stale Plaid', 1000, 'plaid', null, `${isoDaysAgo(30)} 06:00:00`);
    acct.run('sf-fresh', 'Vanguard', 'Fresh', 1000, 'simplefin', `${isoDaysAgo(1)}T16:00:00.000Z`, `${isoDaysAgo(0)} 06:00:00`);
    const obs = db.prepare(`INSERT INTO balance_observations (account_id, date, balance, estimated) VALUES (?, ?, ?, 0)`);
    const txn = db.prepare(`INSERT INTO transactions (id, account_id, account_name, source, posted, amount, payee, description, memo)
                            VALUES (?, ?, ?, 'simplefin', ?, 10, 'DIVIDEND', 'DIVIDEND', '')`);
    for (const id of ['sf-stale', 'pl-stale', 'sf-fresh']) {
      for (let d = 3; d >= 0; d--) obs.run(id, isoDaysAgo(d), 1000);
      txn.run(`${id}-div`, id, id, unixDaysAgo(20));
    }

    const r = await getReturns(30);
    const by = (id: string) => r.accounts.find(a => a.id === id)!;
    expect(by('sf-stale').included).toBe(false);
    expect(by('sf-stale').reason).toMatch(/hasn’t sent a new balance since/);
    expect(by('pl-stale').included).toBe(false);
    expect(by('sf-fresh').included).toBe(true);
    expect(r.coverage.includedCount).toBe(1);
  });

  it('works on an empty database', async () => {
    const r = await getReturns(365);
    expect(r.total).toBeNull();
    expect(r.accounts).toEqual([]);
    expect(r.income.total).toBe(0);
  });
});
