import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// fetchSecurityMeta memoizes per symbol in a module-level Map, so each test
// re-imports the module (vi.resetModules) to start from a cold cache.
let fetchSecurityMeta: typeof import('./yahooMeta.js').fetchSecurityMeta;
let quoteCalls: number;

// getSession() fetches cookies + a crumb before every quoteSummary request;
// those are stubbed here so only the quoteSummary calls are counted.
function stubFetch(quoteResponder: () => { status?: number; ok?: boolean; body?: unknown }) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes('getcrumb')) return { ok: true, text: async () => 'crumb123' } as unknown as Response;
    if (!u.includes('quoteSummary')) return { ok: true, headers: { getSetCookie: () => ['A=1; Path=/'] } } as unknown as Response;
    quoteCalls++;
    const r = quoteResponder();
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => r.body ?? {},
    } as unknown as Response;
  }));
}

const OK_BODY = {
  quoteSummary: { result: [{ quoteType: { quoteType: 'EQUITY' }, assetProfile: { sector: 'Technology', country: 'United States' } }] },
};

beforeEach(async () => {
  quoteCalls = 0;
  vi.resetModules();
  ({ fetchSecurityMeta } = await import('./yahooMeta.js'));
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('fetchSecurityMeta', () => {
  it('parses quote type, sector and country', async () => {
    stubFetch(() => ({ body: OK_BODY }));
    const m = await fetchSecurityMeta('aapl');
    expect(m).toMatchObject({ quoteType: 'EQUITY', sector: 'Technology', country: 'United States' });
  });

  it('caches a successful lookup', async () => {
    stubFetch(() => ({ body: OK_BODY }));
    await fetchSecurityMeta('AAPL');
    await fetchSecurityMeta('AAPL');
    expect(quoteCalls).toBe(1);
  });

  // The allocation view fetches every symbol at once, so Yahoo throttling is
  // routine. Memoizing that empty answer pinned the holding to Uncategorized
  // for the rest of the process lifetime.
  it('does not cache a throttled response', async () => {
    let first = true;
    stubFetch(() => {
      if (first) { first = false; return { ok: false, status: 429 }; }
      return { body: OK_BODY };
    });

    expect(await fetchSecurityMeta('AAPL')).toMatchObject({ quoteType: null });
    expect(await fetchSecurityMeta('AAPL')).toMatchObject({ quoteType: 'EQUITY' });
    expect(quoteCalls).toBe(2);
  });

  it('does not cache a server error or a network failure', async () => {
    stubFetch(() => ({ ok: false, status: 503 }));
    await fetchSecurityMeta('AAPL');
    await fetchSecurityMeta('AAPL');
    expect(quoteCalls).toBe(2);

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));
    expect(await fetchSecurityMeta('MSFT')).toMatchObject({ quoteType: null });
  });

  // A 404 (or a 200 with no result) is a real answer about the symbol — cache
  // it, or every allocation request re-asks Yahoo about a ticker it disowns.
  it('caches a conclusive "no such symbol"', async () => {
    stubFetch(() => ({ ok: false, status: 404 }));
    await fetchSecurityMeta('NOPE');
    await fetchSecurityMeta('NOPE');
    expect(quoteCalls).toBe(1);
  });

  it('caches an empty 200', async () => {
    stubFetch(() => ({ body: { quoteSummary: { result: [] } } }));
    await fetchSecurityMeta('EMPTY');
    await fetchSecurityMeta('EMPTY');
    expect(quoteCalls).toBe(1);
  });
});
