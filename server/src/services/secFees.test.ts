import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The cache is swapped for an in-memory map so this test never touches a
// database, and the SEC plumbing (edgarHoldings.ts) for fakes so it never
// touches the network. Fixtures are shaped after the Vanguard Index Funds
// N-CSRS instance (accession 0001104659-26-102240): an unprefixed default
// xbrli namespace, `From…to…_C…Member` context ids, and oef:ClassAxis members.
const cache = new Map<string, { fetchedAt: number; payload: unknown }>();
vi.mock('../db/providerCache.js', () => ({
  readProviderCache: (k: string) => cache.get(k) ?? null,
  writeProviderCache: (k: string, e: { fetchedAt: number; payload: unknown }) => { cache.set(k, e); },
}));

type Fund = { cik: number; seriesId: string; classId?: string };
const funds = new Map<string, Fund>();
const fetchText = vi.fn<(url: string) => Promise<string>>();
const fetchJson = vi.fn<(url: string) => Promise<unknown>>();
const mappingGet = vi.fn<() => Promise<Map<string, Fund>>>();
vi.mock('./edgarHoldings.js', () => {
  class EdgarError extends Error {
    constructor(message: string, readonly kind: string, readonly status?: number) { super(message); }
  }
  const ua = () => {
    const email = process.env.SEC_CONTACT_EMAIL?.trim();
    return email ? `KevFin ${email}` : null;
  };
  // Like the real secFetch: refuse without an identity before any network.
  const guard = () => { if (!ua()) throw new EdgarError('SEC contact email not set', 'no-contact'); };
  return {
    EdgarError,
    edgarUserAgent: ua,
    fetchText: async (url: string) => { guard(); return fetchText(url); },
    fetchJson: async (url: string) => { guard(); return fetchJson(url); },
    mfTickerMapping: { get: () => mappingGet(), reset: () => {}, lastFetch: () => null, failureSuffix: () => '' },
  };
});

import { EdgarError } from './edgarHoldings.js';
const mod = await import('./secFees.js');
const { fetchSecExpenseRatio, parseExpenseRatioFacts, parseShareholderReports, instanceFiles, resetSecFeeState, CACHE_PREFIX } = mod;

const ctx = (id: string, start: string, end: string, members: string) => `
  <context id="${id}">
    <entity><identifier scheme="http://www.sec.gov/CIK">0000036405</identifier>
      ${members ? `<segment>${members}</segment>` : ''}
    </entity>
    <period><startDate>${start}</startDate><endDate>${end}</endDate></period>
  </context>`;
const cls = (c: string) => `<xbrldi:explicitMember dimension="oef:ClassAxis">nacc2:${c}Member</xbrldi:explicitMember>`;

// Two classes, two periods each (the annual report's year and the newer
// semi-annual half), plus traps: a ClassAxis fact split by a second axis, an
// out-of-range value, a nil fact, and an undimensioned (series-level) fact.
const INSTANCE = `<?xml version="1.0" encoding="utf-8"?>
<xbrl xmlns="http://www.xbrl.org/2003/instance" xmlns:oef="http://xbrl.sec.gov/oef/2025" xmlns:xbrldi="http://xbrl.org/2006/xbrldi">
  ${ctx('From2025-01-01to2025-12-31', '2025-01-01', '2025-12-31', '')}
  ${ctx('From2025-01-01to2025-12-31_C000007773Member', '2025-01-01', '2025-12-31', cls('C000007773'))}
  ${ctx('From2026-01-01to2026-06-30_C000007773Member', '2026-01-01', '2026-06-30', cls('C000007773'))}
  ${ctx('From2025-01-01to2025-12-31_C000007774Member', '2025-01-01', '2025-12-31', cls('C000007774'))}
  ${ctx('From2026-01-01to2026-06-30_C000007774Member', '2026-01-01', '2026-06-30', cls('C000007774'))}
  ${ctx('From2026-01-01to2026-06-30_C000007774Member_Other', '2026-01-01', '2026-06-30',
    cls('C000007774') + '<xbrldi:explicitMember dimension="us-gaap:StatementScenarioAxis">srt:ScenarioForecastMember</xbrldi:explicitMember>')}
  ${ctx('From2026-01-01to2026-06-30_C000009999Member', '2026-01-01', '2026-06-30', cls('C000009999'))}
  <oef:ExpenseRatioPct contextRef="From2025-01-01to2025-12-31" unitRef="Pure" decimals="INF">0.0009</oef:ExpenseRatioPct>
  <oef:ExpenseRatioPct contextRef="From2026-01-01to2026-06-30_C000007773Member" unitRef="Pure" decimals="INF">0.0014</oef:ExpenseRatioPct>
  <oef:ExpenseRatioPct contextRef="From2025-01-01to2025-12-31_C000007773Member" unitRef="Pure" decimals="INF">0.0015</oef:ExpenseRatioPct>
  <oef:ExpenseRatioPct contextRef="From2025-01-01to2025-12-31_C000007774Member" unitRef="Pure" decimals="INF">0.0005</oef:ExpenseRatioPct>
  <oef:ExpenseRatioPct contextRef="From2026-01-01to2026-06-30_C000007774Member" unitRef="Pure" decimals="INF">0.0004</oef:ExpenseRatioPct>
  <oef:ExpenseRatioPct contextRef="From2026-01-01to2026-06-30_C000007774Member_Other" unitRef="Pure" decimals="INF">0.0001</oef:ExpenseRatioPct>
  <oef:ExpenseRatioPct contextRef="From2026-01-01to2026-06-30_C000009999Member" unitRef="Pure" decimals="INF">0.14</oef:ExpenseRatioPct>
  <oef:ExpenseRatioPct contextRef="From2025-01-01to2025-12-31_C000007774Member" unitRef="Pure" xsi:nil="true"/>
  <oef:ExpensesPaidAmt contextRef="From2026-01-01to2026-06-30_C000007773Member" unitRef="USD" decimals="0">7</oef:ExpensesPaidAmt>
</xbrl>`;

