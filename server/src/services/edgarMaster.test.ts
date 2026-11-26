import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrations.js';
import {
  parseNport, parseSeriesList, parseEntityMatches, parseFullTextFilers, normalizeFundName, businessCountryCode,
  findMasterSeries, fetchMasterConstituents, clearMasterLookups, resetEdgarState,
} from './edgarHoldings.js';
import { lookupFailureCount } from './lookupHealth.js';
import type { MasterRef } from './fundHoldings.js';

// Feeder → master look-through against trimmed real filings (public SEC data):
// DFA's Emerging Markets Portfolio (DFEMX), whose N-PORT holds one thing — The
// Emerging Markets Series of The DFA Investment Trust Company — and that
// master's own N-PORT. Network is stubbed throughout.
const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/edgar/${name}`, import.meta.url), 'utf8');
const FEEDER = fixture('dfemx-nport.xml');
const MASTER = fixture('em-series-nport.xml');
const SERIES_LIST = fixture('dfa-trust-series.html');
const KEYS_TYPED = JSON.parse(fixture('efts-keystyped-em-series.json'));
const FULL_TEXT = JSON.parse(fixture('efts-fulltext-em-series.json'));

vi.mock('./figi.js', () => ({ knownTicker: () => undefined, queueTickerLookups: () => {} }));
const dbRef = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../db/schema.js', () => ({ getDb: () => dbRef.db }));

const names = new Map([['TAIWAN SEMICONDUCTOR MANUFACTURING', 'TSM']]);

describe('parseNport: a feeder fund', () => {
  const { constituents, series } = parseNport(FEEDER, names);

  it('keeps the master as a fund reference named after the series, not the adviser', () => {
    expect(constituents).toHaveLength(1);
    const [m] = constituents;
    expect(m).toMatchObject({ symbol: 'EMERGING MARKETS SERIES', name: 'THE EMERGING MARKETS SERIES', fund: true, named: true });
    expect(m.percent).toBeCloseTo(1.000179, 5);
    expect(m.country).toBeUndefined(); // a fund isn't a company: its holdings will say
    expect(m.master).toEqual({
      issuer: 'Dimensional Fund Advisors', series: 'THE EMERGING MARKETS SERIES', lei: '5493003AI5702G3MYM49',
      ownerSeries: 'S000000957', ownerName: 'EMERGING MARKETS PORTFOLIO', ownerCik: '355437',
    });
    expect(series).toEqual({ id: 'S000000957', name: 'EMERGING MARKETS PORTFOLIO' });
  });
});

describe('parseNport: the master fund', () => {
  const { constituents } = parseNport(MASTER, names);
  const bySym = (s: string) => constituents.find(c => c.symbol === s || c.name.startsWith(s));

  it('reads its stocks, with Cayman shells placed by the currency they trade in', () => {
    expect(bySym('TSM')).toMatchObject({ country: 'Taiwan' });
    expect(bySym('Tencent')).toMatchObject({ country: 'China' });          // KY, quoted in HKD
    const alibaba = (isin: string) => constituents.find(c => c.isin === isin);
    expect(alibaba('KYG017191142')).toMatchObject({ country: 'China' });          // Hong Kong line (currencyConditional HKD)
    expect(alibaba('US01609W1027')).toMatchObject({ country: 'Cayman Islands' }); // the US ADR: USD says nothing, left alone
    expect(bySym('Credicorp')).toMatchObject({ country: 'Bermuda' });      // BM, USD (a Peruvian bank)
    expect(bySym('Samsung')).toMatchObject({ country: 'South Korea' });
  });

  it('drops securities-lending collateral and the pool it is invested in', () => {
    expect(constituents.some(c => /DFA Investment Trust|Dimensional Holdings/i.test(c.name))).toBe(false);
    expect(constituents.some(c => c.kind === 'cash')).toBe(false);
    expect(constituents.some(c => c.fund)).toBe(false);
  });

  it('maps shell domiciles only', () => {
    expect(businessCountryCode('KY', 'TWD')).toBe('TW');
    expect(businessCountryCode('KY', 'USD')).toBe('KY');
    expect(businessCountryCode('US', 'HKD')).toBe('US'); // Yum China: a real US company
    expect(businessCountryCode(undefined, 'HKD')).toBeUndefined();
  });
});

describe('EDGAR series / company search parsers', () => {
  it('reads a registrant’s series list', () => {
    const list = parseSeriesList(SERIES_LIST);
    expect(list).toContainEqual({ seriesId: 'S000000992', name: 'THE EMERGING MARKETS SERIES' });
    expect(list.map(s => s.seriesId)).toEqual(['S000000992', 'S000000993', 'S000000994', 'S000001000']);
  });

  it('decodes the double-escaped names EDGAR series pages carry', () => {
    const html = '<a href="/cgi-bin/browse-edgar?action=getcompany&amp;CIK=S000004285&amp;scd=series&amp;view=mutual-fund">S&amp;amp;P 500 Index Master Portfolio</a>';
    expect(parseSeriesList(html)).toEqual([{ seriesId: 'S000004285', name: 'S&P 500 Index Master Portfolio' }]);
  });

  it('matches company-search entities by exact (normalized) name only', () => {
    expect(parseEntityMatches(KEYS_TYPED, 'THE EMERGING MARKETS SERIES')).toEqual([]); // near misses only
    const raw = { hits: { hits: [{ _id: '915092', _source: { entity: 'MASTER INVESTMENT PORTFOLIO' } }, { _id: '1738077', _source: { entity: 'Master Investment Portfolio II' } }] } };
    expect(parseEntityMatches(raw, 'MASTER INVESTMENT PORTFOLIO')).toEqual(['915092']);
  });

  it('lists full-text filers by document count', () => {
    expect(parseFullTextFilers(FULL_TEXT).map(f => f.cik)).toEqual(['355437', '896162', '861929']);
    expect(parseFullTextFilers(null)).toEqual([]);
  });

  it('normalizes fund names so titles and series names meet, but series stay apart', () => {
    expect(normalizeFundName('U.S. LARGE CAP VALUE SERIES')).toBe(normalizeFundName('THE U.S. LARGE CAP VALUE SERIES'));
    expect(normalizeFundName('DIMENSIONAL EMERGING MARKETS VALUE FUND INC')).toBe(normalizeFundName('DIMENSIONAL EMERGING MARKETS VALUE FUND'));
    expect(normalizeFundName('S&amp;P 500 Index Master Portfolio')).toBe('S&P 500 INDEX MASTER PORTFOLIO');
    expect(normalizeFundName('EMERGING MARKETS PORTFOLIO')).not.toBe(normalizeFundName('THE EMERGING MARKETS SERIES'));
    expect(normalizeFundName('THE EMERGING MARKETS SMALL CAP SERIES')).not.toBe(normalizeFundName('THE EMERGING MARKETS SERIES'));
  });
});

describe('finding and opening a master fund', () => {
  const ref = parseNport(FEEDER, names).constituents[0].master as MasterRef;
  const ok = (body: unknown) => ({ ok: true, status: 200, text: async () => String(body), json: async () => body });
  let urls: string[];

  function stub(opts: { failSeriesList?: boolean; noMatch?: boolean } = {}) {
    urls = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url);
      if (url.includes('keysTyped=')) return ok(KEYS_TYPED);
      if (url.includes('search-index?q=')) return ok(FULL_TEXT);
      if (url.includes('scd=series')) {
        if (opts.failSeriesList) throw new Error('network down');
        // The DFA trust's page has the master; the others (the feeder's own
        // registrant, another DFA company) don't.
        return ok(url.includes('CIK=0000896162') && !opts.noMatch ? SERIES_LIST : '<table></table>');
      }
      if (url.includes('company_tickers.json')) return ok({ '0': { cik_str: 1, ticker: 'TSM', title: 'Taiwan Semiconductor Manufacturing' } });
      if (url.includes('type=NPORT-P')) return ok('Archives/edgar/data/896162/000141036826098381/');
      if (url.endsWith('index.json')) return ok({ directory: { item: [{ name: 'primary_doc.xml', size: '2068739' }] } });
      if (url.endsWith('primary_doc.xml')) return ok(MASTER);
      return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
    }));
  }

  beforeAll(() => { const db = new Database(':memory:'); runMigrations(db); dbRef.db = db; });
  const saved = process.env.SEC_CONTACT_EMAIL;
  beforeEach(() => {
    process.env.SEC_CONTACT_EMAIL = 'tester@example.com';
    resetEdgarState();
    clearMasterLookups();
    (dbRef.db as Database.Database).prepare('DELETE FROM edgar_fund_holdings').run();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (saved === undefined) delete process.env.SEC_CONTACT_EMAIL; else process.env.SEC_CONTACT_EMAIL = saved;
  });

  it('finds the master by its series name, skipping the feeder’s own registrant', async () => {
    stub();
    expect(await findMasterSeries(ref)).toEqual({ cik: '896162', seriesId: 'S000000992', name: 'THE EMERGING MARKETS SERIES' });
    const pages = urls.filter(u => u.includes('scd=series'));
    expect(pages).toHaveLength(1); // the DFA trust first: 355437 (the feeder's own) is put last
    expect(pages[0]).toContain('CIK=0000896162');
  });

  it('opens the master’s own filing, cached under its series id', async () => {
    stub();
    const opened = await fetchMasterConstituents(ref);
    expect(opened?.seriesId).toBe('S000000992');
    expect(opened?.constituents.find(c => c.symbol === 'TSM')?.percent).toBeCloseTo(0.1332, 4);
    expect(urls.some(u => u.includes('CIK=S000000992&type=NPORT-P'))).toBe(true);
    const row = (dbRef.db as Database.Database).prepare("SELECT symbol FROM edgar_fund_holdings WHERE symbol = 'S000000992'").get();
    expect(row).toBeTruthy();

    urls.length = 0;
    expect((await fetchMasterConstituents(ref))?.constituents.length).toBe(opened?.constituents.length);
    expect(urls).toEqual([]); // both the lookup and the holdings come from cache
  });

  it('remembers "no such master" (a firm answer)', async () => {
    stub({ noMatch: true });
    expect(await findMasterSeries(ref)).toBeNull();
    urls.length = 0;
    expect(await findMasterSeries(ref)).toBeNull();
    expect(urls).toEqual([]);
  });

  it('never caches a failed lookup as a miss, and counts it as a failed lookup', async () => {
    stub({ failSeriesList: true });
    const before = lookupFailureCount();
    await expect(findMasterSeries(ref)).rejects.toThrow('network down');
    expect(lookupFailureCount()).toBeGreaterThan(before);
    stub(); // SEC is back: the next call asks again and succeeds
    expect((await findMasterSeries(ref))?.seriesId).toBe('S000000992');
  });

  it('asks SEC nothing without a contact email', async () => {
    delete process.env.SEC_CONTACT_EMAIL;
    stub();
    expect(await fetchMasterConstituents(ref)).toBeNull();
    expect(urls).toEqual([]);
  });
});
