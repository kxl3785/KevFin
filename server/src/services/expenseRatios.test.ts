import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The cache and prefs store are swapped for in-memory maps so this test never
// touches a database; fetch is stubbed so it never touches the network.
const cache = new Map<string, { fetchedAt: number; payload: unknown }>();
const prefs = new Map<string, string>();
vi.mock('../db/providerCache.js', () => ({
  readProviderCache: (k: string) => cache.get(k) ?? null,
  writeProviderCache: (k: string, e: { fetchedAt: number; payload: unknown }) => { cache.set(k, e); },
}));
// The SEC fallback is stubbed: secFees.test.ts covers it. Defaults to "SEC has
// nothing", so the Yahoo-only tests below see exactly Yahoo's answer.
const secFee = vi.fn<(s: string) => Promise<{ ratio: number; asOf: string; form: string } | null>>();
vi.mock('./secFees.js', () => ({ fetchSecExpenseRatio: (s: string) => secFee(s) }));
vi.mock('./prefs.js', () => ({
  getAllPrefs: () => Object.fromEntries(prefs),
  setPref: (k: string, v: string) => { prefs.set(k, v); },
}));

let mod: typeof import('./expenseRatios.js');
let quoteCalls: number;
let lastUrl: string;

function stubFetch(responder: () => { status?: number; ok?: boolean; body?: unknown }) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes('getcrumb')) return { ok: true, text: async () => 'crumb123' } as unknown as Response;
    if (!u.includes('quoteSummary')) return { ok: true, headers: { getSetCookie: () => ['A=1; Path=/'] } } as unknown as Response;
    quoteCalls++;
    lastUrl = u;
    const r = responder();
    return { ok: r.ok ?? true, status: r.status ?? 200, json: async () => r.body ?? {} } as unknown as Response;
  }));
}

const FUND = { quoteSummary: { result: [{ fundProfile: { feesExpensesInvestment: { netExpRatio: { raw: 0.03, fmt: '0.03%' } } } }] } };
const DAY = 24 * 3600 * 1000;

beforeEach(async () => {
  cache.clear(); prefs.clear(); quoteCalls = 0; lastUrl = '';
  secFee.mockReset(); secFee.mockResolvedValue(null);
  vi.resetModules();
  mod = await import('./expenseRatios.js');
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('fetchExpenseRatio', () => {
  it('reads the ratio and sends only the ticker', async () => {
    stubFetch(() => ({ body: FUND }));
    expect(await mod.fetchExpenseRatio('vti')).toBeCloseTo(0.0003, 10);
    expect(lastUrl).toContain('/quoteSummary/VTI?modules=fundProfile,defaultKeyStatistics&crumb=crumb123');
  });

  it('caches a found ratio for ~30 days', async () => {
    stubFetch(() => ({ body: FUND }));
    const t0 = 1_700_000_000_000;
    await mod.fetchExpenseRatio('VTI', t0);
    await mod.fetchExpenseRatio('VTI', t0 + 29 * DAY);
    expect(quoteCalls).toBe(1);
    await mod.fetchExpenseRatio('VTI', t0 + 31 * DAY);
    expect(quoteCalls).toBe(2);
  });

  it('caches "no figure" for a week, and reports it as unknown (null), not zero', async () => {
    stubFetch(() => ({ body: { quoteSummary: { result: [{}] } } }));
    const t0 = 1_700_000_000_000;
    expect(await mod.fetchExpenseRatio('ABC', t0)).toBeNull();
    expect(await mod.fetchExpenseRatio('ABC', t0 + 6 * DAY)).toBeNull();
    expect(quoteCalls).toBe(1);
    await mod.fetchExpenseRatio('ABC', t0 + 8 * DAY);
    expect(quoteCalls).toBe(2);
  });

  it('caches a 404 but not a throttle, an outage or a network failure', async () => {
    stubFetch(() => ({ ok: false, status: 404 }));
    await mod.fetchExpenseRatio('NOPE');
    await mod.fetchExpenseRatio('NOPE');
    expect(quoteCalls).toBe(1);

    let first = true;
    stubFetch(() => { if (first) { first = false; return { ok: false, status: 429 }; } return { body: FUND }; });
    expect(await mod.fetchExpenseRatio('VTI')).toBeNull();
    expect(await mod.fetchExpenseRatio('VTI')).toBeCloseTo(0.0003, 10);

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));
    expect(await mod.fetchExpenseRatio('MSFT')).toBeNull();
    expect(cache.has(mod.CACHE_PREFIX + 'MSFT')).toBe(false);
  });

  it('keeps serving an expired figure when the refresh is throttled, fails or errors', async () => {
    const t0 = 1_700_000_000_000;
    stubFetch(() => ({ body: FUND }));
    expect(await mod.fetchExpenseRatio('VTI', t0)).toBeCloseTo(0.0003, 10);
    // Day 31: past the 30-day TTL. A 429, a 503 and a network error all serve
    // the last known 0.03% instead of "unknown", and leave fetchedAt alone so
    // the next request retries.
    stubFetch(() => ({ ok: false, status: 429 }));
    expect(await mod.fetchExpenseRatio('VTI', t0 + 31 * DAY)).toBeCloseTo(0.0003, 10);
    stubFetch(() => ({ ok: false, status: 503 }));
    expect(await mod.fetchExpenseRatio('VTI', t0 + 31 * DAY)).toBeCloseTo(0.0003, 10);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));
    expect(await mod.fetchExpenseRatio('VTI', t0 + 31 * DAY)).toBeCloseTo(0.0003, 10);
    expect(cache.get(mod.CACHE_PREFIX + 'VTI')!.fetchedAt).toBe(t0);
    // A conclusive answer still replaces it, including one that now has no figure.
    stubFetch(() => ({ body: { quoteSummary: { result: [{}] } } }));
    expect(await mod.fetchExpenseRatio('VTI', t0 + 32 * DAY)).toBeNull();
    expect(cache.get(mod.CACHE_PREFIX + 'VTI')).toEqual({ fetchedAt: t0 + 32 * DAY, payload: { ratio: null } });
  });

  it('does not read ratios cached under the old (rounded) key', async () => {
    cache.set('expense_ratio:FXAIX', { fetchedAt: Date.now(), payload: { ratio: 0.0001 } });
    stubFetch(() => ({ body: { quoteSummary: { result: [{ fundProfile: { feesExpensesInvestment: { netExpRatio: { raw: 0.00015, fmt: '0.01%' } } } }] } } }));
    expect(await mod.fetchExpenseRatio('FXAIX')).toBe(0.00015);
    expect(quoteCalls).toBe(1);
  });

  it('refreshes the crumb once on a 401', async () => {
    let n = 0;
    stubFetch(() => (n++ === 0 ? { ok: false, status: 401 } : { body: FUND }));
    expect(await mod.fetchExpenseRatio('VTI')).toBeCloseTo(0.0003, 10);
    expect(quoteCalls).toBe(2);
  });

  it('returns null for an empty symbol without calling out', async () => {
    stubFetch(() => ({ body: FUND }));
    expect(await mod.fetchExpenseRatio('  ')).toBeNull();
    expect(quoteCalls).toBe(0);
  });
});