const atomEntry = (form: string, date: string, cik: string, acc: string) => `
<entry>
<category label="form type" scheme="https://www.sec.gov/" term="${form}"/>
<content type="text/xml">
<accession-number>${acc.slice(0, 10)}-${acc.slice(10, 12)}-${acc.slice(12)}</accession-number>
<filing-date>${date}</filing-date>
<filing-href>https://www.sec.gov/Archives/edgar/data/${cik}/${acc}/${acc.slice(0, 10)}-${acc.slice(10, 12)}-${acc.slice(12)}-index.htm</filing-href>
<filing-type>${form}</filing-type>
</content>
<title>${form}</title>
</entry>`;
const ATOM = `<?xml version="1.0" encoding="ISO-8859-1" ?><feed xmlns="http://www.w3.org/2005/Atom"><title>VANGUARD</title>
${atomEntry('N-CSR/A', '2026-09-15', '36405', '000110465926111111')}
${atomEntry('N-CSRS', '2026-08-27', '36405', '000110465926102240')}
${atomEntry('N-CSR', '2026-02-26', '36405', '000110465926020000')}
</feed>`;
const INDEX = {
  directory: {
    item: [
      { name: 'FilingSummary.xml', size: '3000' },
      { name: 'tm2620528d8_ncsrs.htm', size: '2000000' },
      { name: 'tm2620528d8_ncsrs_htm.xml', size: '1400000' },
      { name: 'MetaLinks.json', size: '91000' },
    ],
  },
};
const BASE = 'https://www.sec.gov/Archives/edgar/data/36405/000110465926102240';

let instanceCalls: number;
function stubSec(opts: { instance?: string; atom?: string; index?: unknown; fail?: (url: string) => Error | null } = {}) {
  mappingGet.mockImplementation(async () => funds);
  fetchText.mockImplementation(async (url: string) => {
    const err = opts.fail?.(url);
    if (err) throw err;
    if (url.includes('browse-edgar')) return opts.atom ?? ATOM;
    if (url.endsWith('_htm.xml')) { instanceCalls++; return opts.instance ?? INSTANCE; }
    throw new Error(`unexpected url ${url}`);
  });
  fetchJson.mockImplementation(async (url: string) => {
    const err = opts.fail?.(url);
    if (err) throw err;
    if (url.endsWith('/index.json')) return opts.index ?? INDEX;
    throw new Error(`unexpected url ${url}`);
  });
}

const DAY = 24 * 3600 * 1000;
const T0 = 1_790_000_000_000;

beforeEach(() => {
  cache.clear();
  funds.clear();
  funds.set('VFINX', { cik: 36405, seriesId: 'S000002839', classId: 'C000007773' });
  funds.set('VFIAX', { cik: 36405, seriesId: 'S000002839', classId: 'C000007774' });
  funds.set('NOCLS', { cik: 36405, seriesId: 'S000002839' });
  fetchText.mockReset(); fetchJson.mockReset(); mappingGet.mockReset();
  instanceCalls = 0;
  resetSecFeeState();
  process.env.SEC_CONTACT_EMAIL = 'test@example.com';
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.SEC_CONTACT_EMAIL;
  vi.restoreAllMocks();
});

