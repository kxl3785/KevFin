import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The Vanguard lookup memoizes in module-level Maps, so each test re-imports the
// module (vi.resetModules) to start cold. EDGAR is stubbed out: these tests are
// about how often Vanguard is asked, not about the fallback chain.
vi.mock('./edgarHoldings.js', () => ({ fetchEdgarConstituents: vi.fn(async () => null) }));

type Mod = typeof import('./fundHoldings.js');
let fetchVanguardStockHoldings: Mod['fetchVanguardStockHoldings'];
let fetchDeepConstituents: Mod['fetchDeepConstituents'];
let calls: string[];

const holdingsResponse = () => ({
  ok: true, status: 200,
  json: async () => ({ fund: { entity: [{ ticker: 'AAPL', shortName: 'Apple Inc', percentWeight: '6.70', isin: 'US0378331005' }] } }),
}) as unknown as Response;
const status = (code: number) => ({ ok: false, status: code, json: async () => ({}) }) as unknown as Response;

function stubFetch(responder: (url: string) => Response | Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => { calls.push(String(url)); return responder(String(url)); }));
}

beforeEach(async () => {
  calls = [];
  vi.resetModules();
  ({ fetchVanguardStockHoldings, fetchDeepConstituents } = await import('./fundHoldings.js'));
});

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('fetchVanguardStockHoldings', () => {
  it('parses holdings and caches the hit', async () => {
    stubFetch(() => holdingsResponse());
    const first = await fetchVanguardStockHoldings('VTI');
    expect(first).toEqual([{ symbol: 'AAPL', name: 'Apple Inc', percent: 0.067, country: expect.anything() }]);
    await fetchVanguardStockHoldings('vti');
    expect(calls).toHaveLength(1);
  });

  it('remembers a "not found" instead of asking again on every page load', async () => {
    stubFetch(() => status(404));
    expect(await fetchVanguardStockHoldings('VTI')).toEqual([]);
    expect(calls).toHaveLength(2); // the ETF path, then the mutual-fund path
    expect(await fetchVanguardStockHoldings('VTI')).toEqual([]);
    expect(calls).toHaveLength(2); // no new requests
  });

  it('asks again once a "not found" is a few hours old', async () => {
    vi.useFakeTimers();
    stubFetch(() => status(404));
    await fetchVanguardStockHoldings('VTI');
    vi.advanceTimersByTime(7 * 3600 * 1000);
    await fetchVanguardStockHoldings('VTI');
    expect(calls).toHaveLength(4);
  });

  it('keeps a block or outage only for a couple of minutes, so the fund is not pinned empty', async () => {
    vi.useFakeTimers();
    let blocked = true;
    stubFetch(() => (blocked ? status(403) : holdingsResponse()));
    expect(await fetchVanguardStockHoldings('VTI')).toEqual([]);
    expect(await fetchVanguardStockHoldings('VTI')).toEqual([]); // still inside the short hold
    expect(calls).toHaveLength(2);

    blocked = false;
    vi.advanceTimersByTime(3 * 60 * 1000);
    expect(await fetchVanguardStockHoldings('VTI')).toHaveLength(1);
  });

  it('shares one lookup between concurrent callers', async () => {
    stubFetch(() => holdingsResponse());
    const [a, b] = await Promise.all([fetchVanguardStockHoldings('VTI'), fetchVanguardStockHoldings('VTI')]);
    expect(calls).toHaveLength(1);
    expect(a).toEqual(b);
  });
});

describe('fetchDeepConstituents', () => {
  it('asks for the sleeves of a fund-of-funds together, not one after another', async () => {
    const { FUND_OF_FUNDS } = await import('../util/assumptions.js');
    const [fof, def] = Object.entries(FUND_OF_FUNDS).find(([, d]) => d.constituents.filter(c => c.kind !== 'bond').length >= 2)!;
    const equitySleeves = def.constituents.filter(c => c.kind !== 'bond').length;

    let open = 0, maxOpen = 0;
    stubFetch(async () => {
      open++; maxOpen = Math.max(maxOpen, open);
      await new Promise(r => setTimeout(r, 5));
      open--;
      return holdingsResponse();
    });
    const list = await fetchDeepConstituents(fof);
    expect(list?.some(c => c.symbol === 'AAPL')).toBe(true);
    expect(maxOpen).toBe(equitySleeves);
  });
});
