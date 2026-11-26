import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

// The market lookups the Investments page waits on (price history, fund-company
// holdings, Yahoo fund details) keep their answers in provider_cache, so a
// restart doesn't throw them away. Each test runs against a fresh temp-file
// database; boot() plays a server restart: every module (and its in-memory
// cache) is loaded anew, while the database file stays.
let dir: string;
let db: Database.Database;
let closeDb: (() => void) | undefined;
let prices: typeof import('./prices.js');
let funds: typeof import('./fundHoldings.js');
let yahoo: typeof import('./yahooMeta.js');
let health: typeof import('./lookupHealth.js');
let calls: string[];

async function boot() {
  closeDb?.();
  vi.resetModules();
  const schema = await import('../db/schema.js');
  ({ closeDb } = schema);
  db = schema.getDb();
  prices = await import('./prices.js');
  funds = await import('./fundHoldings.js');
  yahoo = await import('./yahooMeta.js');
  health = await import('./lookupHealth.js');
}

function stubFetch(responder: (url: string) => unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => { calls.push(String(url)); return responder(String(url)) as Response; }));
}
const storedKeys = (prefix: string) =>
  (db.prepare('SELECT key FROM provider_cache ORDER BY key').all() as { key: string }[]).map(r => r.key).filter(k => k.startsWith(prefix));

const T0 = Date.UTC(2026, 2, 3, 12, 0, 0);
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kevfin-lookups-'));
  process.env.DB_PATH = join(dir, 'test.db');
  calls = [];
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  closeDb = undefined;
  await boot();
}, 60_000); // module re-import can exceed the 10s default on a slow FS under full-suite load

