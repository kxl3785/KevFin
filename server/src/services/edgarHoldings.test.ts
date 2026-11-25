import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrations.js';
import {
  normalizeIssuerName, parseMfTickers, parseCompanyTickers, parseLatestFilingPath, parseNport,
  encodeHoldings, decodeHoldings, fetchEdgarConstituents, getEdgarStatus, EDGAR_CACHE_VERSION,
  edgarUserAgent, getLookThroughIssue, resetEdgarState, cleanTicker, resolveNamedTickers,
} from './edgarHoldings.js';

// OpenFIGI is a background lookup; stub it so these tests stay offline and can
// say which identifiers already have a known ticker.
const figi = vi.hoisted(() => ({ known: new Map<string, string | null>(), queued: [] as unknown[] }));
vi.mock('./figi.js', () => ({
  knownTicker: (id: { cusip?: string; isin?: string }) => {
    for (const k of [id.cusip, id.isin]) if (k && figi.known.has(k)) return figi.known.get(k);
    return undefined;
  },
  queueTickerLookups: (ids: unknown[]) => { figi.queued.push(...ids); },
}));

// fetchEdgarConstituents reads/writes the cache through getDb(); point it at an
// in-memory database.
const dbRef = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../db/schema.js', () => ({ getDb: () => dbRef.db }));

describe('normalizeIssuerName', () => {
  it('matches SEC ticker-file titles against N-PORT issuer names', () => {
    expect(normalizeIssuerName('Apple Inc.')).toBe(normalizeIssuerName('APPLE INC'));
    expect(normalizeIssuerName('MICROSOFT CORP')).toBe(normalizeIssuerName('Microsoft Corporation'));
    expect(normalizeIssuerName('NVIDIA CORP')).toBe(normalizeIssuerName('NVIDIA Corp'));
    expect(normalizeIssuerName("McDonald's Corporation")).toBe(normalizeIssuerName('MCDONALDS CORP'));
    expect(normalizeIssuerName('AT&T Inc.')).toBe(normalizeIssuerName('AT&T INC'));
  });

  it('drops share-class markers so classes collapse to the issuer', () => {
    expect(normalizeIssuerName('Berkshire Hathaway Inc Class B')).toBe('BERKSHIRE HATHAWAY');
    expect(normalizeIssuerName('ALPHABET INC-CL A')).toBe('ALPHABET');
  });

  it('keeps distinguishing words', () => {
    expect(normalizeIssuerName('Goldman Sachs Group Inc')).toBe('GOLDMAN SACHS GROUP');
    expect(normalizeIssuerName('CME Group Inc')).not.toBe(normalizeIssuerName('Goldman Sachs Group Inc'));
  });
});

describe('parseMfTickers', () => {
  const raw = {
    fields: ['cik', 'seriesId', 'classId', 'symbol'],
    data: [
      [1100663, 'S000004310', 'C000011963', 'IVV'],
      [1100663, 'S000004310', 'C000011964', 'ivv'], // duplicate class → first wins
      [884394, 'S000006408', 'C000017634', 'SPY'],
      [123, 'not-a-series', 'C0001', 'BAD'],
      [0, 'S000000001', 'C0002', 'NOCIK'],
    ],
  };

  it('maps upper-cased tickers to their cik + series id (+ share class when given)', () => {
    const map = parseMfTickers(raw);
    expect(map.get('IVV')).toMatchObject({ cik: 1100663, seriesId: 'S000004310' });
    expect(map.get('SPY')).toMatchObject({ cik: 884394, seriesId: 'S000006408' });
  });

  it('skips rows with malformed series ids or ciks', () => {
    const map = parseMfTickers(raw);
    expect(map.has('BAD')).toBe(false);
    expect(map.has('NOCIK')).toBe(false);
  });

  it('reads column positions from the fields header', () => {
    const reordered = {
      fields: ['symbol', 'cik', 'classId', 'seriesId'],
      data: [['VTI', 36405, 'C000065855', 'S000002848']],
    };
    expect(parseMfTickers(reordered).get('VTI')).toEqual({ cik: 36405, seriesId: 'S000002848', classId: 'C000065855' });
  });

  it('returns an empty map on unexpected shapes', () => {
    expect(parseMfTickers(null).size).toBe(0);
    expect(parseMfTickers({ fields: ['x'], data: [[1]] }).size).toBe(0);
  });
});