describe('parseExpenseRatioFacts', () => {
  it('picks the wanted class and its latest period', () => {
    expect(parseExpenseRatioFacts(INSTANCE, 'C000007773')).toEqual({ ratio: 0.0014, asOf: '2026-06-30' });
    // The split-by-scenario 0.0001 is not the class's headline figure.
    expect(parseExpenseRatioFacts(INSTANCE, 'C000007774')).toEqual({ ratio: 0.0004, asOf: '2026-06-30' });
  });

  it('rejects values outside 0..5% and classes with no fact', () => {
    expect(parseExpenseRatioFacts(INSTANCE, 'C000009999')).toBeNull(); // 0.14 = 14%: mis-tagged
    expect(parseExpenseRatioFacts(INSTANCE, 'C000000001')).toBeNull();
    expect(parseExpenseRatioFacts(INSTANCE, '')).toBeNull();
    expect(parseExpenseRatioFacts('', 'C000007773')).toBeNull();
  });

  it('falls back to an earlier period when the latest is out of range', () => {
    const xml = INSTANCE.replace('>0.0014<', '>-0.2<');
    expect(parseExpenseRatioFacts(xml, 'C000007773')).toEqual({ ratio: 0.0015, asOf: '2025-12-31' });
  });

  it('reads prefixed xbrli contexts too', () => {
    const xml = INSTANCE
      .replace(/<context /g, '<xbrli:context ').replace(/<\/context>/g, '</xbrli:context>')
      .replace(/<(\/?)(entity|identifier|segment|period|startDate|endDate)>/g, '<$1xbrli:$2>')
      .replace(/<identifier /g, '<xbrli:identifier ').replace(/<\/identifier>/g, '</xbrli:identifier>');
    expect(xml).toContain('<xbrli:context id=');
    expect(parseExpenseRatioFacts(xml, 'C000007773')).toEqual({ ratio: 0.0014, asOf: '2026-06-30' });
  });
});

describe('parseShareholderReports / instanceFiles', () => {
  it('keeps N-CSR and N-CSRS (not amendments), newest filing first', () => {
    expect(parseShareholderReports(ATOM)).toEqual([
      { form: 'N-CSRS', filed: '2026-08-27', cik: '36405', accession: '000110465926102240' },
      { form: 'N-CSR', filed: '2026-02-26', cik: '36405', accession: '000110465926020000' },
    ]);
    expect(parseShareholderReports('<feed></feed>')).toEqual([]);
  });

  it('finds the extracted instance in index.json', () => {
    expect(instanceFiles(INDEX)).toEqual([{ name: 'tm2620528d8_ncsrs_htm.xml', size: 1_400_000 }]);
    expect(instanceFiles(null)).toEqual([]);
  });
});

