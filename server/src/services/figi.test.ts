import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The cache is swapped for an in-memory map so this test never touches a
// database; fetch is stubbed so it never touches the network.
const cache = new Map<string, { fetchedAt: number; payload: unknown }>();
vi.mock('../db/providerCache.js', () => ({
  readProviderCache: (k: string) => cache.get(k) ?? null,
  writeProviderCache: (k: string, e: { fetchedAt: number; payload: unknown }) => { cache.set(k, e); },
}));

import {
  knownTicker, queueTickerLookups, figiStatus, resetFigiState, drainFigiQueueForTest, pickTicker,
  HIT_TTL_MS, MISS_TTL_MS,
} from './figi.js';

const DAY = 24 * 3600 * 1000;
const T0 = Date.UTC(2026, 10, 1);
const APPLE_CUSIP = '037833100';
const APPLE_ISIN = 'US0378331005';
const AAPL = [
  { ticker: 'AAPL', exchCode: 'US', marketSector: 'Equity', securityType: 'Common Stock' },
  { ticker: 'AAPL', exchCode: 'UN', marketSector: 'Equity', securityType: 'Common Stock' },
];

interface Job { idType: string; idValue: string }
type Answer = { data: unknown[] } | { error: string } | { warning: string };
interface Reply { status?: number; headers?: Record<string, string>; answers?: (job: Job) => Answer }

let requests: { jobs: Job[]; headers: Record<string, string>; at: number }[];
let replies: Reply[]; // consumed in order; the last one repeats
let table: Record<string, Answer>;

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const jobs = JSON.parse(String(init.body)) as Job[];
    requests.push({ jobs, headers: init.headers as Record<string, string>, at: Date.now() });
    const r = replies.length > 1 ? replies.shift()! : (replies[0] ?? {});
    const status = r.status ?? 200;
    const answer = r.answers ?? ((j: Job) => table[j.idValue] ?? { warning: 'No identifier found.' });
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(r.headers ?? {}),
      json: async () => jobs.map(answer),
    } as unknown as Response;
  }));
}

// Runs the worker to completion, advancing fake time through its sleeps.
async function drain() {
  let done = false;
  const p = drainFigiQueueForTest().then(() => { done = true; });
  for (let i = 0; i < 2000 && !done; i++) await vi.advanceTimersByTimeAsync(1000);
  await p;
}

const cusips = (n: number) => Array.from({ length: n }, (_, i) => ({ cusip: `12345${String(i).padStart(3, '0')}1` }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  cache.clear();
  requests = [];
  replies = [];
  table = { [APPLE_CUSIP]: { data: AAPL }, [APPLE_ISIN]: { data: AAPL } };
  delete process.env.OPENFIGI_API_KEY;
  resetFigiState();
  stubFetch();
});
afterEach(() => {
  resetFigiState();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete process.env.OPENFIGI_API_KEY;
});

describe('eligibility', () => {
  it('queries a CUSIP as ID_CUSIP, preferring it over the ISIN', async () => {
    queueTickerLookups([{ cusip: APPLE_CUSIP, isin: APPLE_ISIN }]);
    await drain();
    expect(requests).toHaveLength(1);
    expect(requests[0].jobs).toEqual([{ idType: 'ID_CUSIP', idValue: APPLE_CUSIP }]);
    expect(cache.has(`figi:CUSIP:${APPLE_CUSIP}`)).toBe(true);
    expect(knownTicker({ cusip: APPLE_CUSIP })).toBe('AAPL');
    expect(knownTicker({ cusip: APPLE_CUSIP, isin: APPLE_ISIN })).toBe('AAPL');
  });

  it('queries a US ISIN as ID_ISIN when there is no CUSIP', async () => {
    queueTickerLookups([{ isin: ` ${APPLE_ISIN.toLowerCase()} ` }]);
    await drain();
    expect(requests[0].jobs).toEqual([{ idType: 'ID_ISIN', idValue: APPLE_ISIN }]);
    expect(knownTicker({ isin: APPLE_ISIN })).toBe('AAPL');
  });

  it('rejects foreign ISINs and malformed / placeholder ids without a request', async () => {
    const bad = [
      { isin: 'JP3633400001' }, { isin: 'US037833100' }, { cusip: '03783310' },
      { cusip: '000000000' }, { cusip: 'N/A' }, {},
    ];
    queueTickerLookups(bad);
    await drain();
    expect(requests).toHaveLength(0);
    for (const id of bad) expect(knownTicker(id)).toBeUndefined();
    expect(figiStatus().pending).toBe(0);
  });
});

