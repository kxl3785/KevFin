import { describe, it, expect } from 'vitest';
import {
  isinToCountry, countryNameForCode, countryCode, canonicalCountryName, relabelCountry, INTERNATIONAL_OTHER,
} from './country.js';

describe('isinToCountry', () => {
  it('maps a known ISIN country prefix to a country name', () => {
    expect(isinToCountry('US0378331005')).toBe('United States'); // Apple
    expect(isinToCountry('JP3633400001')).toBe('Japan');
    expect(isinToCountry('GB0002374006')).toBe('United Kingdom');
  });

  it('is case-insensitive on the prefix', () => {
    expect(isinToCountry('us0378331005')).toBe('United States');
  });

  it('names codes the old table did not have instead of returning the raw code', () => {
    expect(isinToCountry('AR0000000001')).toBe('Argentina');
    expect(isinToCountry('PK0000000001')).toBe('Pakistan');
    expect(isinToCountry('NG0000000001')).toBe('Nigeria');
  });

  it('puts non-country prefixes in International / Other', () => {
    for (const p of ['XS', 'EU', 'XC', 'QZ', 'XX', 'ZZ']) expect(isinToCountry(`${p}1234567890`)).toBe(INTERNATIONAL_OTHER);
  });

  it('returns null for missing or too-short input', () => {
    expect(isinToCountry(undefined)).toBeNull();
    expect(isinToCountry('')).toBeNull();
    expect(isinToCountry('U')).toBeNull();
  });
});

describe('countryNameForCode', () => {
  it('keeps the established labels', () => {
    const want: Record<string, string> = {
      US: 'United States', KR: 'South Korea', TR: 'Turkey', CZ: 'Czechia', HK: 'Hong Kong', VN: 'Vietnam',
      TW: 'Taiwan', AE: 'United Arab Emirates', KY: 'Cayman Islands', BM: 'Bermuda', JE: 'Jersey',
    };
    for (const [code, name] of Object.entries(want)) expect(countryNameForCode(code)).toBe(name);
  });

  it('normalises CLDR oddities', () => {
    expect(countryNameForCode('MO')).toBe('Macao');
    expect(countryNameForCode('RU')).toBe('Russia');
    expect(countryNameForCode('CI')).toBe("Côte d'Ivoire");
    expect(countryNameForCode('CD')).toBe('DR Congo');
    for (const c of ['HK', 'MO', 'TR', 'MM', 'CI', 'PS', 'CG']) {
      expect(countryNameForCode(c)).not.toMatch(/SAR|Türkiye|\(|’|Territories| - /);
    }
  });

  it('names every assigned code with a plain, non-code label', () => {
    // 249 ISO 3166-1 codes + XK
    const codes: string[] = [];
    for (const a of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') for (const b of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      if (countryNameForCode(a + b)) codes.push(a + b);
    }
    expect(codes).toHaveLength(250);
    for (const c of codes) {
      const n = countryNameForCode(c)!;
      expect(n.length).toBeGreaterThan(2);
      expect(n).not.toBe('Unknown Region');
    }
  });

  it('rejects non-countries', () => {
    for (const c of ['XS', 'EU', 'UN', 'XC', 'QZ', 'ZZ', 'XX', 'AC', 'EZ', '', 'USA', 'U1']) expect(countryNameForCode(c)).toBeNull();
    expect(countryNameForCode(undefined)).toBeNull();
  });

  it('accepts lower case and whitespace', () => {
    expect(countryNameForCode(' ky ')).toBe('Cayman Islands');
  });
});

describe('countryCode', () => {
  it('is the inverse of countryNameForCode for every real country', () => {
    for (const a of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') for (const b of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      const n = countryNameForCode(a + b);
      if (n) expect(countryCode(n)).toBe(a + b);
    }
  });
  it('returns null for pseudo-countries and unknown labels', () => {
    for (const n of [INTERNATIONAL_OTHER, 'Other', 'Crypto', 'Bonds / Commodities / Cash', 'Atlantis', '']) expect(countryCode(n)).toBeNull();
    expect(countryCode(undefined)).toBeNull();
  });
  it('knows common alternate spellings', () => {
    expect(countryCode('Türkiye')).toBe('TR');
    expect(countryCode('Korea')).toBe('KR');
    expect(countryCode('United States of America')).toBe('US');
    expect(countryCode('hong kong')).toBe('HK');
  });
});

describe('canonicalCountryName / relabelCountry', () => {
  it('canonicalises alternate spellings and leaves pseudo-buckets alone', () => {
    expect(canonicalCountryName('Türkiye')).toBe('Turkey');
    expect(canonicalCountryName('Japan')).toBe('Japan');
    expect(canonicalCountryName('Crypto')).toBe('Crypto');
  });
  it('turns raw codes stored by older versions into names', () => {
    expect(relabelCountry('AR')).toBe('Argentina');
    expect(relabelCountry('ky')).toBe('Cayman Islands');
    expect(relabelCountry('XS')).toBe(INTERNATIONAL_OTHER);
    expect(relabelCountry('Japan')).toBe('Japan');
    expect(relabelCountry('Bonds / Commodities / Cash')).toBe('Bonds / Commodities / Cash');
  });
});