describe('fetchSecExpenseRatio', () => {
  it('walks ticker → series → newest report → instance and returns the class figure', async () => {
    stubSec();
    expect(await fetchSecExpenseRatio('vfinx', T0)).toEqual({ ratio: 0.0014, asOf: '2026-06-30', form: 'N-CSRS' });
    expect(fetchText.mock.calls.map(c => c[0])).toEqual([
      'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=S000002839&type=N-CSR&dateb=&owner=include&count=10&output=atom',
      `${BASE}/tm2620528d8_ncsrs_htm.xml`,
    ]);
    expect(fetchJson.mock.calls.map(c => c[0])).toEqual([`${BASE}/index.json`]);
    expect(cache.get(CACHE_PREFIX + 'VFINX')).toEqual({ fetchedAt: T0, payload: { fee: { ratio: 0.0014, asOf: '2026-06-30', form: 'N-CSRS' } } });
  });

  it('returns null without any request when no SEC contact email is set', async () => {
    delete process.env.SEC_CONTACT_EMAIL;
    stubSec();
    expect(await fetchSecExpenseRatio('VFINX', T0)).toBeNull();
    expect(mappingGet).not.toHaveBeenCalled();
    expect(fetchText).not.toHaveBeenCalled();
    expect(fetchJson).not.toHaveBeenCalled();
    expect(cache.size).toBe(0);
  });

  it('a no-contact refusal mid-lookup is not cached', async () => {
    stubSec({ fail: () => new EdgarError('SEC contact email not set', 'no-contact') });
    expect(await fetchSecExpenseRatio('VFINX', T0)).toBeNull();
    expect(cache.size).toBe(0);
  });

  it('caches a figure for 30 days', async () => {
    stubSec();
    await fetchSecExpenseRatio('VFINX', T0);
    expect(await fetchSecExpenseRatio('VFINX', T0 + 29 * DAY)).toMatchObject({ ratio: 0.0014 });
    expect(instanceCalls).toBe(1);
    await fetchSecExpenseRatio('VFINX', T0 + 31 * DAY);
    expect(instanceCalls).toBe(2);
  });

  it('caches "SEC has nothing" for 14 days: not a fund, no class id, no report, no fact', async () => {
    stubSec({ atom: '<feed></feed>' });
    funds.set('NOREP', { cik: 1, seriesId: 'S000000001', classId: 'C000000001' });
    funds.set('NOFACT', { cik: 36405, seriesId: 'S000002839', classId: 'C000000001' });
    for (const s of ['AAPL', 'NOCLS', 'NOREP']) expect(await fetchSecExpenseRatio(s, T0)).toBeNull();
    stubSec();
    expect(await fetchSecExpenseRatio('NOFACT', T0)).toBeNull();
    for (const s of ['AAPL', 'NOCLS', 'NOREP', 'NOFACT']) expect(cache.get(CACHE_PREFIX + s)).toEqual({ fetchedAt: T0, payload: { fee: null } });
    // NOFACT tried both recent reports (each listing the same instance here).
    expect(instanceCalls).toBe(2);

    const calls = fetchText.mock.calls.length;
    await fetchSecExpenseRatio('NOFACT', T0 + 13 * DAY);
    expect(fetchText.mock.calls.length).toBe(calls);
    await fetchSecExpenseRatio('NOFACT', T0 + 15 * DAY);
    expect(fetchText.mock.calls.length).toBeGreaterThan(calls);
  });

  it('does not cache a failure, and serves an expired figure meanwhile', async () => {
    stubSec();
    await fetchSecExpenseRatio('VFINX', T0);
    stubSec({ fail: url => (url.includes('browse-edgar') ? new EdgarError('EDGAR HTTP 429', 'http', 429) : null) });
    expect(await fetchSecExpenseRatio('VFINX', T0 + 31 * DAY)).toEqual({ ratio: 0.0014, asOf: '2026-06-30', form: 'N-CSRS' });
    expect(cache.get(CACHE_PREFIX + 'VFINX')!.fetchedAt).toBe(T0);
    // An empty fund mapping (download failed) is transient too.
    mappingGet.mockImplementation(async () => new Map());
    expect(await fetchSecExpenseRatio('VFIAX', T0)).toBeNull();
    expect(cache.has(CACHE_PREFIX + 'VFIAX')).toBe(false);
    // With no identity, an expired figure is still served — from the cache only.
    delete process.env.SEC_CONTACT_EMAIL;
    fetchText.mockClear();
    expect(await fetchSecExpenseRatio('VFINX', T0 + 31 * DAY)).toMatchObject({ ratio: 0.0014 });
    expect(fetchText).not.toHaveBeenCalled();
  });

  it('skips oversized instances', async () => {
    stubSec({ index: { directory: { item: [{ name: 'big_htm.xml', size: String(16 * 1024 * 1024) }] } } });
    expect(await fetchSecExpenseRatio('VFINX', T0)).toBeNull();
    expect(instanceCalls).toBe(0);
    resetSecFeeState(); cache.clear();
    stubSec({ index: { directory: { item: [{ name: 'nosize_htm.xml', size: '' }] } }, instance: INSTANCE + ' '.repeat(16 * 1024 * 1024) });
    expect(await fetchSecExpenseRatio('VFINX', T0)).toBeNull();
  });

  it('shares one lookup between concurrent callers', async () => {
    stubSec();
    const [a, b] = await Promise.all([fetchSecExpenseRatio('VFINX', T0), fetchSecExpenseRatio('vfinx', T0)]);
    expect(a).toEqual(b);
    expect(instanceCalls).toBe(1);
  });

  it('returns null for an empty symbol without calling out', async () => {
    stubSec();
    expect(await fetchSecExpenseRatio('  ', T0)).toBeNull();
    expect(mappingGet).not.toHaveBeenCalled();
  });
});
