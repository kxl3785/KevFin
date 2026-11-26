import { describe, it, expect } from 'vitest';
import { resolveCompanies, namesAgree, cusipOf, possiblyLocal, normalizeIssuerName, type Sighting } from './companyIdentity.js';

// The rows each list of sightings resolves to, as [symbol, name, aliases,
// total weight], plus whether sightings i and j landed together.
function rows(list: Sighting[]) {
  const { groupOf, companies } = resolveCompanies(list);
  const weight = companies.map(() => 0);
  list.forEach((s, i) => { weight[groupOf[i]] += s.weight; });
  return companies.map((c, g) => [c.symbol, c.name, c.aliases, weight[g]]);
}
const together = (list: Sighting[], i: number, j: number) => {
  const { groupOf } = resolveCompanies(list);
  return groupOf[i] === groupOf[j];
};
const s = (symbol: string, name: string, weight: number, extra: Partial<Sighting> = {}): Sighting => ({ symbol, name, weight, ...extra });

describe('helpers', () => {
  it('reads a CUSIP out of a US or CA ISIN, and only those', () => {
    expect(cusipOf({ isin: 'US0378331005' })).toBe('037833100');
    expect(cusipOf({ isin: 'CA11271J1075' })).toBe('11271J107');
    expect(cusipOf({ isin: 'TW0002330008' })).toBeNull();
    expect(cusipOf({ cusip: '084670702', isin: 'US0846707026' })).toBe('084670702');
    expect(cusipOf({ isin: 'junk' })).toBeNull();
  });
  it('treats a sighting with a non-US ISIN as possibly a local code', () => {
    expect(possiblyLocal({ isin: 'TW0002330008' })).toBe(true);
    expect(possiblyLocal({ isin: 'IE00B4BNMY34' })).toBe(true);
    expect(possiblyLocal({ isin: 'US0378331005' })).toBe(false);
    expect(possiblyLocal({})).toBe(false);
  });
  it('agrees on names that are equal once normalized, or cut short', () => {
    expect(normalizeIssuerName('ALPHABET INC-CL A')).toBe('ALPHABET');
    expect(namesAgree('ACCENTURE PLC IRELAND SHS CLASS A', 'ACCENTURE PLC-A')).toBe(true);
    expect(namesAgree('FIDELITY NATIONA', 'Fidelity National Information Services Inc')).toBe(true);
    expect(namesAgree('SAMSUNG ELECTRON', 'Samsung Electronics Co Ltd')).toBe(true);
    expect(namesAgree('BROOKFIELD CORP', 'DANONE')).toBe(false);
    expect(namesAgree('ALLETE INC', 'Allegro.eu SA')).toBe(false);
    // A prefix under 4 characters says nothing.
    expect(namesAgree('ABC', 'ABCAM PLC')).toBe(false);
    expect(namesAgree('', '')).toBe(false);
  });
});

describe('R1: same ISIN or CUSIP', () => {
  it('joins TSMC under two tickers, shown as TSM with 2330 folded in', () => {
    const list = [
      s('TSM', 'Taiwan Semiconductor Manufacturing Co Ltd', 6675, { isin: 'TW0002330008' }),
      s('2330', 'TSMC', 1376, { isin: 'TW0002330008' }),
    ];
    expect(rows(list)).toEqual([['TSM', 'Taiwan Semiconductor Manufacturing Co Ltd', ['2330'], 8051]]);
  });
  it('lets a 13F row with only a CUSIP meet a fund row with only the ISIN', () => {
    const list = [s('AAPL', 'APPLE INC', 10, { cusip: '037833100' }), s('AAPL', 'Apple Inc', 90, { isin: 'US0378331005' })];
    expect(together(list, 0, 1)).toBe(true);
    // …even under different symbols (a named row has no ticker at all).
    expect(together([s('XYZ', 'X', 1, { cusip: '037833100' }), s('APPLE', 'APPLE', 1, { isin: 'US0378331005', named: true })], 0, 1)).toBe(true);
  });
  it('joins a local share and its ADR through any chain of identifiers', () => {
    // DFEMX holds ICICI's Indian share and its US ADR under IBN; Vanguard the
    // Indian share as ICICIBANK.
    const list = [
      s('IBN', 'ICICI Bank Ltd', 300, { isin: 'INE090A01021' }),
      s('IBN', 'ICICI Bank Ltd', 50, { isin: 'US45104G1040' }),
      s('ICICIBANK', 'ICICI BANK LTD', 24, { isin: 'INE090A01021' }),
    ];
    expect(rows(list)).toEqual([['IBN', 'ICICI Bank Ltd', ['ICICIBANK'], 374]]);
  });
});