describe('parseCompanyTickers', () => {
  it('maps normalized titles to tickers, first entry winning on collision', () => {
    const map = parseCompanyTickers({
      '0': { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' },
      '1': { cik_str: 1652044, ticker: 'GOOGL', title: 'Alphabet Inc.' },
      '2': { cik_str: 1652044, ticker: 'GOOG', title: 'Alphabet Inc.' }, // same title → GOOGL kept
      '3': { cik_str: 1, ticker: '', title: 'No Ticker Co' },
    });
    expect(map.get(normalizeIssuerName('APPLE INC'))).toBe('AAPL');
    expect(map.get(normalizeIssuerName('Alphabet Inc'))).toBe('GOOGL');
    expect(map.size).toBe(2);
  });
});

describe('parseLatestFilingPath', () => {
  it('takes cik + accession from the first Archives link (feed is newest-first)', () => {
    const atom = `<?xml version="1.0"?><feed>
      <entry><content type="text/xml">
        <accession-number>0001752724-25-159879</accession-number>
        <filing-href>https://www.sec.gov/Archives/edgar/data/1100663/000175272425159879/0001752724-25-159879-index.htm</filing-href>
      </content></entry>
      <entry><content type="text/xml">
        <filing-href>https://www.sec.gov/Archives/edgar/data/1100663/000175272425100000/0001752724-25-100000-index.htm</filing-href>
      </content></entry>
    </feed>`;
    expect(parseLatestFilingPath(atom)).toEqual({ cik: '1100663', accession: '000175272425159879' });
  });

  it('falls back to the first accession-shaped string when no link is present', () => {
    const atom = '<feed><entry><accession-nunber>0001752724-25-159879</accession-nunber></entry></feed>';
    expect(parseLatestFilingPath(atom)).toEqual({ cik: null, accession: '000175272425159879' });
  });

  it('returns null for a feed with no filings', () => {
    expect(parseLatestFilingPath('<feed><title>no matches</title></feed>')).toBeNull();
  });
});

describe('parseNport', () => {
  const tickers = new Map([
    [normalizeIssuerName('Apple Inc.'), 'AAPL'],
    [normalizeIssuerName('AT&T Inc.'), 'T'],
  ]);

  const xml = `<?xml version="1.0"?>
  <edgarSubmission>
    <formData>
      <genInfo><seriesId>S000004310</seriesId><repPdDate>2026-03-31</repPdDate></genInfo>
      <invstOrSecs>
        <invstOrSec>
          <name>Apple Inc</name><title>Apple Inc</title><cusip>037833100</cusip>
          <identifiers><isin value="US0378331005"/></identifiers>
          <valUSD>29000000.00</valUSD><pctVal>6.7</pctVal>
          <payoffProfile>Long</payoffProfile><assetCat>EC</assetCat><invCountry>US</invCountry>
        </invstOrSec>
        <invstOrSec>
          <name>AT&amp;T INC</name><title>AT&amp;T INC</title>
          <identifiers><isin value="US00206R1023"/></identifiers>
          <pctVal>0.9</pctVal><assetCat>EC</assetCat><invCountry>US</invCountry>
        </invstOrSec>
        <invstOrSec>
          <name>Taiwan Semiconductor Manufacturing Co Ltd</name>
          <title>Taiwan Semiconductor Manufacturing Co Ltd</title>
          <identifiers><isin value="TW0002330008"/></identifiers>
          <pctVal>2.5</pctVal><assetCat>EC</assetCat><invCountry>TW</invCountry>
        </invstOrSec>
        <invstOrSec>
          <name>N/A</name><title>Untitled Preferred Co</title>
          <pctVal>0.4</pctVal><assetCat>EP</assetCat><invCountry>GB</invCountry>
        </invstOrSec>
        <invstOrSec>
          <name>United States Treasury Note</name><pctVal>1.5</pctVal><assetCat>DBT</assetCat>
        </invstOrSec>
        <invstOrSec>
          <name>Cash Sweep</name><pctVal>0.5</pctVal><assetCat>STIV</assetCat>
        </invstOrSec>
        <invstOrSec>
          <name>Short Future Payable</name><pctVal>-0.3</pctVal><assetCat>DE</assetCat>
        </invstOrSec>
      </invstOrSecs>
    </formData>
  </edgarSubmission>`;

  const { asOf, constituents } = parseNport(xml, tickers);

  it('reads the report-period date', () => {
    expect(asOf).toBe('2026-03-31');
  });

  it('emits equity positions with tickers matched by normalized name', () => {
    const apple = constituents.find(c => c.symbol === 'AAPL');
    expect(apple).toMatchObject({ name: 'Apple Inc', country: 'United States' });
    expect(apple!.percent).toBeCloseTo(0.067);
    // XML entities decoded before the name lookup
    expect(constituents.find(c => c.symbol === 'T')?.name).toBe('AT&T INC');
  });

  it('keys unmatched issuers by normalized name so they still aggregate', () => {
    const tsmc = constituents.find(c => c.name.startsWith('Taiwan'));
    expect(tsmc?.symbol).toBe(normalizeIssuerName('Taiwan Semiconductor Manufacturing Co Ltd'));
    expect(tsmc?.country).toBe('Taiwan');
  });

  it('uses <title> when <name> is N/A, and includes preferred equity', () => {
    const pref = constituents.find(c => c.name === 'Untitled Preferred Co');
    expect(pref).toBeDefined();
    expect(pref!.percent).toBeCloseTo(0.004);
    expect(pref!.country).toBe('United Kingdom'); // from invCountry, no ISIN
  });

  it('splits non-equity positions into bond and cash rows and skips shorts/negatives', () => {
    const bonds = constituents.find(c => c.kind === 'bond');
    const cash = constituents.find(c => c.kind === 'cash');
    expect(bonds).toMatchObject({ symbol: '— bonds —', country: 'Bonds / Commodities / Cash' });
    expect(bonds!.percent).toBeCloseTo(0.015);
    expect(cash!.percent).toBeCloseTo(0.005);
    expect(constituents.some(c => c.kind === 'other')).toBe(false); // the only derivative was a short
    expect(constituents.some(c => c.name === 'Short Future Payable')).toBe(false);
  });

  it('keeps CUSIP / ISIN identifiers and flags name-keyed holdings', () => {
    const apple = constituents.find(c => c.symbol === 'AAPL')!;
    expect(apple).toMatchObject({ cusip: '037833100', isin: 'US0378331005' });
    expect(apple.named).toBeUndefined();
    expect(constituents.find(c => c.name.startsWith('Taiwan'))).toMatchObject({ named: true, isin: 'TW0002330008' });
  });

  it('sorts equity constituents by descending weight', () => {
    const equities = constituents.filter(c => !c.kind);
    expect(equities.map(c => c.percent)).toEqual([...equities.map(c => c.percent)].sort((a, b) => b - a));
  });

  it('returns no constituents for an empty filing', () => {
    expect(parseNport('<edgarSubmission></edgarSubmission>', tickers).constituents).toEqual([]);
  });
});

describe('parseNport country of risk', () => {
  const eq = (name: string, isin: string | null, inv: string | null) => `
    <invstOrSec><name>${name}</name>${isin ? `<identifiers><isin value="${isin}"/></identifiers>` : ''}
      <pctVal>1.0</pctVal><assetCat>EC</assetCat>${inv ? `<invCountry>${inv}</invCountry>` : ''}</invstOrSec>`;
  const country = (name: string, isin: string | null, inv: string | null) =>
    parseNport(`<x>${eq(name, isin, inv)}</x>`, new Map()).constituents[0].country;

  it('prefers invCountry (country of risk) over the ISIN registration prefix', () => {
    expect(country('Alibaba-like ADR', 'KYG017191142', 'CN')).toBe('China');     // Cayman-registered, China risk
    expect(country('Bermuda-registered shipper', 'BMG0450A1053', 'HK')).toBe('Hong Kong');
    expect(country('Jersey-registered miner', 'JE00B4T3BW64', 'CH')).toBe('Switzerland');
  });

  it('names countries the old table lacked', () => {
    expect(country('Argentine Co', null, 'AR')).toBe('Argentina');
    expect(country('Pakistani Co', 'PK0000000001', 'PK')).toBe('Pakistan');
  });

  it('falls back to the ISIN when invCountry is missing or not a real country code', () => {
    expect(country('No inv country', 'DE0007164600', null)).toBe('Germany');
    expect(country('Bad inv country', 'FR0000120073', 'ZZ')).toBe('France');
    expect(country('Junk inv country', 'JP3633400001', 'N/A')).toBe('Japan');
    expect(country('Region-ish inv country', 'GB0002374006', 'EU')).toBe('United Kingdom');
  });

  it('uses International / Other when only a non-country ISIN prefix is available', () => {
    expect(country('Eurobond-ish equity', 'XS0000000001', null)).toBe('International / Other');
  });

  it('leaves country unset with neither source', () => {
    expect(country('Mystery', null, null)).toBeUndefined();
  });
});

describe('holdings cache format', () => {
  const legacy = JSON.stringify([
    { symbol: 'A', name: 'A', percent: 0.5, country: 'AR' },
    { symbol: 'B', name: 'B', percent: 0.3, country: 'XS' },
    { symbol: 'C', name: 'C', percent: 0.2, country: 'Japan' },
    { symbol: 'D', name: 'D', percent: 0.1 },
  ]);

  it('round-trips the current format untouched', () => {
    const list = [{ symbol: 'A', name: 'A', percent: 0.5, country: 'Argentina' }];
    expect(decodeHoldings(encodeHoldings(list))).toEqual({ version: EDGAR_CACHE_VERSION, constituents: list });
  });

  it('reads a bare legacy array as version 1 and re-labels raw country codes', () => {
    const d = decodeHoldings(legacy)!;
    expect(d.version).toBe(1);
    expect(d.constituents.map(c => c.country)).toEqual(['Argentina', 'International / Other', 'Japan', undefined]);
  });

  it('does not re-label current-version rows', () => {
    const d = decodeHoldings(JSON.stringify({ v: EDGAR_CACHE_VERSION, constituents: [{ symbol: 'A', name: 'A', percent: 1, country: 'AR' }] }))!;
    expect(d.constituents[0].country).toBe('AR');
  });

  it('returns null for empty or corrupt values', () => {
    expect(decodeHoldings(null)).toBeNull();
    expect(decodeHoldings('not json')).toBeNull();
    expect(decodeHoldings('{"v":2}')).toBeNull();
  });
});

describe('fetchEdgarConstituents cache versioning', () => {
  const FILING = `<?xml version="1.0"?><edgarSubmission><formData><genInfo><repPdDate>2026-06-30</repPdDate></genInfo><invstOrSecs>
    <invstOrSec><name>Alibaba Group</name><identifiers><isin value="KYG017191142"/></identifiers>
      <pctVal>3.0</pctVal><assetCat>EC</assetCat><invCountry>CN</invCountry></invstOrSec>
  </invstOrSecs></formData></edgarSubmission>`;
  const ok = (body: string | object) => ({ ok: true, status: 200, text: async () => String(body), json: async () => body });

  function stubEdgar(opts: { failFilings?: boolean } = {}) {
    const f = vi.fn(async (url: string) => {
      if (url.endsWith('company_tickers_mf.json')) return ok({ fields: ['cik', 'seriesId', 'classId', 'symbol'], data: [[1, 'S000000001', 'C1', 'VXUS']] });
      if (url.endsWith('company_tickers.json')) return ok({ '0': { cik_str: 1, ticker: 'BABA', title: 'Alibaba Group' } });
      if (opts.failFilings) throw new Error('network down');
      if (url.includes('browse-edgar')) return ok('Archives/edgar/data/1/000000000026000001/');
      if (url.endsWith('index.json')) return ok({ directory: { item: [{ name: 'primary_doc.xml', size: '100' }] } });
      return ok(FILING);
    });
    vi.stubGlobal('fetch', f);
    return f;
  }

  const put = (holdings: string | null, fetchedAt = "datetime('now')") => {
    const db = dbRef.db as Database.Database;
    db.prepare('DELETE FROM edgar_fund_holdings').run();
    db.exec(`INSERT INTO edgar_fund_holdings (symbol, as_of, holdings, fetched_at) VALUES ('VXUS', '2026-03-31', ${holdings === null ? 'NULL' : `'${holdings}'`}, ${fetchedAt})`);
  };
  const stored = () => (dbRef.db as Database.Database).prepare("SELECT holdings FROM edgar_fund_holdings WHERE symbol = 'VXUS'").get() as { holdings: string };
  const legacyRow = JSON.stringify([{ symbol: 'X', name: 'X Co', percent: 1, country: 'PK' }]);

  beforeAll(() => {
    const db = new Database(':memory:');
    runMigrations(db);
    dbRef.db = db;
  });
  const savedEnv = { ua: process.env.SEC_EDGAR_UA, email: process.env.SEC_CONTACT_EMAIL };
  beforeEach(() => { delete process.env.SEC_EDGAR_UA; process.env.SEC_CONTACT_EMAIL = 'tester@example.com'; resetEdgarState(); });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [k, v] of [['SEC_EDGAR_UA', savedEnv.ua], ['SEC_CONTACT_EMAIL', savedEnv.email]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  it('refetches a fresh-but-legacy row once and rewrites it in the current format', async () => {
    put(legacyRow); // fetched just now: would have been served from cache before the version check
    const f = stubEdgar();
    const first = await fetchEdgarConstituents('vxus');
    expect(first?.[0]).toMatchObject({ name: 'Alibaba Group', country: 'China' });
    expect(JSON.parse(stored().holdings)).toMatchObject({ v: EDGAR_CACHE_VERSION });
    const calls = f.mock.calls.length;
    expect(calls).toBeGreaterThan(0);

    const second = await fetchEdgarConstituents('VXUS'); // now current + fresh: served from cache
    expect(second).toEqual(first);
    expect(f.mock.calls.length).toBe(calls);
  });

  it('serves a fresh current-format row from cache without any request', async () => {
    put(encodeHoldings([{ symbol: 'X', name: 'X Co', percent: 1, country: 'Pakistan' }]));
    const f = stubEdgar();
    expect((await fetchEdgarConstituents('VXUS'))?.[0].country).toBe('Pakistan');
    expect(f).not.toHaveBeenCalled();
  });

  it('keeps serving the (re-labelled) legacy row when the refetch fails, leaving it untouched', async () => {
    put(legacyRow);
    stubEdgar({ failFilings: true });
    const out = await fetchEdgarConstituents('VXUS');
    expect(out).toEqual([{ symbol: 'X', name: 'X Co', percent: 1, country: 'Pakistan' }]);
    expect(stored().holdings).toBe(legacyRow);
  });

  it('still serves an expired current-format row when the refetch fails', async () => {
    put(encodeHoldings([{ symbol: 'X', name: 'X Co', percent: 1, country: 'Chile' }]), "datetime('now', '-90 days')");
    stubEdgar({ failFilings: true });
    expect((await fetchEdgarConstituents('VXUS'))?.[0].country).toBe('Chile');
  });

  it('counts holdings in either format for the status endpoint', () => {
    put(legacyRow);
    expect(getEdgarStatus().cache[0].holdings).toBe(1);
    put(encodeHoldings([{ symbol: 'X', name: 'X', percent: 1 }, { symbol: 'Y', name: 'Y', percent: 1 }]));
    expect(getEdgarStatus().cache[0].holdings).toBe(2);
  });
});

describe('SEC identity (User-Agent) and request hygiene', () => {
  const savedEnv = { ua: process.env.SEC_EDGAR_UA, email: process.env.SEC_CONTACT_EMAIL };
  const ok = (body: unknown) => ({ ok: true, status: 200, text: async () => String(body), json: async () => body });
  const MF = { fields: ['cik', 'seriesId', 'classId', 'symbol'], data: [[1, 'S000000001', 'C1', 'VXUS']] };
  const put = (holdings: string | null, fetchedAt: string) => {
    const db = dbRef.db as Database.Database;
    db.prepare('DELETE FROM edgar_fund_holdings').run();
    db.prepare('INSERT INTO edgar_fund_holdings (symbol, as_of, holdings, fetched_at) VALUES (?, ?, ?, ?)').run('VXUS', '2026-03-31', holdings, fetchedAt);
  };
  const rowCount = () => (dbRef.db as Database.Database).prepare('SELECT COUNT(*) AS n FROM edgar_fund_holdings').get() as { n: number };

  beforeAll(() => {
    if (!dbRef.db) { const db = new Database(':memory:'); runMigrations(db); dbRef.db = db; }
  });
  beforeEach(() => { delete process.env.SEC_EDGAR_UA; delete process.env.SEC_CONTACT_EMAIL; resetEdgarState(); });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [k, v] of [['SEC_EDGAR_UA', savedEnv.ua], ['SEC_CONTACT_EMAIL', savedEnv.email]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  it('builds the User-Agent per call: override > "KevFin <email>" > none', () => {
    expect(edgarUserAgent()).toBeNull();
    process.env.SEC_CONTACT_EMAIL = '  me@example.com ';
    expect(edgarUserAgent()).toBe('KevFin me@example.com');
    process.env.SEC_EDGAR_UA = 'Acme Corp ops@acme.test';
    expect(edgarUserAgent()).toBe('Acme Corp ops@acme.test');
    process.env.SEC_EDGAR_UA = '   '; // blank override (e.g. empty compose var) is ignored
    expect(edgarUserAgent()).toBe('KevFin me@example.com');
    process.env.SEC_CONTACT_EMAIL = '';
    expect(edgarUserAgent()).toBeNull();
  });

  it('never contacts SEC without an identity, serves stale holdings, and writes no negative row', async () => {
    const f = vi.fn(); vi.stubGlobal('fetch', f);
    const stale = encodeHoldings([{ symbol: 'X', name: 'X Co', percent: 1, country: 'Chile' }]);
    put(stale, '2020-01-01 00:00:00');
    expect((await fetchEdgarConstituents('VXUS'))?.[0].country).toBe('Chile');
    (dbRef.db as Database.Database).prepare('DELETE FROM edgar_fund_holdings').run();
    expect(await fetchEdgarConstituents('VXUS')).toBeNull();
    expect(f).not.toHaveBeenCalled();
    expect(rowCount().n).toBe(0);
    expect(getLookThroughIssue()).toMatchObject({ issue: 'no-contact' });
    const status = getEdgarStatus();
    expect(status.identityConfigured).toBe(false);
    expect(status.contactEmail).toBeNull();
    expect(status.recentErrors[0].error).toBe('SEC contact email not set');
  });

  it('sends the declared User-Agent and Accept-Encoding on every SEC request', async () => {
    process.env.SEC_CONTACT_EMAIL = 'me@example.com';
    const seen: Record<string, string>[] = [];
    const f = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      seen.push(init?.headers ?? {});
      if (url.endsWith('company_tickers_mf.json')) return ok(MF);
      if (url.endsWith('company_tickers.json')) return ok({ '0': { cik_str: 1, ticker: 'BABA', title: 'Alibaba Group' } });
      if (url.includes('browse-edgar')) return ok('Archives/edgar/data/1/000000000026000001/');
      if (url.endsWith('index.json')) return ok({ directory: { item: [{ name: 'primary_doc.xml', size: '100' }] } });
      return ok('<invstOrSec><name>Alibaba Group</name><pctVal>3.0</pctVal><assetCat>EC</assetCat><invCountry>CN</invCountry></invstOrSec>');
    });
    vi.stubGlobal('fetch', f);
    (dbRef.db as Database.Database).prepare('DELETE FROM edgar_fund_holdings').run();
    expect((await fetchEdgarConstituents('VXUS'))?.length).toBe(1);
    expect(f.mock.calls.length).toBeGreaterThanOrEqual(5);
    for (const h of seen) {
      expect(h['User-Agent']).toBe('KevFin me@example.com');
      expect(h['Accept-Encoding']).toBe('gzip, deflate');
    }
    expect(getLookThroughIssue()).toBeNull();
    expect(getEdgarStatus()).toMatchObject({ identityConfigured: true, contactEmail: 'me@example.com', userAgent: 'KevFin me@example.com' });
  });

  it('puts the HTTP status in the recorded error, flags "blocked", and caches no negative row', async () => {
    process.env.SEC_CONTACT_EMAIL = 'me@example.com';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, text: async () => '', json: async () => ({}) })));
    (dbRef.db as Database.Database).prepare('DELETE FROM edgar_fund_holdings').run();
    expect(await fetchEdgarConstituents('VXUS')).toBeNull();
    const status = getEdgarStatus();
    expect(status.recentErrors.map(e => e.error)).toContain('EDGAR fund-ticker mapping unavailable (HTTP 403)');
    expect(status.lastMappingFetch).toMatchObject({ ok: false, status: 403 });
    expect(getLookThroughIssue()).toMatchObject({ issue: 'blocked' });
    expect(getLookThroughIssue()?.detail).toContain('403');
    expect(rowCount().n).toBe(0);

    resetEdgarState(); // saving a new email clears the flag
    expect(getLookThroughIssue()).toBeNull();
  });
});

