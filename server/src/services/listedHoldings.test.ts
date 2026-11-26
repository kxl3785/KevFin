import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { LISTED_HOLDINGS } from '../util/assumptions.js';
import {
  parse13fInfoTable, latest13f, listedCompanyKey, dashClass, buildLookThrough, openListedCompanies,
  MAX_FILING_AGE_DAYS, type ListedLookThrough,
} from './listedHoldings.js';

// Berkshire Hathaway's own stock portfolio, from a trimmed copy of its real
// 13F-HR for 2026-09-30 (public SEC data). Nothing here touches the network.
vi.mock('./figi.js', () => ({ knownTicker: () => undefined, queueTickerLookups: () => {} }));
const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/edgar/${name}`, import.meta.url), 'utf8');
const BRK = LISTED_HOLDINGS.BRK;

describe('parse13fInfoTable', () => {
  const rows = parse13fInfoTable(fixture('brk-13f-infotable.xml'));

  it('adds up each CUSIP across the managers a 13F splits it between', () => {
    expect(rows.map(r => r.name)).toEqual([
      'APPLE INC', 'AMERICAN EXPRESS CO', 'COCA COLA CO', 'ALPHABET INC', 'CHUBB LIMITED', 'ALPHABET INC', 'ALLY FINL INC',
    ]);
    expect(rows.find(r => r.cusip === '037833100')?.value).toBe(75901188420);
    // Ally: one row per manager combination in the filing, summed.
    const ally = [...fixture('brk-13f-infotable.xml').matchAll(/<cusip>02005N100<\/cusip>\s*<value>(\d+)<\/value>/g)].map(m => Number(m[1]));
    expect(ally.length).toBeGreaterThan(1);
    expect(rows.find(r => r.cusip === '02005N100')?.value).toBe(ally.reduce((a, b) => a + b, 0));
    // Alphabet's two share classes are two CUSIPs.
    expect(rows.filter(r => r.name === 'ALPHABET INC').map(r => r.title)).toEqual(['CAP STK CL A', 'CAP STK CL C']);
  });

  it('leaves out option positions', () => {
    const xml = `<informationTable><infoTable><nameOfIssuer>X CORP</nameOfIssuer><titleOfClass>COM</titleOfClass><cusip>123456789</cusip><value>100</value></infoTable>
      <infoTable><nameOfIssuer>X CORP</nameOfIssuer><titleOfClass>COM</titleOfClass><cusip>123456789</cusip><value>900</value><putCall>Put</putCall></infoTable></informationTable>`;
    expect(parse13fInfoTable(xml)).toEqual([{ cusip: '123456789', name: 'X CORP', title: 'COM', value: 100 }]);
  });
});

describe('latest13f', () => {
  it('takes the newest original 13F-HR from the submissions list', () => {
    expect(latest13f(JSON.parse(fixture('brk-submissions.json')))).toEqual({ accession: '0001193125-26-463399', period: '2026-09-30', filed: '2026-11-16' });
  });
  it('skips amendments and returns null when there is none', () => {
    const raw = { filings: { recent: { form: ['13F-HR/A'], accessionNumber: ['0000950123-25-008361'], reportDate: ['2025-03-31'], filingDate: ['2025-08-14'] } } };
    expect(latest13f(raw)).toBeNull();
  });
});

describe('recognising Berkshire', () => {
  it('in every spelling funds use', () => {
    for (const symbol of ['BRK-B', 'BRK.B', 'BRK/B', 'BRK B', 'brk-a', 'BRK.A']) expect(listedCompanyKey({ symbol }), symbol).toBe('BRK');
    expect(listedCompanyKey({ symbol: 'X', cusip: '084670702' })).toBe('BRK');
    expect(listedCompanyKey({ symbol: 'X', isin: 'US0846701086' })).toBe('BRK');
    // An N-PORT row with no ticker: keyed by its normalized name.
    expect(listedCompanyKey({ symbol: 'BERKSHIRE HATHAWAY', name: 'BERKSHIRE HATHAWAY INC-CL B' })).toBe('BRK');
  });
  it('and nothing else', () => {
    expect(listedCompanyKey({ symbol: 'BRKR', name: 'Bruker' })).toBeNull();
    expect(listedCompanyKey({ symbol: 'AAPL', name: 'Berkshire Hathaway Inc' })).toBeNull(); // a ticker wins over a name
    expect(listedCompanyKey({ symbol: '— bonds —', name: 'BERKSHIRE HATHAWAY', kind: 'bond' })).toBeNull();
    expect(dashClass('BRK.B')).toBe('BRK-B');
  });
});

describe('buildLookThrough guards', () => {
  const filing = { period: '2026-09-30', filed: '2026-11-16' };
  const now = Date.parse('2026-11-26T00:00:00Z');
  const pos = (symbol: string, value: number) => ({ symbol, name: symbol, cusip: '000000000', value });
  const positions = [pos('AAPL', 75.9e9), pos('AXP', 46.1e9), pos('KO', 34.4e9)];

  it('opens the listed part as a share of market cap', () => {
    const lt = buildLookThrough('BRK', BRK, filing, positions, [1.2308e12, 1.2324e12], now)!;
    expect(lt.listedShare).toBeCloseTo(156.4e9 / 1.2308e12, 9);
    expect(lt.positions[0].share).toBeCloseTo(75.9e9 / 1.2308e12, 9);
    expect(lt.note).toContain('12.7% of Berkshire Hathaway');
    expect(lt.note).toContain('quarter ended 2026-09-30');
    expect(lt.remainderName).toBe('Berkshire Hathaway (own businesses and cash)');
  });
  it('refuses without a market cap, or when the share classes disagree', () => {
    expect(buildLookThrough('BRK', BRK, filing, positions, [null, null], now)).toBeNull();
    expect(buildLookThrough('BRK', BRK, filing, positions, [1.2e12, 2.0e12], now)).toBeNull();
    expect(buildLookThrough('BRK', BRK, filing, positions, [null, 1.2e12], now)).not.toBeNull();
  });
  it('refuses an implausible listed share or a stale filing', () => {
    expect(buildLookThrough('BRK', BRK, filing, positions, [170e9], now)).toBeNull();   // > 90% of the company
    expect(buildLookThrough('BRK', BRK, filing, positions, [5e12], now)).toBeNull();    // < 5%
    const old = { period: '2025-12-31', filed: '2026-02-17' };
    expect((now - Date.parse('2025-12-31')) / 86400e3).toBeGreaterThan(MAX_FILING_AGE_DAYS);
    expect(buildLookThrough('BRK', BRK, old, positions, [1.23e12], now)).toBeNull();
  });
});

describe('openListedCompanies', () => {
  const lt: ListedLookThrough = {
    key: 'BRK', symbol: 'BRK-B', remainderName: BRK.remainderName, asOf: '2026-09-30', filed: '2026-11-16', marketCap: 1e12,
    listedShare: 0.25, sector: 'Financial Services', note: '',
    positions: [
      { symbol: 'AAPL', name: 'APPLE INC', cusip: '037833100', value: 1.5e11, share: 0.15, country: 'United States' },
      { symbol: 'CB', name: 'CHUBB LIMITED', cusip: 'H1467J104', value: 1e11, share: 0.1, country: 'Switzerland' },
    ],
  };
  const lts = new Map([['BRK', lt]]);

  it('replaces the company with its stocks plus what stays, keeping the total exactly', () => {
    const list = [{ symbol: 'AAPL', name: 'Apple', percent: 0.07 }, { symbol: 'BRK.B', name: 'Berkshire', percent: 0.02 }];
    const out = openListedCompanies(list, lts);
    expect(out.map(c => [c.symbol, c.percent])).toEqual([
      ['AAPL', 0.07], ['AAPL', 0.02 * 0.15], ['CB', 0.02 * 0.1], ['BRK-B', 0.02 * 0.75],
    ]);
    expect(out.slice(1).every(c => c.via === 'BRK')).toBe(true);
    expect(out[3].name).toBe('Berkshire Hathaway (own businesses and cash)');
    expect(out.reduce((s, c) => s + c.percent, 0)).toBeCloseTo(0.09, 12);
    // Opening is idempotent: the remainder row isn't opened again.
    expect(openListedCompanies(out, lts)).toEqual(out);
  });

  it('leaves the list alone when nothing can be opened', () => {
    const list = [{ symbol: 'BRK-B', name: 'Berkshire', percent: 1 }];
    expect(openListedCompanies(list, new Map())).toBe(list);
  });
});