describe('pickTicker', () => {
  it('prefers the US composite equity listing', () => {
    expect(pickTicker([
      { ticker: 'XYZ', exchCode: 'GR', marketSector: 'Equity', securityType: 'Common Stock' },
      { ticker: 'abc', exchCode: 'US', marketSector: 'Equity', securityType: 'Common Stock' },
    ])).toBe('ABC');
  });

  it('prefers common stock / funds over warrants, rights and preferreds', () => {
    expect(pickTicker([
      { ticker: 'ABC.WS', exchCode: 'US', marketSector: 'Equity', securityType: 'Warrant' },
      { ticker: 'ABC/P', exchCode: 'US', marketSector: 'Equity', securityType: 'Preference' },
      { ticker: 'ABCX', exchCode: 'US', marketSector: 'Equity', securityType: 'ETP' },
    ])).toBe('ABCX');
  });

  it('converts share-class slashes to Yahoo style', () => {
    expect(pickTicker([{ ticker: 'BRK/B', exchCode: 'US', marketSector: 'Equity', securityType: 'Common Stock' }])).toBe('BRK-B');
  });

  it('returns null with no US listing', () => {
    expect(pickTicker([{ ticker: '7203', exchCode: 'JT', marketSector: 'Equity', securityType: 'Common Stock' }])).toBeNull();
    expect(pickTicker([])).toBeNull();
  });

  it('caches null when the mapping has no US listing', async () => {
    table['123456781'] = { data: [{ ticker: 'FOO', exchCode: 'LN', marketSector: 'Equity', securityType: 'Common Stock' }] };
    queueTickerLookups([{ cusip: '123456781' }]);
    await drain();
    expect(knownTicker({ cusip: '123456781' })).toBeNull();
    expect(cache.get('figi:CUSIP:123456781')?.payload).toEqual({ ticker: null });
  });
});

describe('cache TTLs', () => {
  it('keeps a ticker for 90 days', () => {
    cache.set(`figi:CUSIP:${APPLE_CUSIP}`, { fetchedAt: T0, payload: { ticker: 'AAPL' } });
    vi.setSystemTime(T0 + HIT_TTL_MS - DAY);
    expect(knownTicker({ cusip: APPLE_CUSIP })).toBe('AAPL');
    vi.setSystemTime(T0 + HIT_TTL_MS + 1);
    expect(knownTicker({ cusip: APPLE_CUSIP })).toBeUndefined();
  });

  it('keeps "no ticker" for 30 days, then queues it again', async () => {
    cache.set('figi:CUSIP:123456781', { fetchedAt: T0, payload: { ticker: null } });
    vi.setSystemTime(T0 + MISS_TTL_MS - DAY);
    expect(knownTicker({ cusip: '123456781' })).toBeNull();
    queueTickerLookups([{ cusip: '123456781' }]);
    await drain();
    expect(requests).toHaveLength(0);

    vi.setSystemTime(T0 + MISS_TTL_MS + 1);
    expect(knownTicker({ cusip: '123456781' })).toBeUndefined();
    queueTickerLookups([{ cusip: '123456781' }]);
    await drain();
    expect(requests).toHaveLength(1);
  });
});