describe('lookupExpenseRatio (Yahoo, then SEC)', () => {
  const SEC = { ratio: 0.0014, asOf: '2026-06-30', form: 'N-CSRS' };

  it('uses Yahoo when it has a figure, without asking SEC', async () => {
    stubFetch(() => ({ body: FUND }));
    secFee.mockResolvedValue(SEC);
    expect(await mod.lookupExpenseRatio('VTI')).toEqual({ ratio: 0.0003, provider: 'yahoo' });
    expect(secFee).not.toHaveBeenCalled();
  });

  it('a free fund (Yahoo says 0) is still Yahoo\'s answer', async () => {
    stubFetch(() => ({ body: { quoteSummary: { result: [{ fundProfile: { feesExpensesInvestment: { netExpRatio: { raw: 0, fmt: '0.00%' } } } }] } } }));
    expect(await mod.lookupExpenseRatio('FZROX')).toEqual({ ratio: 0, provider: 'yahoo' });
    expect(secFee).not.toHaveBeenCalled();
  });

  it('falls back to the SEC shareholder report when Yahoo has no figure', async () => {
    stubFetch(() => ({ body: { quoteSummary: { result: [{}] } } }));
    secFee.mockResolvedValue(SEC);
    expect(await mod.lookupExpenseRatio('vfinx')).toEqual({ ratio: 0.0014, provider: 'sec', asOf: '2026-06-30' });
    expect(secFee).toHaveBeenCalledWith('vfinx');
    expect(await mod.fetchExpenseRatio('VFINX')).toBe(0.0014);
  });

  it('falls back to SEC when the Yahoo lookup fails', async () => {
    stubFetch(() => ({ ok: false, status: 429 }));
    secFee.mockResolvedValue(SEC);
    expect(await mod.lookupExpenseRatio('VFINX')).toMatchObject({ ratio: 0.0014, provider: 'sec' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));
    expect(await mod.lookupExpenseRatio('VFIAX')).toMatchObject({ ratio: 0.0014, provider: 'sec' });
  });

  it('is unknown when neither has a figure, or SEC answers out of range or throws', async () => {
    stubFetch(() => ({ body: { quoteSummary: { result: [{}] } } }));
    expect(await mod.lookupExpenseRatio('MYST')).toBeNull();
    secFee.mockResolvedValue({ ratio: 0.2, asOf: '2026-06-30', form: 'N-CSR' });
    expect(await mod.lookupExpenseRatio('MYST')).toBeNull();
    secFee.mockRejectedValue(new Error('boom'));
    expect(await mod.lookupExpenseRatio('MYST')).toBeNull();
  });

  it('asks neither provider for an empty symbol', async () => {
    stubFetch(() => ({ body: FUND }));
    expect(await mod.lookupExpenseRatio(' ')).toBeNull();
    expect(quoteCalls).toBe(0);
    expect(secFee).not.toHaveBeenCalled();
  });
});

describe('expense-ratio overrides', () => {
  it('sets, reads back and clears a figure in prefs', () => {
    mod.setExpenseOverride('VTI', 0.0004);
    mod.setExpenseOverride('Age-Based 2040 Portfolio', 0.0015);
    expect(mod.getExpenseOverrides()).toEqual({ VTI: 0.0004, 'Age-Based 2040 Portfolio': 0.0015 });
    mod.setExpenseOverride('VTI', null);
    expect(mod.getExpenseOverrides()).toEqual({ 'Age-Based 2040 Portfolio': 0.0015 });
    expect(prefs.has(mod.OVERRIDES_PREF)).toBe(true);
    expect(mod.OVERRIDES_PREF.startsWith('mon.')).toBe(true);
  });
});