describe('parseNport identifiers and nested funds', () => {
  const xml = `<edgarSubmission><formData><invstOrSecs>
    <invstOrSec><name>Vanguard Total Stock Market Index Fund</name><cusip>922908769</cusip>
      <identifiers><ticker value="VTI"/></identifiers><pctVal>54</pctVal><assetCat>EC</assetCat><issuerCat>RF</issuerCat><invCountry>US</invCountry></invstOrSec>
    <invstOrSec><name>Some Bank Corp</name><cusip>123456789</cusip>
      <identifiers><ticker value="SBC US"/></identifiers><pctVal>3</pctVal><assetCat>EC</assetCat><issuerCat>CORP</issuerCat></invstOrSec>
    <invstOrSec><name>Money Market Fund</name><pctVal>2</pctVal><assetCat>STIV</assetCat><issuerCat>RF</issuerCat></invstOrSec>
    <invstOrSec><name>Mortgage Pool</name><pctVal>30</pctVal><assetCat>ABS-MBS</assetCat></invstOrSec>
    <invstOrSec><name>S&amp;P 500 Future</name><pctVal>1</pctVal><assetCat>DE</assetCat></invstOrSec>
  </invstOrSecs></formData></edgarSubmission>`;
  const { constituents } = parseNport(xml, new Map());

  it("uses the filing's own ticker identifier, cleaning Bloomberg suffixes", () => {
    expect(constituents.find(c => c.cusip === '922908769')?.symbol).toBe('VTI');
    expect(constituents.find(c => c.cusip === '123456789')?.symbol).toBe('SBC');
  });

  it('flags registered-fund equity holdings, but a money-market sweep stays cash', () => {
    expect(constituents.find(c => c.symbol === 'VTI')?.fund).toBe(true);
    expect(constituents.find(c => c.symbol === 'SBC')?.fund).toBeUndefined();
    expect(constituents.find(c => c.kind === 'cash')!.percent).toBeCloseTo(0.02);
  });

  it('counts asset-backed debt as bonds and derivatives as other', () => {
    expect(constituents.find(c => c.kind === 'bond')!.percent).toBeCloseTo(0.30);
    expect(constituents.find(c => c.kind === 'other')!.percent).toBeCloseTo(0.01);
  });
});