afterEach(() => {
  closeDb?.();
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// --- Prices -------------------------------------------------------------------

// A pretend Yahoo chart endpoint over a small "market": one row per trading
// day, answered for whatever period1..period2 the request asks about.
interface Bar { date: string; close: number; adj: number }
const weekdays = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let d = new Date(from + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
};
// Closes climb a dollar a day; adjClose is the close scaled by `basis`.
const bars = (from: string, to: string, basis = 1): Bar[] =>
  weekdays(from, to).map((date, i) => ({ date, close: 100 + i, adj: (100 + i) * basis }));
const openTs = (date: string) => Date.parse(date + 'T14:30:00Z') / 1000;
function chart(market: Bar[], url: string) {
  const u = new URL(url);
  const p1 = Number(u.searchParams.get('period1')), p2 = Number(u.searchParams.get('period2'));
  const rows = market.filter(b => openTs(b.date) >= p1 && openTs(b.date) < p2);
  return {
    ok: true, status: 200,
    json: async () => ({ chart: { result: [{
      timestamp: rows.map(b => openTs(b.date)),
      indicators: { quote: [{ close: rows.map(b => b.close) }], adjclose: [{ adjclose: rows.map(b => b.adj) }] },
    }] } }),
  };
}
const asPoints = (market: Bar[]) => market.map(b => ({ date: b.date, close: b.close, adjClose: b.adj }));
const period1 = (url: string) => new Date(Number(new URL(url).searchParams.get('period1')) * 1000).toISOString().slice(0, 10);

describe('price history', () => {
  it('is served from the database after a restart, without asking Yahoo again', async () => {
    const market = bars('2026-01-02', '2026-03-02');
    stubFetch(url => chart(market, url));
    const first = await prices.fetchDailyCloses('SPY', '2026-01-01', '2026-03-03');
    expect(first).toEqual(asPoints(market));
    expect(calls).toHaveLength(1);

    await boot();
    expect(await prices.fetchDailyCloses('spy', '2026-01-01', '2026-03-03')).toEqual(first);
    expect(calls).toHaveLength(1);
  });

  it('answers a narrower window from the stored series, as a fresh request would', async () => {
    const market = bars('2026-01-02', '2026-03-02');
    stubFetch(url => chart(market, url));
    await prices.fetchDailyCloses('SPY', '2026-01-01', '2026-03-03');
    const part = await prices.fetchDailyCloses('SPY', '2026-02-02', '2026-02-13');
    expect(part).toEqual(asPoints(bars('2026-01-02', '2026-03-02').filter(b => b.date >= '2026-02-02' && b.date <= '2026-02-13')));
    expect(part[0].date).toBe('2026-02-02'); // callers read the first point as the window's start
    expect(calls).toHaveLength(1);
  });

  it('on a new day fetches only the recent days and appends them', async () => {
    let market = bars('2026-01-02', '2026-03-02');
    stubFetch(url => chart(market, url));
    await prices.fetchDailyCloses('SPY', '2026-01-01', '2026-03-03');

    // The next day: one more close exists, and the caller's window ends a day later.
    market = bars('2026-01-02', '2026-03-03');
    vi.setSystemTime(T0 + DAY);
    await boot(); // and the server restarted overnight, for good measure
    const next = await prices.fetchDailyCloses('SPY', '2026-01-01', '2026-03-04');

    expect(calls).toHaveLength(2);
    expect(period1(calls[1])).toBe('2026-01-31'); // 30 days before the last stored close, not the whole history
    expect(next).toEqual(asPoints(market));       // exactly what a full download would have given
    // And the day is now covered: nothing more is asked.
    await prices.fetchDailyCloses('SPY', '2026-01-01', '2026-03-04');
    expect(calls).toHaveLength(2);
  });

  it('downloads the whole history again when a distribution has re-based it', async () => {
    let market = bars('2026-01-02', '2026-03-02');
    stubFetch(url => chart(market, url));
    await prices.fetchDailyCloses('BND', '2026-01-01', '2026-03-03');

    // A distribution went ex on the new day: every earlier adjClose is scaled down.
    market = [...bars('2026-01-02', '2026-03-02', 0.997), { date: '2026-03-03', close: 142, adj: 142 }];
    vi.setSystemTime(T0 + DAY);
    const next = await prices.fetchDailyCloses('BND', '2026-01-01', '2026-03-04');

    expect(calls).toHaveLength(3); // the top-up, which disagreed with what was stored, then the full range
    expect(period1(calls[2])).toBe('2026-01-01');
    expect(next).toEqual(asPoints(market)); // one basis throughout: no kink where the new day joins
    await boot();
    expect(await prices.fetchDailyCloses('BND', '2026-01-01', '2026-03-04')).toEqual(asPoints(market));
    expect(calls).toHaveLength(3);
  });

  it('returns nothing when the top-up fails, rather than a series that stops short, and keeps what it has', async () => {
    const market = bars('2026-01-02', '2026-03-03');
    stubFetch(url => chart(market.slice(0, -1), url));
    await prices.fetchDailyCloses('SPY', '2026-01-01', '2026-03-03');

    vi.setSystemTime(T0 + DAY);
    const before = health.lookupFailureCount();
    stubFetch(() => ({ ok: false, status: 429 }));
    expect(await prices.fetchDailyCloses('SPY', '2026-01-01', '2026-03-04')).toEqual([]);
    expect(health.lookupFailureCount()).toBe(before + 1); // so a result built on it is not kept as good

    // Yahoo is back: only the recent days are needed, the stored history is still there.
    stubFetch(url => chart(market, url));
    expect(await prices.fetchDailyCloses('SPY', '2026-01-01', '2026-03-04')).toEqual(asPoints(market));
    expect(period1(calls[calls.length - 1])).toBe('2026-01-31');
  });

  it('starts over once a week, so an old correction cannot linger', async () => {
    let market = bars('2026-01-02', '2026-03-02');
    stubFetch(url => chart(market, url));
    await prices.fetchDailyCloses('SPY', '2026-01-01', '2026-03-03');

    market = bars('2026-01-02', '2026-03-10');
    vi.setSystemTime(T0 + 8 * DAY);
    await prices.fetchDailyCloses('SPY', '2026-01-01', '2026-03-11');
    expect(calls).toHaveLength(2);
    expect(period1(calls[1])).toBe('2026-01-01');
  });

  it('widens the stored range for a caller that needs older prices', async () => {
    const market = bars('2025-06-02', '2026-03-02');
    stubFetch(url => chart(market, url));
    await prices.fetchDailyCloses('SPY', '2026-01-01', '2026-03-03');
    const longer = await prices.fetchDailyCloses('SPY', '2025-06-01', '2026-03-03'); // a lot's purchase date
    expect(calls).toHaveLength(2);
    expect(longer).toEqual(asPoints(market));
    // Both windows are now answered from the one stored series.
    await prices.fetchDailyCloses('SPY', '2026-01-01', '2026-03-03');
    await prices.fetchDailyCloses('SPY', '2025-06-01', '2026-03-03');
    expect(calls).toHaveLength(2);
  });

  it('remembers "no such symbol" across a restart, for a few hours', async () => {
    stubFetch(() => ({ ok: false, status: 404 }));
    expect(await prices.fetchDailyCloses('NOSUCH', '2026-01-01', '2026-03-03')).toEqual([]);
    await boot();
    expect(await prices.fetchDailyCloses('NOSUCH', '2026-01-01', '2026-03-03')).toEqual([]);
    expect(calls).toHaveLength(1);

    vi.setSystemTime(T0 + 7 * HOUR);
    await prices.fetchDailyCloses('NOSUCH', '2026-01-01', '2026-03-03');
    expect(calls).toHaveLength(2);
  });

  it('clearPriceCache forgets the stored rows as well', async () => {
    const market = bars('2026-01-02', '2026-03-02');
    stubFetch(url => chart(market, url));
    await prices.fetchDailyCloses('SPY', '2026-01-01', '2026-03-03');
    expect(storedKeys('prices')).toEqual(['prices:SPY']);

    prices.clearPriceCache();
    expect(storedKeys('prices')).toEqual([]);
    await prices.fetchDailyCloses('SPY', '2026-01-01', '2026-03-03');
    expect(calls).toHaveLength(2);
  });
});

// --- Fund-company holdings ------------------------------------------------------

const vgPage = (entity: object[]) => ({ ok: true, status: 200, json: async () => ({ size: entity.length, fund: { entity } }) });
const AAPL = { ticker: 'AAPL', shortName: 'APPLE INC', percentWeight: '6.70', isin: 'US0378331005', cusip: '037833100' };

describe('fund-company holdings', () => {
  it('survive a restart for their day', async () => {
    stubFetch(() => vgPage([AAPL]));
    const first = await funds.fetchVanguardStockHoldings('VTI');
    expect(first).toHaveLength(1);

    vi.setSystemTime(T0 + 23 * HOUR);
    await boot();
    expect(await funds.fetchVanguardStockHoldings('VTI')).toEqual(first);
    expect(calls).toHaveLength(1);

    // The same TTL as before: a day on, the fund company is asked again.
    vi.setSystemTime(T0 + 25 * HOUR);
    await funds.fetchVanguardStockHoldings('VTI');
    expect(calls).toHaveLength(2);
  });

  it('remember a firm "not ours" across a restart, but only for its shorter time', async () => {
    stubFetch(() => ({ ok: false, status: 404, json: async () => ({}) }));
    expect(await funds.fetchVanguardStockHoldings('FXAIX')).toEqual([]);
    await boot();
    vi.setSystemTime(T0 + 5 * HOUR);
    expect(await funds.fetchVanguardStockHoldings('FXAIX')).toEqual([]);
    expect(calls).toHaveLength(1);

    vi.setSystemTime(T0 + 7 * HOUR);
    await funds.fetchVanguardStockHoldings('FXAIX');
    expect(calls).toHaveLength(2);
  });

  it('never store a failure: after a restart the fund company is asked again', async () => {
    const before = health.lookupFailureCount();
    stubFetch(() => ({ ok: false, status: 503, json: async () => ({}) }));
    expect(await funds.fetchVanguardStockHoldings('VTI')).toEqual([]);
    expect(health.lookupFailureCount()).toBe(before + 1);
    expect(storedKeys('fund_holdings')).toEqual([]);
    // Held briefly in memory, as before...
    await funds.fetchVanguardStockHoldings('VTI');
    expect(calls).toHaveLength(1);
    // ...and gone with the process.
    await boot();
    stubFetch(() => vgPage([AAPL]));
    expect(await funds.fetchVanguardStockHoldings('VTI')).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it('clearFundHoldingsCache forgets the stored rows as well', async () => {
    stubFetch(() => vgPage([AAPL]));
    await funds.fetchVanguardStockHoldings('VTI');
    expect(storedKeys('fund_holdings')).toEqual(['fund_holdings:VG:VTI']);
    funds.clearFundHoldingsCache();
    expect(storedKeys('fund_holdings')).toEqual([]);
    await funds.fetchVanguardStockHoldings('VTI');
    expect(calls).toHaveLength(2);
  });
});

// --- Yahoo fund details -----------------------------------------------------------

// The cookie + crumb handshake is answered too; only quoteSummary requests count.
function stubYahoo(quote: () => { status?: number; body?: unknown }) {
  stubFetch(url => {
    if (url.includes('getcrumb')) return { ok: true, text: async () => 'crumb123' };
    if (!url.includes('quoteSummary')) return { ok: true, headers: { getSetCookie: () => ['A=1; Path=/'] } };
    const r = quote();
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body ?? {} };
  });
}
const quoteCalls = () => calls.filter(u => u.includes('quoteSummary')).length;
const EQUITY = { quoteSummary: { result: [{ quoteType: { quoteType: 'EQUITY' }, assetProfile: { sector: 'Technology', country: 'United States' } }] } };

describe('Yahoo fund details', () => {
  it('survive a restart for their day, with no new handshake', async () => {
    stubYahoo(() => ({ body: EQUITY }));
    const first = await yahoo.fetchSecurityMeta('aapl');
    expect(first).toMatchObject({ quoteType: 'EQUITY', sector: 'Technology', country: 'United States' });
    const requests = calls.length;

    vi.setSystemTime(T0 + 23 * HOUR);
    await boot();
    expect(await yahoo.fetchSecurityMeta('AAPL')).toEqual(first);
    expect(calls).toHaveLength(requests); // not even the cookie + crumb

    vi.setSystemTime(T0 + 25 * HOUR);
    await yahoo.fetchSecurityMeta('AAPL');
    expect(quoteCalls()).toBe(2);
  });

  it('remember that Yahoo has nothing for a symbol (a 404 is an answer)', async () => {
    stubYahoo(() => ({ status: 404 }));
    await yahoo.fetchSecurityMeta('PLANFUND');
    await boot();
    await yahoo.fetchSecurityMeta('PLANFUND');
    expect(quoteCalls()).toBe(1);
  });

  it('never store a throttle or outage', async () => {
    const before = health.lookupFailureCount();
    stubYahoo(() => ({ status: 429 }));
    expect((await yahoo.fetchSecurityMeta('AAPL')).quoteType).toBeNull();
    expect(health.lookupFailureCount()).toBe(before + 1);
    expect(storedKeys('yahoo_meta')).toEqual([]);

    await boot();
    stubYahoo(() => ({ body: EQUITY }));
    expect((await yahoo.fetchSecurityMeta('AAPL')).quoteType).toBe('EQUITY');
  });
});
