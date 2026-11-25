import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The cache is swapped for an in-memory map so this test never touches a
// database, and the SEC plumbing (edgarHoldings.ts) for a fake fetchJson so it
// never touches the network. The fake cachedMapping mirrors the real one's
// contract: a failed download yields an empty map rather than throwing.
const cache = new Map<string, { fetchedAt: number; payload: unknown }>();
vi.mock('../db/providerCache.js', () => ({
  readProviderCache: (k: string) => cache.get(k) ?? null,
  writeProviderCache: (k: string, e: { fetchedAt: number; payload: unknown }) => { cache.set(k, e); },
}));

const fetchJson = vi.fn<(url: string) => Promise<unknown>>();
vi.mock('./edgarHoldings.js', () => {
  class EdgarError extends Error {
    constructor(message: string, readonly kind: string, readonly status?: number) { super(message); }
  }
  return {
    EdgarError,
    fetchJson: (url: string) => fetchJson(url),
    edgarUserAgent: () => {
      const email = process.env.SEC_CONTACT_EMAIL?.trim();
      return email ? `KevFin ${email}` : null;
    },
    cachedMapping: <T>(url: string, parse: (raw: unknown) => Map<string, T>) => {
      let map: Map<string, T> | null = null;
      return {
        get: async () => {
          if (map) return map;
          try { map = parse(await fetchJson(url)); return map; } catch { return new Map<string, T>(); }
        },
        reset: () => { map = null; },
        lastFetch: () => null,
        failureSuffix: () => '',
      };
    },
  };
});

import { EdgarError } from './edgarHoldings.js';
const mod = await import('./secCompany.js');
const { fetchSecCompanyProfile, sicToSector, edgarLocationToCountry, resetSecCompanyState, CACHE_PREFIX } = mod;

