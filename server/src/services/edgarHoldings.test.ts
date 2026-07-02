import { describe, it, expect } from 'vitest';
import {
  normalizeIssuerName, parseMfTickers, parseCompanyTickers, parseLatestFilingPath, parseNport,
} from './edgarHoldings.js';

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

  it('maps upper-cased tickers to their cik + series id', () => {
    const map = parseMfTickers(raw);
    expect(map.get('IVV')).toEqual({ cik: 1100663, seriesId: 'S000004310' });
    expect(map.get('SPY')).toEqual({ cik: 884394, seriesId: 'S000006408' });
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
    expect(parseMfTickers(reordered).get('VTI')).toEqual({ cik: 36405, seriesId: 'S000002848' });
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

  it('lumps non-equity positions and skips shorts/negatives', () => {
    const lump = constituents.find(c => c.symbol === '— non-equity —');
    expect(lump!.percent).toBeCloseTo(0.02); // 1.5% debt + 0.5% cash; -0.3% short excluded
    expect(lump!.country).toBe('Bonds / Commodities / Cash');
    expect(constituents.some(c => c.name === 'Short Future Payable')).toBe(false);
  });

  it('sorts equity constituents by descending weight', () => {
    const equities = constituents.filter(c => c.symbol !== '— non-equity —');
    expect(equities.map(c => c.percent)).toEqual([...equities.map(c => c.percent)].sort((a, b) => b - a));
  });

  it('returns no constituents for an empty filing', () => {
    expect(parseNport('<edgarSubmission></edgarSubmission>', tickers).constituents).toEqual([]);
  });
});