describe('R2: same CUSIP issuer joins share classes', () => {
  const pairs: [string, string, string, string][] = [
    ['GOOGL', 'US02079K3059', 'GOOG', 'US02079K1079'],
    ['BRK-B', 'US0846707026', 'BRK-A', 'US0846701086'],
    ['FOXA', 'US35137L1052', 'FOX', 'US35137L2043'],
    ['NWSA', 'US65249B1098', 'NWS', 'US65249B2088'],
    ['HEI', 'US4228061093', 'HEI-A', 'US4228062083'],
    ['LEN', 'US5260571048', 'LEN-B', 'US5260573028'],
  ];
  it.each(pairs)('%s and %s', (a, ia, b, ib) => {
    const list = [s(a, a, 10, { isin: ia }), s(b, b, 5, { isin: ib })];
    expect(rows(list)).toEqual([[a, a, [b], 15]]);
  });
  it('works from bare CUSIPs too (Berkshire’s 13F)', () => {
    expect(together([s('GOOGL', 'ALPHABET INC', 1, { cusip: '02079K305' }), s('GOOG', 'ALPHABET INC', 1, { cusip: '02079K107' })], 0, 1)).toBe(true);
  });
  it('keeps issuers that only look alike apart', () => {
    expect(together([s('FIS', 'FIDELITY NATIONA', 1, { cusip: '31620M106' }), s('FNF', 'FIDELITY NATIONA', 1, { cusip: '31620R303' })], 0, 1)).toBe(false);
    expect(together([s('BN', 'BROOKFIELD CORP', 1, { cusip: '11271J107' }), s('BAM', 'BROOKFIELD-A', 1, { cusip: '113004105' })], 0, 1)).toBe(false);
  });
  it('never joins funds by issuer: every ETF of one trust shares it', () => {
    const list = [s('IVV', 'ISHARES CORE S&P 500', 1, { cusip: '464287200', fund: true }), s('IWM', 'ISHARES RUSSELL 2000', 1, { cusip: '464287655', fund: true })];
    expect(together(list, 0, 1)).toBe(false);
  });
  it('only joins equity issues (a letter in the issue number is debt or another kind)', () => {
    expect(together([s('XYZ', 'X CORP', 1, { cusip: '98765A101' }), s('X BOND', 'X CORP', 1, { cusip: '98765AAB2', named: true })], 0, 1)).toBe(false);
  });
});

describe('R3: same symbol', () => {
  it('joins sightings taken at their word (no ISIN, or a US one)', () => {
    const list = [s('AAPL', 'Apple Inc', 100), s('AAPL', 'Apple', 7), s('AAPL', 'APPLE INC', 50, { isin: 'US0378331005' })];
    expect(rows(list)).toEqual([['AAPL', 'Apple Inc', [], 157]]);
  });
  it('joins a direct holding to a foreign-domiciled fund row when the names agree (ACN, IE ISIN)', () => {
    const list = [s('ACN', 'ACCENTURE PLC IRELAND SHS CLASS A', 100), s('ACN', 'ACCENTURE PLC-A', 400, { isin: 'IE00B4BNMY34' })];
    expect(rows(list)).toEqual([['ACN', 'ACCENTURE PLC-A', [], 500]]);
  });
  it('keeps two companies under one exchange code apart (BN: Brookfield, Danone)', () => {
    const list = [
      s('BN', 'BROOKFIELD CORP', 65, { isin: 'CA11271J1075' }),
      s('BN', 'DANONE', 38, { isin: 'FR0000120644' }),
      s('BN', 'Brookfield Corp', 20), // held directly
    ];
    expect(rows(list)).toEqual([['BN', 'BROOKFIELD CORP', [], 85], ['BN', 'DANONE', [], 38]]);
  });
  it('keeps 1211 apart: BYD and Saudi Arabian Mining', () => {
    const list = [s('1211', 'BYD CO LTD-H', 100, { isin: 'CNE100000296' }), s('1211', 'SAUDI ARABIAN MI', 50, { isin: 'SA123GA0ITH7' })];
    expect(together(list, 0, 1)).toBe(false);
  });
  it('keeps a US ticker apart from a foreign code that collides with it (ALE: Allete, Allegro.eu)', () => {
    const list = [s('ALE', 'ALLETE INC', 30), s('ALE', 'ALLETE INC', 20, { isin: 'US0185223007' }), s('ALE', 'Allegro.eu SA', 60, { isin: 'LU2237380790' })];
    expect(rows(list)).toEqual([['ALE', 'ALLETE INC', [], 50], ['ALE', 'Allegro.eu SA', [], 60]]);
  });
  it('treats symbols case- and space-insensitively', () => {
    expect(together([s('aapl ', 'Apple', 1), s('AAPL', 'Apple', 1)], 0, 1)).toBe(true);
  });
});