const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const TICKERS = {
  0: { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' },
  1: { cik_str: 1067983, ticker: 'BRK-B', title: 'BERKSHIRE HATHAWAY INC' },
  2: { cik_str: 1114448, ticker: 'SHOP', title: 'Shopify Inc.' },
  3: { cik_str: 1611983, ticker: 'LBTYA', title: 'Liberty Global Ltd.' },
};
const SUBMISSIONS: Record<string, unknown> = {
  '0000320193': {
    name: 'Apple Inc.', sic: '3571', sicDescription: 'Electronic Computers', stateOfIncorporation: 'CA',
    addresses: { business: { stateOrCountry: 'CA', stateOrCountryDescription: 'CA' } },
  },
  '0001067983': {
    name: 'BERKSHIRE HATHAWAY INC', sic: '6331', sicDescription: 'Fire, Marine & Casualty Insurance', stateOfIncorporation: 'DE',
    addresses: { business: { stateOrCountry: 'NE', stateOrCountryDescription: 'NE' } },
  },
  '0001114448': {
    name: 'Shopify Inc.', sic: '7372', sicDescription: 'Services-Prepackaged Software', stateOfIncorporation: 'A6',
    addresses: { business: { stateOrCountry: 'A6', stateOrCountryDescription: 'ONTARIO, CANADA' } },
  },
  // No business address: falls back to the (Bermuda) incorporation.
  '0001611983': {
    name: 'Liberty Global Ltd.', sic: '4841', sicDescription: 'Cable & Other Pay Television Services', stateOfIncorporation: 'D0',
    addresses: { business: { stateOrCountry: null } },
  },
};

let submissionCalls: number;
function stubSec(fail?: (url: string) => Error | null) {
  fetchJson.mockImplementation(async (url: string) => {
    const err = fail?.(url);
    if (err) throw err;
    if (url === TICKERS_URL) return TICKERS;
    const m = url.match(/^https:\/\/data\.sec\.gov\/submissions\/CIK(\d{10})\.json$/);
    if (!m) throw new Error(`unexpected url ${url}`);
    submissionCalls++;
    const body = SUBMISSIONS[m[1]];
    if (!body) throw new EdgarError(`EDGAR HTTP 404 for ${url}`, 'http', 404);
    return body;
  });
}

const DAY = 24 * 3600 * 1000;
const T0 = 1_700_000_000_000;

beforeEach(() => {
  cache.clear();
  fetchJson.mockReset();
  submissionCalls = 0;
  resetSecCompanyState();
  process.env.SEC_CONTACT_EMAIL = 'test@example.com';
  vi.spyOn(Date, 'now').mockReturnValue(T0);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.SEC_CONTACT_EMAIL;
  vi.restoreAllMocks();
});

describe('sicToSector', () => {
  const cases: [string, number[]][] = [
    ['Technology', [3571, 3572, 3576, 3577, 3661, 3663, 3669, 3674, 3679, 7370, 7372, 7374, 7379]],
    ['Healthcare', [2834, 2835, 2836, 3841, 3842, 3845, 8000, 8062, 8099]],
    ['Financial Services', [6000, 6021, 6022, 6141, 6199, 6211, 6311, 6331, 6411]],
    ['Real Estate', [6798, 6500, 6512, 6531, 6552, 6553]],
    ['Utilities', [4900, 4911, 4931, 4941, 4991]],
    ['Communication Services', [4899, 4813, 4812, 4841, 7812, 7819, 2711]],
    ['Energy', [1311, 1381, 2911, 2990]],
    ['Consumer Defensive', [2000, 2080, 2086, 2111, 5411, 5400, 5499, 2840, 2844]],
    ['Consumer Cyclical', [3711, 3714, 5311, 5651, 5961, 5812, 7011, 7990]],
    ['Basic Materials', [2800, 2821, 2829, 1000, 1040, 2621, 3312, 3334]],
    ['Industrials', [3721, 3728, 3743, 3530, 3560, 4011, 4213, 4512, 1600, 1731, 7380, 7381, 7389]],
  ];
  for (const [sector, sics] of cases) {
    it(`maps ${sics.join(', ')} to ${sector}`, () => {
      for (const sic of sics) expect([sic, sicToSector(sic)]).toEqual([sic, sector]);
    });
  }

  it('has no sector for blank checks, unknown codes and missing values', () => {
    expect(sicToSector(6770)).toBeNull();
    expect(sicToSector(9995)).toBeNull();
    expect(sicToSector(99)).toBeNull();
    expect(sicToSector(0)).toBeNull();
    expect(sicToSector(null)).toBeNull();
    expect(sicToSector(3571.5)).toBeNull();
  });
});

describe('edgarLocationToCountry', () => {
  it('maps US states, DC and X1 to the United States', () => {
    for (const c of ['CA', 'NY', 'DE', 'TX', 'WA', 'DC', 'X1', 'ga']) expect(edgarLocationToCountry(c)).toBe('United States');
  });

  it('maps provinces to Canada and foreign codes to the app\'s country names', () => {
    expect(edgarLocationToCountry('A6')).toBe('Canada');
    expect(edgarLocationToCountry('A1')).toBe('Canada');
    expect(edgarLocationToCountry('B0')).toBe('Canada');
    expect(edgarLocationToCountry('Z4')).toBe('Canada');
    expect(edgarLocationToCountry('X0')).toBe('United Kingdom');
    expect(edgarLocationToCountry('M5')).toBe('South Korea');
    expect(edgarLocationToCountry('K3')).toBe('Hong Kong');
    expect(edgarLocationToCountry('E9')).toBe('Cayman Islands');
    expect(edgarLocationToCountry('D0')).toBe('Bermuda');
    expect(edgarLocationToCountry('2M')).toBe('Germany');
    expect(edgarLocationToCountry('L2')).toBe('Ireland');
    expect(edgarLocationToCountry('F4')).toBe('China');
    expect(edgarLocationToCountry('F5')).toBe('Taiwan');
    expect(edgarLocationToCountry('1Z')).toBe('Russia');
    expect(edgarLocationToCountry('Q1')).toBe('Vietnam');
    expect(edgarLocationToCountry('W8')).toBe('Turkey');
    expect(edgarLocationToCountry('PR')).toBe('Puerto Rico');
  });

  it('returns null for unknown or missing codes', () => {
    expect(edgarLocationToCountry('XX')).toBeNull();
    expect(edgarLocationToCountry('P8')).toBeNull();
    expect(edgarLocationToCountry('ZZ')).toBeNull();
    expect(edgarLocationToCountry('')).toBeNull();
    expect(edgarLocationToCountry(null)).toBeNull();
    expect(edgarLocationToCountry(undefined)).toBeNull();
  });
});

describe('fetchSecCompanyProfile', () => {
  it('returns null without any request when no contact email is set', async () => {
    delete process.env.SEC_CONTACT_EMAIL;
    stubSec();
    expect(await fetchSecCompanyProfile('AAPL')).toBeNull();
    expect(fetchJson).not.toHaveBeenCalled();
    expect(cache.size).toBe(0);
  });

  it('resolves ticker → CIK → profile with sector and country', async () => {
    stubSec();
    expect(await fetchSecCompanyProfile('aapl')).toEqual({
      cik: 320193, name: 'Apple Inc.', sic: 3571, sicDescription: 'Electronic Computers',
      sector: 'Technology', country: 'United States',
    });
    expect(fetchJson).toHaveBeenCalledWith('https://data.sec.gov/submissions/CIK0000320193.json');
    expect((await fetchSecCompanyProfile('SHOP'))?.country).toBe('Canada');
  });

  it('prefers the business address, and uses incorporation only when it is missing', async () => {
    stubSec();
    const brk = await fetchSecCompanyProfile('BRK-B');
    expect(brk?.country).toBe('United States'); // Nebraska office, Delaware incorporation
    const lbty = await fetchSecCompanyProfile('LBTYA');
    expect(lbty).toMatchObject({ country: 'Bermuda', sector: 'Communication Services' });
  });

  it('normalizes share-class tickers to SEC\'s dash form', async () => {
    stubSec();
    expect((await fetchSecCompanyProfile('BRK.B'))?.cik).toBe(1067983);
    expect((await fetchSecCompanyProfile('brk/b'))?.cik).toBe(1067983);
    expect(submissionCalls).toBe(1); // all three spellings share one cache entry
    expect(cache.has(CACHE_PREFIX + 'BRK-B')).toBe(true);
  });

  it('caches a profile for 30 days', async () => {
    stubSec();
    await fetchSecCompanyProfile('AAPL');
    expect(cache.get(CACHE_PREFIX + 'AAPL')?.fetchedAt).toBe(T0);
    vi.mocked(Date.now).mockReturnValue(T0 + 29 * DAY);
    expect((await fetchSecCompanyProfile('AAPL'))?.sector).toBe('Technology');
    expect(submissionCalls).toBe(1);
    vi.mocked(Date.now).mockReturnValue(T0 + 31 * DAY);
    expect((await fetchSecCompanyProfile('AAPL'))?.sector).toBe('Technology');
    expect(submissionCalls).toBe(2);
  });

  it('caches "not an SEC registrant" for 7 days', async () => {
    stubSec();
    expect(await fetchSecCompanyProfile('NOPE')).toBeNull();
    expect(cache.get(CACHE_PREFIX + 'NOPE')?.payload).toEqual({ company: null });
    const mappingFetches = () => fetchJson.mock.calls.filter(([u]) => u === TICKERS_URL).length;
    resetSecCompanyState(); // forget the in-memory mapping, so a re-check would show as a download
    vi.mocked(Date.now).mockReturnValue(T0 + 6 * DAY);
    expect(await fetchSecCompanyProfile('NOPE')).toBeNull();
    expect(mappingFetches()).toBe(1);
    vi.mocked(Date.now).mockReturnValue(T0 + 8 * DAY);
    expect(await fetchSecCompanyProfile('NOPE')).toBeNull();
    expect(mappingFetches()).toBe(2);
  });

  it('does not cache a failed lookup', async () => {
    stubSec(url => (url.includes('submissions') ? new EdgarError('EDGAR HTTP 429', 'http', 429) : null));
    expect(await fetchSecCompanyProfile('AAPL')).toBeNull();
    expect(cache.has(CACHE_PREFIX + 'AAPL')).toBe(false);

    // Mapping download failing (network error) is transient too.
    resetSecCompanyState();
    stubSec(url => (url === TICKERS_URL ? new Error('ECONNRESET') : null));
    expect(await fetchSecCompanyProfile('AAPL')).toBeNull();
    expect(cache.size).toBe(0);

    // …and the next call retries and succeeds.
    stubSec();
    expect((await fetchSecCompanyProfile('AAPL'))?.cik).toBe(320193);
    expect(cache.has(CACHE_PREFIX + 'AAPL')).toBe(true);
  });

  it('keeps serving an expired profile when the refresh fails', async () => {
    stubSec();
    await fetchSecCompanyProfile('AAPL');
    vi.mocked(Date.now).mockReturnValue(T0 + 31 * DAY);
    stubSec(url => (url.includes('submissions') ? new Error('ECONNRESET') : null));
    expect((await fetchSecCompanyProfile('AAPL'))?.sector).toBe('Technology');
    expect(cache.get(CACHE_PREFIX + 'AAPL')?.fetchedAt).toBe(T0); // untouched, so the next call retries
  });

  it('shares one lookup between concurrent calls for the same ticker', async () => {
    stubSec();
    const [a, b, c] = await Promise.all([
      fetchSecCompanyProfile('AAPL'), fetchSecCompanyProfile('aapl'), fetchSecCompanyProfile(' AAPL '),
    ]);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(submissionCalls).toBe(1);
  });

  it('returns null for a blank ticker without calling out', async () => {
    stubSec();
    expect(await fetchSecCompanyProfile('  ')).toBeNull();
    expect(fetchJson).not.toHaveBeenCalled();
  });
});