describe('cleanTicker', () => {
  it('accepts plain and share-class tickers, rejects junk', () => {
    expect(cleanTicker('aapl')).toBe('AAPL');
    expect(cleanTicker('BRK/B')).toBe('BRK-B');
    expect(cleanTicker('MSFT UW')).toBe('MSFT');
    expect(cleanTicker('N/A')).toBeNull();
    expect(cleanTicker('037833100', '037833100')).toBeNull();
    expect(cleanTicker('12345')).toBeNull();
    expect(cleanTicker('')).toBeNull();
  });
});

describe('resolveNamedTickers', () => {
  beforeEach(() => { figi.known.clear(); figi.queued.length = 0; });

  it('swaps a name key for a known ticker and queues the unknown ones', () => {
    figi.known.set('11135F101', 'AVGO');
    const out = resolveNamedTickers([
      { symbol: 'BROADCOM', name: 'Broadcom Inc', percent: 0.02, named: true, cusip: '11135F101' },
      { symbol: 'MYSTERY', name: 'Mystery Co', percent: 0.01, named: true, isin: 'US0000000001' },
      { symbol: 'AAPL', name: 'Apple', percent: 0.05, cusip: '037833100' },
    ]);
    expect(out[0]).toMatchObject({ symbol: 'AVGO' });
    expect(out[0].named).toBeUndefined();
    expect(out[1].symbol).toBe('MYSTERY');
    expect(out[2].symbol).toBe('AAPL');
    expect(figi.queued).toEqual([{ cusip: undefined, isin: 'US0000000001' }]); // AAPL already has a ticker
  });

  it('does not re-queue an id OpenFIGI already said has no ticker', () => {
    figi.known.set('US0000000002', null);
    resolveNamedTickers([{ symbol: 'X', name: 'X', percent: 0.01, named: true, isin: 'US0000000002' }]);
    expect(figi.queued).toEqual([]);
  });
});