describe('named sightings (the symbol is a company name)', () => {
  it('take the ticker of the company their identifier links to', () => {
    const list = [
      s('TAIWAN SEMICONDUCTOR MANUFACTURING', 'TAIWAN SEMICONDUCTOR MANUFACTURING', 500, { isin: 'TW0002330008', named: true }),
      s('2330', 'TSMC', 100, { isin: 'TW0002330008' }),
    ];
    expect(rows(list)).toEqual([['2330', 'TSMC', [], 600]]);
  });
  it('without an identifier, join by the same normalized name, as before', () => {
    const list = [s('BERKSHIRE HATHAWAY', 'BERKSHIRE HATHAWAY INC-CL B', 10, { named: true }), s('BERKSHIRE HATHAWAY', 'Berkshire Hathaway Inc', 30, { named: true })];
    expect(rows(list)).toEqual([['BERKSHIRE HATHAWAY', 'Berkshire Hathaway Inc', [], 40]]);
  });
  it('never meet a ticker that happens to be spelled like the name', () => {
    expect(together([s('META', 'META', 1, { named: true }), s('META', 'Meta Platforms', 1)], 0, 1)).toBe(false);
  });
  it('join each other by name-symbol even across share classes (Petrobras common and preferred)', () => {
    const list = [
      s('PETR4', 'PETROBRAS-PREF', 34, { isin: 'BRPETRACNPR6' }),
      s('PETR3', 'PETROBRAS', 31, { isin: 'BRPETRACNOR9' }),
      s('PETROLEO BRASILEIRO PETROBRAS', 'Petroleo Brasileiro SA', 173, { isin: 'BRPETRACNPR6', named: true }),
      s('PETROLEO BRASILEIRO PETROBRAS', 'Petroleo Brasileiro SA', 170, { isin: 'BRPETRACNOR9', named: true }),
    ];
    // A real ticker is shown even though the name keys carry more weight.
    expect(rows(list)).toEqual([['PETR4', 'PETROBRAS-PREF', ['PETR3'], 408]]);
  });
});

describe('display', () => {
  it('prefers a ticker taken at its word over a possible local code, then a letter over a digit', () => {
    // HDB seen on a direct holding beats the heavier Indian code.
    const list = [s('HDFCBANK', 'HDFC BANK LTD', 900, { isin: 'INE040A01034' }), s('HDB', 'HDFC Bank Ltd', 10), s('HDB', 'HDFC Bank Ltd', 5, { isin: 'INE040A01034' })];
    expect(rows(list)[0].slice(0, 3)).toEqual(['HDB', 'HDFC Bank Ltd', ['HDFCBANK']]);
    // Both local: a letter beats a digit regardless of weight.
    expect(rows([s('000660', 'SK HYNIX INC', 465, { isin: 'KR7000660001' }), s('SKHY', 'SK hynix Inc', 2, { isin: 'KR7000660001' })])[0][0]).toBe('SKHY');
  });
  it('then the heaviest, then alphabetical — whatever order the sources arrive in', () => {
    const list = [
      s('BBB', 'Co', 5, { isin: 'GB0000000001' }), s('AAA', 'Co', 5, { isin: 'GB0000000001' }),
      s('CCC', 'Co', 7, { isin: 'GB0000000001' }), s('CCC', 'Co too', 1, { isin: 'GB0000000001' }),
    ];
    const forward = rows(list), backward = rows([...list].reverse());
    expect(forward).toEqual([['CCC', 'Co', ['AAA', 'BBB'], 18]]);
    expect(backward).toEqual(forward);
    expect(rows(list.slice(0, 2))[0][0]).toBe('AAA');
  });
  it('lists the other tickers heaviest first, each once, never the shown one or a name key', () => {
    const list = [
      s('GOOGL', 'ALPHABET INC-A', 40, { isin: 'US02079K3059' }),
      s('GOOG', 'ALPHABET INC-C', 30, { isin: 'US02079K1079' }),
      s('GOOG', 'ALPHABET INC-C', 30, { isin: 'US02079K1079' }),
      s('ALPHABET', 'ALPHABET INC', 50, { isin: 'US02079K1079', named: true }),
    ];
    // GOOG outweighs GOOGL here, so GOOG is shown.
    expect(rows(list)).toEqual([['GOOG', 'ALPHABET INC-C', ['GOOGL'], 150]]);
  });
  it('numbers groups in order of their first sighting', () => {
    const { groupOf, companies } = resolveCompanies([s('B', 'B', 1), s('A', 'A', 1), s('B', 'B', 1)]);
    expect(groupOf).toEqual([0, 1, 0]);
    expect(companies.map(c => c.symbol)).toEqual(['B', 'A']);
  });
  it('handles no sightings', () => {
    expect(resolveCompanies([])).toEqual({ groupOf: [], companies: [] });
  });
});
