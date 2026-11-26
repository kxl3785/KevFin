import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SecurityMeta } from './yahooMeta.js';

// The fund-company lookups memoize in module-level Maps, so each test
// re-imports the module (vi.resetModules) to start cold. Yahoo metadata and
// EDGAR are stubbed: these tests are about the fallback chain and how often
// fund companies are asked.
const stubs = vi.hoisted(() => ({
  metas: new Map<string, unknown>(),
  edgar: new Map<string, unknown>(),
  masters: new Map<string, unknown>(), // series title → { seriesId, constituents } | Error
}));
vi.mock('./yahooMeta.js', () => ({
  fetchSecurityMeta: vi.fn(async (s: string) => stubs.metas.get(s.toUpperCase()) ?? {
    quoteType: null, sector: null, country: null, sectorWeightings: null, holdings: null, family: null, composition: null, bonds: null,
  }),
}));
vi.mock('./edgarHoldings.js', () => ({
  fetchEdgarConstituents: vi.fn(async (s: string) => stubs.edgar.get(s.toUpperCase()) ?? null),
  fetchMasterConstituents: vi.fn(async (ref: { series: string }) => {
    const m = stubs.masters.get(ref.series);
    if (m instanceof Error) throw m;
    return m ?? null;
  }),
  lump: (kind: 'bond' | 'cash' | 'other', percent: number) => ({ symbol: `— ${kind} —`, name: kind, percent, country: 'Bonds / Commodities / Cash', kind }),
}));

type Mod = typeof import('./fundHoldings.js');
let mod: Mod;
let calls: string[];

const meta = (m: Partial<SecurityMeta>): SecurityMeta => ({
  quoteType: 'MUTUALFUND', sector: null, country: null, sectorWeightings: null, holdings: null, family: null, composition: null, bonds: null, ...m,
});
const vgPage = (entity: object[], size = entity.length) => ({ ok: true, status: 200, json: async () => ({ size, fund: { entity } }) }) as unknown as Response;
const AAPL = { ticker: 'AAPL', shortName: 'APPLE INC', percentWeight: '6.70', isin: 'US0378331005', cusip: '037833100' };
const status = (code: number) => ({ ok: false, status: code, json: async () => ({}) }) as unknown as Response;

function stubFetch(responder: (url: string) => Response | Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => { calls.push(String(url)); return responder(String(url)); }));
}

