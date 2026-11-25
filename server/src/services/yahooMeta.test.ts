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

  it('re-fetches a cached answer after the ~24h TTL', async () => {
    vi.useFakeTimers();
    try {
      stubFetch(() => ({ body: OK_BODY }));
      await fetchSecurityMeta('AAPL');
      vi.setSystemTime(Date.now() + 23 * 3600 * 1000);
      await fetchSecurityMeta('AAPL');
      expect(quoteCalls).toBe(1);
      vi.setSystemTime(Date.now() + 2 * 3600 * 1000);
      await fetchSecurityMeta('AAPL');
      expect(quoteCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it('opens one Yahoo session and one lookup per symbol when many callers ask at once', async () => {
    let crumbCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('getcrumb')) { crumbCalls++; return { ok: true, text: async () => 'crumb123' } as unknown as Response; }
      if (!u.includes('quoteSummary')) return { ok: true, headers: { getSetCookie: () => ['A=1; Path=/'] } } as unknown as Response;
      quoteCalls++;
      return { ok: true, status: 200, json: async () => OK_BODY } as unknown as Response;
    }));
    await Promise.all(['AAPL', 'MSFT', 'NVDA', 'AAPL', 'aapl'].map(s => fetchSecurityMeta(s)));
    expect(crumbCalls).toBe(1);   // one handshake, shared
    expect(quoteCalls).toBe(3);   // AAPL asked once, not three times
  });
});

// Shapes captured from Yahoo's quoteSummary topHoldings module (VFFVX, BND,
// 2026-11): positions are fractions of the whole fund; bondRatings is a list of
// single-key objects; us_government overlaps the letter ratings.
describe('fund composition and bond profile', () => {
  const r = (raw: number) => ({ raw, fmt: String(raw) });
  const TH_TARGET_DATE = {
    cashPosition: r(0.0191), stockPosition: r(0.8963), bondPosition: r(0.0838), otherPosition: r(0.0007),
    preferredPosition: r(0), convertiblePosition: r(0),
    bondRatings: [{ bb: r(0) }, { aa: r(0.5632) }, { aaa: r(0.1007) }, { a: r(0.194) }, { other: r(0.0063) }, { bbb: r(0.1356) }, { us_government: r(0.0515) }],
    bondHoldings: { maturity: {}, duration: r(3.69), maturityCat: r(8.1) },
  };

  it('parses the stock/bond/cash split as fractions summing to 1', async () => {
    const { parseComposition } = await import('./yahooMeta.js');
    const c = parseComposition(TH_TARGET_DATE)!;
    expect(c.stock).toBeCloseTo(0.8963, 3);
    expect(c.bond).toBeCloseTo(0.0838, 3);
    expect(c.stock + c.bond + c.cash + c.other).toBeCloseTo(1, 9);
  });

  it('folds preferred and convertible into bonds, and rejects junk', async () => {
    const { parseComposition } = await import('./yahooMeta.js');
    const c = parseComposition({ stockPosition: r(0.5), bondPosition: r(0.3), preferredPosition: r(0.15), convertiblePosition: r(0.05) })!;
    expect(c.bond).toBeCloseTo(0.5, 9);
    expect(parseComposition({ stockPosition: r(0), bondPosition: r(0) })).toBeNull();
    expect(parseComposition(undefined)).toBeNull();
  });

  it('keeps US-government share apart from the letter ratings', async () => {
    const { parseComposition, parseBondProfile } = await import('./yahooMeta.js');
    const b = parseBondProfile(TH_TARGET_DATE, parseComposition(TH_TARGET_DATE))!;
    expect(b.govShare).toBeCloseTo(0.0515, 4);
    expect(Object.values(b.ratings).reduce((a, x) => a + x, 0)).toBeCloseTo(1, 9);
    expect(b.ratings.AA).toBeGreaterThan(0.5);
    expect(b.ratings).not.toHaveProperty('BB'); // zero-weight buckets dropped
    expect(b.duration).toBe(3.69);
  });

  it('has no bond profile for an all-stock fund', async () => {
    const { parseComposition, parseBondProfile } = await import('./yahooMeta.js');
    const th = { stockPosition: r(0.996), cashPosition: r(0.004), bondRatings: [{ aaa: r(1) }] };
    expect(parseBondProfile(th, parseComposition(th))).toBeNull();
  });

  it('returns family, composition and bonds from fetchSecurityMeta', async () => {
    stubFetch(() => ({ body: { quoteSummary: { result: [{ quoteType: { quoteType: 'MUTUALFUND' }, fundProfile: { family: 'Vanguard' }, topHoldings: TH_TARGET_DATE }] } } }));
    const m = await fetchSecurityMeta('VFFVX');
    expect(m.family).toBe('Vanguard');
    expect(m.composition?.stock).toBeCloseTo(0.8963, 3);
    expect(m.bonds?.govShare).toBeCloseTo(0.0515, 4);
  });
});
