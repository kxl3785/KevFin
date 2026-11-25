import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// fetchDailyCloses memoizes in a module-level Map, so each test re-imports the
// module (vi.resetModules) to start from a cold cache.
let fetchDailyCloses: typeof import('./prices.js').fetchDailyCloses;
let calls: string[];

// A minimal Yahoo chart payload: two daily closes.
function chartResponse() {
  return {
    ok: true,
    json: async () => ({
      chart: {
        result: [{
          timestamp: [1_700_006_400, 1_700_092_800], // 2023-11-15, 2023-11-16
          indicators: {
            quote: [{ close: [100, 110] }],
            adjclose: [{ adjclose: [99, 109] }],
          },
        }],
      },
    }),
  };
}

beforeEach(async () => {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(String(url));
    return chartResponse() as unknown as Response;
  }));
  vi.resetModules();
  ({ fetchDailyCloses } = await import('./prices.js'));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchDailyCloses', () => {
  // Regression: the cache key (SYMBOL|start|end) was interpolated into the
  // request URL, so every fetch asked Yahoo for a symbol like "SPY%7C2021-07-28
  // %7C2026-07-27". That 404s, leaving every series empty — benchmarks vanished
  // and account performance lines flatlined at 100.
  it('requests the bare ticker, not the cache key', async () => {
    await fetchDailyCloses('spy', '2021-07-28', '2026-07-27');

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]);
    expect(url.pathname).toBe('/v8/finance/chart/SPY');
    expect(calls[0]).not.toContain('2021-07-28');   // dates ride in period1/2 only
    expect(url.searchParams.get('period1')).toBe('1627430400');
    expect(url.searchParams.get('period2')).toBe('1785110400');
  });

  it('parses closes and distribution-adjusted closes', async () => {
    const points = await fetchDailyCloses('SPY', '2023-11-01', '2023-11-30');
    expect(points).toEqual([
      { date: '2023-11-15', close: 100, adjClose: 99 },
      { date: '2023-11-16', close: 110, adjClose: 109 },
    ]);
  });

  it('caches per symbol AND range', async () => {
    await fetchDailyCloses('SPY', '2023-11-01', '2023-11-30');
    await fetchDailyCloses('SPY', '2023-11-01', '2023-11-30'); // served from cache
    expect(calls).toHaveLength(1);

    await fetchDailyCloses('SPY', '2020-01-01', '2023-11-30'); // different window
    expect(calls).toHaveLength(2);
  });

  it('does not cache a failed fetch', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(String(url));
      return calls.length === 1
        ? ({ ok: false } as unknown as Response)
        : (chartResponse() as unknown as Response);
    }));

    expect(await fetchDailyCloses('SPY', '2023-11-01', '2023-11-30')).toEqual([]);
    expect(await fetchDailyCloses('SPY', '2023-11-01', '2023-11-30')).toHaveLength(2);
    expect(calls).toHaveLength(2);
  });

  it('remembers a 404 (no such symbol) instead of asking again on every call', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(String(url));
      return { ok: false, status: 404 } as unknown as Response;
    }));

    expect(await fetchDailyCloses('NOSUCH', '2023-11-01', '2023-11-30')).toEqual([]);
    expect(await fetchDailyCloses('NOSUCH', '2023-11-01', '2023-11-30')).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('does not remember a throttle or outage', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(String(url));
      return { ok: false, status: 429 } as unknown as Response;
    }));

    await fetchDailyCloses('SPY', '2023-11-01', '2023-11-30');
    await fetchDailyCloses('SPY', '2023-11-01', '2023-11-30');
    expect(calls).toHaveLength(2);
  });

  it('shares one request between concurrent callers', async () => {
    const [a, b] = await Promise.all([
      fetchDailyCloses('SPY', '2023-11-01', '2023-11-30'),
      fetchDailyCloses('SPY', '2023-11-01', '2023-11-30'),
    ]);
    expect(calls).toHaveLength(1);
    expect(a).toEqual(b);
  });
});

// The user's description of a holding (holdingProfiles.ts) is read from prefs,
// so these run against a throwaway IN-MEMORY database (DB_PATH=':memory:' — no
// file is created), never the real data/kevfin.db.
describe('effectiveChain with a holding profile', () => {
  let prevDbPath: string | undefined;
  let effectiveChain: typeof import('./prices.js').effectiveChain;
  let setHoldingProfile: typeof import('./holdingProfiles.js').setHoldingProfile;
  let closeDb: () => void;

  beforeEach(async () => {
    prevDbPath = process.env.DB_PATH;
    process.env.DB_PATH = ':memory:';
    vi.resetModules();
    const schema = await import('../db/schema.js');
    expect(schema.DB_PATH).toBe(':memory:');
    ({ closeDb } = schema);
    ({ setHoldingProfile } = await import('./holdingProfiles.js'));
    ({ effectiveChain } = await import('./prices.js'));
  }, 60_000);

  afterEach(() => {
    closeDb();
    if (prevDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = prevDbPath;
  });

  it('falls back to the built-in rules when nothing is described', () => {
    expect(effectiveChain('PDZJ', 'BJC 401k Trust')).toEqual(['VFFVX']);
    expect(effectiveChain('', 'Target Enrollment 2040 Portfolio')).toEqual(['ITDD', 'AOA']);
    expect(effectiveChain('VTI', 'Vanguard Total Stock Market ETF')).toEqual(['VTI']);
  });

  it("uses the user's ticker over SYMBOL_SUBSTITUTIONS", () => {
    setHoldingProfile('PDZJ', [{ ticker: 'VTTSX', weight: 1 }]);
    expect(effectiveChain('PDZJ', 'BJC 401k Trust')).toEqual(['VTTSX']);
  });

  it("uses the heaviest part of the user's mix over PROXY_RULES (keyed by name when untickered)", () => {
    setHoldingProfile('Target Enrollment 2040 Portfolio', [{ ticker: 'BND', weight: 0.4 }, { ticker: 'VTI', weight: 0.6 }]);
    expect(effectiveChain('', 'Target Enrollment 2040 Portfolio')).toEqual(['VTI']);
    // Other untickered holdings still follow the rules.
    expect(effectiveChain('', 'Total Market Index Portfolio')).toEqual(['ITOT']);
  });

  it('reverts to the rules once the description is cleared', () => {
    setHoldingProfile('PDZJ', [{ ticker: 'VTTSX', weight: 1 }]);
    setHoldingProfile('PDZJ', null);
    expect(effectiveChain('PDZJ', 'BJC 401k Trust')).toEqual(['VFFVX']);
  });
});
