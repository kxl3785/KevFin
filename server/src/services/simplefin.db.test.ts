import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// How often the provider is asked, against a throwaway IN-MEMORY database
// (DB_PATH=':memory:' — no file is created) with fetch stubbed, so nothing
// touches the network or the real data/kevfin.db.
type Mod = typeof import('./simplefin.js');
let fetchHoldings: Mod['fetchHoldings'];
let closeDb: () => void;
let calls: number;

const payload = () => ({
  ok: true, status: 200,
  json: async () => ({ errors: [], accounts: [{ org: { name: 'Test Bank' }, id: 'acct-1', name: 'Brokerage', currency: 'USD', balance: '100.00',
    holdings: [{ symbol: 'VTI', description: 'Total Market', market_value: '100.00', shares: '1' }] }] }),
}) as unknown as Response;

beforeEach(async () => {
  process.env.DB_PATH = ':memory:';
  calls = 0;
  vi.resetModules();
  const schema = await import('../db/schema.js');
  expect(schema.DB_PATH).toBe(':memory:'); // never the real data/kevfin.db
  ({ closeDb } = schema);
  schema.getDb().prepare('INSERT INTO simplefin_connections (access_url) VALUES (?)').run('https://user:pass@bridge.example.invalid/simplefin');
  ({ fetchHoldings } = await import('./simplefin.js'));
}, 60_000);

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); closeDb(); });

describe('provider fetch sharing and back-off', () => {
  it('makes one provider request when several endpoints ask at once, then serves the cached copy', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { calls++; await new Promise(r => setTimeout(r, 5)); return payload(); }));
    const [a, b, c] = await Promise.all([fetchHoldings(), fetchHoldings(), fetchHoldings()]);
    expect(calls).toBe(1);
    expect(a.get('acct-1')?.[0].symbol).toBe('VTI');
    expect(b.get('acct-1')).toEqual(a.get('acct-1'));
    expect(c.get('acct-1')).toEqual(a.get('acct-1'));

    await fetchHoldings();
    expect(calls).toBe(1);
  });

  it('does not make every page load wait on a provider that just failed, and tries again after a few minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let down = true;
    vi.stubGlobal('fetch', vi.fn(async () => { calls++; if (down) throw new Error('network down'); return payload(); }));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect((await fetchHoldings()).size).toBe(0); // nothing cached yet, fetch failed
    expect(calls).toBe(1);
    await fetchHoldings();
    await fetchHoldings();
    expect(calls).toBe(1); // inside the back-off: no new request

    down = false;
    vi.setSystemTime(Date.now() + 6 * 60 * 1000);
    expect((await fetchHoldings()).get('acct-1')?.[0].symbol).toBe('VTI');
    expect(calls).toBe(2);
    errors.mockRestore();
  });
});