beforeEach(async () => {
  calls = [];
  stubs.metas.clear();
  stubs.edgar.clear();
  stubs.masters.clear();
  vi.resetModules();
  mod = await import('./fundHoldings.js');
});

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('fetchVanguardStockHoldings', () => {
  it('reads the /vmf/api holdings with identifiers, and caches the hit', async () => {
    stubFetch(() => vgPage([AAPL]));
    const first = await mod.fetchVanguardStockHoldings('VTI');
    expect(first).toEqual([{ symbol: 'AAPL', name: 'APPLE INC', percent: 0.067, country: 'United States', isin: 'US0378331005', cusip: '037833100' }]);
    expect(calls[0]).toContain('/vmf/api/VTI/portfolio-holding/stock?start=1&count=2000');
    await mod.fetchVanguardStockHoldings('vti');
    expect(calls).toHaveLength(1);
  });

  it('follows pages until it has the whole fund', async () => {
    const page1 = Array.from({ length: 2000 }, (_, i) => ({ ticker: `T${i}`, percentWeight: '0.04' }));
    stubFetch(url => (url.includes('start=1&') ? vgPage(page1, 2500) : vgPage([AAPL], 2500)));
    const out = await mod.fetchVanguardStockHoldings('VTSAX');
    expect(out).toHaveLength(2001);
    expect(calls[1]).toContain('start=2001&count=2000');
  });

  it('treats Vanguard’s 200-with-error body as a firm "not ours" and remembers it', async () => {
    stubFetch(() => ({ ok: true, status: 200, json: async () => ({ response: 'error calling …', name: 'HttpException' }) }) as unknown as Response);
    expect(await mod.fetchVanguardStockHoldings('ABCDX')).toEqual([]);
    expect(await mod.fetchVanguardStockHoldings('ABCDX')).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('asks again once a "not found" is a few hours old', async () => {
    vi.useFakeTimers();
    stubFetch(() => status(404));
    await mod.fetchVanguardStockHoldings('VTI');
    vi.advanceTimersByTime(7 * 3600 * 1000);
    await mod.fetchVanguardStockHoldings('VTI');
    expect(calls).toHaveLength(2);
  });

  it('keeps a block or outage only for a couple of minutes, so the fund is not pinned empty', async () => {
    vi.useFakeTimers();
    let blocked = true;
    stubFetch(() => (blocked ? status(403) : vgPage([AAPL])));
    expect(await mod.fetchVanguardStockHoldings('VTI')).toEqual([]);
    expect(await mod.fetchVanguardStockHoldings('VTI')).toEqual([]); // still inside the short hold
    expect(calls).toHaveLength(1);
    blocked = false;
    vi.advanceTimersByTime(3 * 60 * 1000);
    expect(await mod.fetchVanguardStockHoldings('VTI')).toHaveLength(1);
  });

  it('shares one lookup between concurrent callers', async () => {
    stubFetch(() => vgPage([AAPL]));
    const [a, b] = await Promise.all([mod.fetchVanguardStockHoldings('VTI'), mod.fetchVanguardStockHoldings('VTI')]);
    expect(calls).toHaveLength(1);
    expect(a).toEqual(b);
  });

  it('falls back to the mutual-fund twin for an ETF class the API errors on', async () => {
    stubFetch(url => (url.includes('/VXUS/') ? status(404) : vgPage([AAPL])));
    expect(await mod.fetchVanguardStockHoldings('VXUS')).toHaveLength(1);
    expect(calls[1]).toContain('/VTIAX/');
  });
});

describe('parseSpdrSheet', () => {
  const rows = [
    ['Fund Name:', 'SPDR S&P 500 ETF Trust'], ['Ticker Symbol:', 'SPY'], ['Holdings:', 'As of 23-Nov-2026'],
    ['Name', 'Ticker', 'Identifier', 'SEDOL', 'Weight', 'Sector', 'Shares Held', 'Local Currency'],
    ['APPLE INC', 'AAPL', '037833100', '2046251', '8.15', '-', '1E8', 'USD'],
    ['BERKSHIRE HATHAWAY INC CL B', 'BRK.B', '084670702', 'x', '1.6', '-', '1', 'USD'],
    ['ACCENTURE PLC CL A', 'ACN', 'G1151C101', 'x', '0.4', '-', '1', 'USD'],
    ['US DOLLAR', '-', '-', '-', '0.2', '-', '1', 'USD'],
    [], ['Disclaimer text…'],
  ];

  it('reads holdings up to the first blank row, with US issuers marked by CUSIP', () => {
    const { out, usdShare } = mod.parseSpdrSheet(rows);
    expect(usdShare).toBe(1);
    expect(out.find(c => c.symbol === 'AAPL')).toMatchObject({ percent: 0.0815, cusip: '037833100', country: 'United States' });
    expect(out.find(c => c.symbol === 'BRK-B')).toBeDefined();
    expect(out.find(c => c.symbol === 'ACN')?.country).toBeUndefined(); // CINS (foreign issuer): country from N-PORT
    expect(out.find(c => c.kind === 'cash')?.percent).toBeCloseTo(0.002);
    expect(out.some(c => c.name.startsWith('Disclaimer'))).toBe(false);
  });

  it('reports the USD share so foreign-stock funds can be skipped', () => {
    const intl = [rows[3], ['TOYOTA', '7203', 'x', 'x', '5', '-', '1', 'JPY'], ['APPLE INC', 'AAPL', '037833100', 'x', '5', '-', '1', 'USD']];
    expect(mod.parseSpdrSheet(intl).usdShare).toBe(0.5);
  });

  it('returns nothing for a sheet without a holdings header (an error page)', () => {
    expect(mod.parseSpdrSheet([['Access denied']]).out).toEqual([]);
  });
});

describe('fetchDeepConstituents', () => {
  it('has nothing to look through for a single stock', async () => {
    stubs.metas.set('AAPL', meta({ quoteType: 'EQUITY' }));
    stubFetch(() => status(404));
    expect(await mod.fetchDeepConstituents('AAPL')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('adds a balanced Vanguard fund’s bonds and cash from its composition', async () => {
    stubs.metas.set('VBIAX', meta({ family: 'Vanguard', composition: { stock: 0.6, bond: 0.38, cash: 0.02, other: 0 } }));
    stubFetch(() => vgPage([{ ...AAPL, percentWeight: '57.0' }]));
    const list = (await mod.fetchDeepConstituents('VBIAX'))!;
    expect(list.find(c => c.symbol === 'AAPL')?.percent).toBeCloseTo(0.57);
    const nonStock = list.filter(c => c.kind).reduce((s, c) => s + c.percent, 0);
    expect(nonStock).toBeCloseTo(0.4, 5);
    expect(list.reduce((s, c) => s + c.percent, 0)).toBeLessThanOrEqual(1.0000001);
  });

  it('looks through a fund of funds via its underlying funds, bond funds by composition', async () => {
    stubs.metas.set('VFFVX', meta({
      family: 'Vanguard',
      holdings: [
        { symbol: 'VSMPX', name: 'Total Stock Inst Plus', percent: 0.55 },
        { symbol: 'VGTSX', name: 'Total Intl Stock', percent: 0.36 },
        { symbol: 'VTBIX', name: 'Total Bond II', percent: 0.09 },
      ],
    }));
    stubs.metas.set('VSMPX', meta({ family: 'Vanguard' }));
    stubs.metas.set('VGTSX', meta({ family: 'Vanguard' }));
    stubs.metas.set('VTBIX', meta({ family: 'Vanguard', composition: { stock: 0, bond: 0.98, cash: 0.02, other: 0 } }));
    stubFetch(url => {
      if (url.includes('/VFFVX/')) return vgPage([], 0); // the target-date fund itself has no stock list
      if (url.includes('/VSMPX/')) return vgPage([{ ...AAPL, percentWeight: '7.0' }]);
      if (url.includes('/VGTSX/')) return vgPage([{ ticker: '2330', shortName: 'TSMC', percentWeight: '4.0', isin: 'TW0002330008' }, { ...AAPL, percentWeight: '0.5' }]);
      return status(404);
    });
    const list = (await mod.fetchDeepConstituents('VFFVX'))!;
    expect(list.find(c => c.symbol === 'AAPL')?.percent).toBeCloseTo(0.55 * 0.07 + 0.36 * 0.005); // merged across sleeves
    expect(list.find(c => c.symbol === '2330')).toMatchObject({ country: 'Taiwan' });
    expect(list.find(c => c.kind === 'bond')?.percent).toBeCloseTo(0.09 * 0.98);
    expect(calls.some(u => u.includes('/VTBIX/'))).toBe(false); // bond fund: no download needed
  });

  it('ignores an ordinary stock fund’s top-10 list', async () => {
    stubs.metas.set('XYZ', meta({ holdings: [{ symbol: 'AAPL', name: 'Apple', percent: 0.5 }, { symbol: 'MSFT', name: 'Microsoft', percent: 0.4 }] }));
    stubs.metas.set('AAPL', meta({ quoteType: 'EQUITY' }));
    stubs.metas.set('MSFT', meta({ quoteType: 'EQUITY' }));
    stubFetch(() => status(404));
    expect(await mod.fetchDeepConstituents('XYZ')).toBeNull();
  });

  it('opens registered-fund holdings found in an N-PORT filing', async () => {
    stubs.metas.set('VTI', meta({ quoteType: 'ETF', family: 'Vanguard' }));
    stubs.edgar.set('ABCFX', [
      { symbol: 'VTI', name: 'Vanguard Total Stock Market', percent: 0.6, fund: true },
      { symbol: '— bond —', name: 'bond', percent: 0.4, kind: 'bond', country: 'Bonds / Commodities / Cash' },
    ]);
    stubFetch(url => (url.includes('/VTI/') ? vgPage([{ ...AAPL, percentWeight: '7.0' }]) : status(404)));
    const list = (await mod.fetchDeepConstituents('ABCFX'))!;
    expect(list.find(c => c.symbol === 'AAPL')?.percent).toBeCloseTo(0.042);
    expect(list.some(c => c.symbol === 'VTI')).toBe(false);
    expect(list.find(c => c.kind === 'bond')?.percent).toBeCloseTo(0.4);
  });

  it('asks for the documented sleeves of a fund-of-funds together, not one after another', async () => {
    const { FUND_OF_FUNDS } = await import('../util/assumptions.js');
    const [fof, def] = Object.entries(FUND_OF_FUNDS).find(([, d]) => d.constituents.filter(c => c.kind !== 'bond').length >= 2)!;
    const equitySleeves = def.constituents.filter(c => c.kind !== 'bond').length;
    let open = 0, maxOpen = 0;
    stubFetch(async url => {
      if (url.includes(`/${fof}/`)) return vgPage([], 0); // the fund-of-funds itself: no list
      open++; maxOpen = Math.max(maxOpen, open);
      await new Promise(r => setTimeout(r, 5));
      open--;
      return vgPage([AAPL]);
    });
    const list = await mod.fetchDeepConstituents(fof);
    expect(list?.some(c => c.symbol === 'AAPL')).toBe(true);
    expect(maxOpen).toBe(equitySleeves);
  });

  // A feeder (DFA's DFEMX) holds one thing: its master series, which has no
  // ticker. Shapes as parseNport gives them (see edgarMaster.test.ts).
  const masterRow = (series: string, percent: number) => ({
    symbol: series.replace(/^THE /, ''), name: series, percent, fund: true, named: true,
    master: { issuer: 'Dimensional Fund Advisors', series, ownerSeries: 'S000000957', ownerName: 'EMERGING MARKETS PORTFOLIO', ownerCik: '355437' },
  });

  it('opens a feeder fund into its master’s holdings, scaled by the feeder’s weight in it', async () => {
    stubs.edgar.set('DFEMX', [masterRow('THE EMERGING MARKETS SERIES', 1.0002)]);
    stubs.masters.set('THE EMERGING MARKETS SERIES', { seriesId: 'S000000992', constituents: [
      { symbol: 'TSM', name: 'Taiwan Semiconductor', percent: 0.5, country: 'Taiwan' },
      { symbol: 'TENCENT HOLDINGS', name: 'Tencent Holdings Ltd', percent: 0.3, country: 'China', named: true },
      { symbol: '— cash —', name: 'cash', percent: 0.2, kind: 'cash', country: 'Bonds / Commodities / Cash' },
    ] });
    stubFetch(() => status(404));
    const list = (await mod.fetchDeepConstituents('DFEMX'))!;
    expect(list.map(c => c.symbol)).toEqual(['TSM', 'TENCENT HOLDINGS', '— cash —']);
    expect(list.find(c => c.symbol === 'TSM')?.percent).toBeCloseTo(0.5, 3);
    expect(list.reduce((s, c) => s + c.percent, 0)).toBeCloseTo(1.0002, 6);
    expect(list.some(c => /Dimensional Fund Advisors|EMERGING MARKETS SERIES/i.test(`${c.symbol} ${c.name}`))).toBe(false);
  });

  it('scales a master that sums past 100% (collateral, accruals) back to the feeder’s weight', async () => {
    stubs.edgar.set('DFEMX', [masterRow('THE EMERGING MARKETS SERIES', 1)]);
    stubs.masters.set('THE EMERGING MARKETS SERIES', { seriesId: 'S1', constituents: [
      { symbol: 'TSM', name: 'TSMC', percent: 0.6 }, { symbol: 'SSNLF', name: 'Samsung', percent: 0.48 },
    ] });
    stubFetch(() => status(404));
    const list = (await mod.fetchDeepConstituents('DFEMX'))!;
    expect(list.reduce((s, c) => s + c.percent, 0)).toBeCloseTo(1, 9);
    expect(list.find(c => c.symbol === 'TSM')?.percent).toBeCloseTo(0.6 / 1.08, 9);
  });

  it('shows a master it can’t find as the fund itself, not as a stock named after its adviser', async () => {
    stubs.edgar.set('DFEMX', [masterRow('THE EMERGING MARKETS SERIES', 1)]);
    stubFetch(() => status(404));
    expect(await mod.fetchDeepConstituents('DFEMX')).toEqual([
      { symbol: 'DFEMX', name: 'Emerging Markets Portfolio', percent: 1, fund: true },
    ]);
    stubs.masters.set('THE EMERGING MARKETS SERIES', new Error('EDGAR HTTP 503')); // a failed lookup: same fallback
    vi.resetModules();
    mod = await import('./fundHoldings.js');
    expect((await mod.fetchDeepConstituents('DFEMX'))?.[0]).toMatchObject({ symbol: 'DFEMX', fund: true });
  });

  it('opens each master of a fund holding several, and never re-opens one already open (a loop)', async () => {
    stubs.edgar.set('DFISX', [masterRow('THE JAPANESE SMALL COMPANY SERIES', 0.4), masterRow('THE LOOPING SERIES', 0.6)]);
    stubs.masters.set('THE JAPANESE SMALL COMPANY SERIES', { seriesId: 'S2', constituents: [{ symbol: '7203', name: 'Toyota', percent: 1, country: 'Japan' }] });
    // A (malformed) master whose holdings name itself again.
    stubs.masters.set('THE LOOPING SERIES', { seriesId: 'S3', constituents: [
      { symbol: 'NESN', name: 'Nestle', percent: 0.5, country: 'Switzerland' }, masterRow('THE LOOPING SERIES', 0.5),
    ] });
    stubFetch(() => status(404));
    const list = (await mod.fetchDeepConstituents('DFISX'))!;
    const pct = (s: string) => list.find(c => c.symbol === s)?.percent;
    expect(pct('7203')).toBeCloseTo(0.4);
    expect(pct('NESN')).toBeCloseTo(0.3);
    expect(pct('DFISX')).toBeCloseTo(0.3); // the loop's share stays closed, under the fund's own name
    expect(list.reduce((s, c) => s + c.percent, 0)).toBeCloseTo(1);
  });
});