describe('queueing', () => {
  it('dedupes against the pending queue and the cache', async () => {
    queueTickerLookups([{ cusip: APPLE_CUSIP }, { cusip: APPLE_CUSIP }]);
    queueTickerLookups([{ cusip: APPLE_CUSIP, isin: APPLE_ISIN }]);
    expect(figiStatus().pending).toBe(1);
    await drain();
    expect(requests).toHaveLength(1);
    expect(requests[0].jobs).toHaveLength(1);

    queueTickerLookups([{ cusip: APPLE_CUSIP }, { isin: APPLE_ISIN, cusip: APPLE_CUSIP }]);
    await drain();
    expect(requests).toHaveLength(1);
    expect(figiStatus()).toMatchObject({ pending: 0, resolved: 1, lastError: null, keyed: false });
  });

  it('batches 10 jobs per request without a key', async () => {
    queueTickerLookups(cusips(25));
    await drain();
    expect(requests.map(r => r.jobs.length)).toEqual([10, 10, 5]);
    expect(requests[0].headers['X-OPENFIGI-APIKEY']).toBeUndefined();
    expect(figiStatus().resolved).toBe(25);
  });

  it('batches 100 jobs per request and sends the key header with a key', async () => {
    process.env.OPENFIGI_API_KEY = 'test-key';
    queueTickerLookups(cusips(25));
    await drain();
    expect(requests).toHaveLength(1);
    expect(requests[0].jobs).toHaveLength(25);
    expect(requests[0].headers['X-OPENFIGI-APIKEY']).toBe('test-key');
    expect(figiStatus().keyed).toBe(true);
  });

  it('stays at or under 20 requests a minute without a key', async () => {
    queueTickerLookups(cusips(210)); // 21 requests
    await drain();
    expect(requests).toHaveLength(21);
    expect(requests[20].at - requests[0].at).toBeGreaterThanOrEqual(60_000);
    expect(requests[19].at - requests[0].at).toBeLessThan(60_000);
  });
});

describe('failures', () => {
  it('a 429 is not cached; the batch is retried after ratelimit-reset', async () => {
    replies = [{ status: 429, headers: { 'ratelimit-reset': '30' } }, {}];
    queueTickerLookups([{ cusip: APPLE_CUSIP }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toHaveLength(1);
    expect(cache.size).toBe(0);
    expect(knownTicker({ cusip: APPLE_CUSIP })).toBeUndefined();
    expect(figiStatus().lastError).toMatch(/429/);
    expect(figiStatus().pending).toBe(1);

    await vi.advanceTimersByTimeAsync(29_000);
    expect(requests).toHaveLength(1); // still waiting out the reset
    await drain();
    expect(requests).toHaveLength(2);
    expect(requests[1].at - requests[0].at).toBeGreaterThanOrEqual(30_000);
    expect(knownTicker({ cusip: APPLE_CUSIP })).toBe('AAPL');
    expect(figiStatus().lastError).toBeNull();
  });

  it('a 5xx is not cached and gives up after a few tries', async () => {
    replies = [{ status: 503 }];
    queueTickerLookups([{ cusip: APPLE_CUSIP }]);
    await drain();
    expect(requests).toHaveLength(3);
    expect(cache.size).toBe(0);
    expect(figiStatus()).toMatchObject({ pending: 0, lastError: 'OpenFIGI HTTP 503' });
    // Dropped ids can be queued again by a later load.
    replies = [{}];
    queueTickerLookups([{ cusip: APPLE_CUSIP }]);
    await drain();
    expect(knownTicker({ cusip: APPLE_CUSIP })).toBe('AAPL');
  });

  it('a network error is not cached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));
    queueTickerLookups([{ cusip: APPLE_CUSIP }]);
    await drain();
    expect(cache.size).toBe(0);
    expect(figiStatus().lastError).toMatch(/ECONNRESET/);
  });

  it('per-job error / warning caches "no ticker"', async () => {
    table['123456781'] = { error: 'No identifier found.' };
    table['123456782'] = { warning: 'No identifier found.' };
    queueTickerLookups([{ cusip: '123456781' }, { cusip: '123456782' }, { cusip: APPLE_CUSIP }]);
    await drain();
    expect(knownTicker({ cusip: '123456781' })).toBeNull();
    expect(knownTicker({ cusip: '123456782' })).toBeNull();
    expect(knownTicker({ cusip: APPLE_CUSIP })).toBe('AAPL');
  });
});

describe('knownTicker', () => {
  it('never touches the network', () => {
    expect(knownTicker({ cusip: APPLE_CUSIP })).toBeUndefined();
    expect(knownTicker({ isin: APPLE_ISIN })).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    expect(figiStatus().pending).toBe(0);
  });

  it('queueTickerLookups does not call fetch synchronously', () => {
    queueTickerLookups([{ cusip: APPLE_CUSIP }]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
