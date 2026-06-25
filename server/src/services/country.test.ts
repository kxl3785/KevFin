import { describe, it, expect } from 'vitest';
import { isinToCountry } from './country.js';

describe('isinToCountry', () => {
  it('maps a known ISIN country prefix to a country name', () => {
    expect(isinToCountry('US0378331005')).toBe('United States'); // Apple
    expect(isinToCountry('JP3633400001')).toBe('Japan');
    expect(isinToCountry('GB0002374006')).toBe('United Kingdom');
  });

  it('is case-insensitive on the prefix', () => {
    expect(isinToCountry('us0378331005')).toBe('United States');
  });

  it('returns the raw two-letter code when it is not in the table', () => {
    expect(isinToCountry('XX1234567890')).toBe('XX');
  });

  it('returns null for missing or too-short input', () => {
    expect(isinToCountry(undefined)).toBeNull();
    expect(isinToCountry('')).toBeNull();
    expect(isinToCountry('U')).toBeNull();
  });
});
