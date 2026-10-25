import { describe, it, expect } from 'vitest';
import { isGeographic, resolveAtlasName, maxGeographicPct, shadeT, shadeColor, BASE_RGB } from './countryExposure.ts';

const ATLAS = ['United States of America', 'Japan', 'Czechia', 'South Korea', 'Taiwan', 'Canada'];

describe('isGeographic', () => {
  it('flags the server look-through pseudo-countries', () => {
    for (const n of ['International / Other', 'Other', 'Crypto', 'Bonds / Commodities / Cash']) expect(isGeographic(n)).toBe(false);
    expect(isGeographic('Japan')).toBe(true);
  });
});

describe('resolveAtlasName', () => {
  it('maps United States to the atlas long name', () => {
    expect(resolveAtlasName('United States', ATLAS)).toBe('United States of America');
  });
  it('passes through names that already match', () => {
    expect(resolveAtlasName('Japan', ATLAS)).toBe('Japan');
    expect(resolveAtlasName('Taiwan', ATLAS)).toBe('Taiwan');
    expect(resolveAtlasName('Czechia', ATLAS)).toBe('Czechia');
  });
  it('tries alternate atlas spellings', () => {
    expect(resolveAtlasName('Czechia', ['Czech Rep.'])).toBe('Czech Rep.');
    expect(resolveAtlasName('Turkey', ['Türkiye'])).toBe('Türkiye');
  });
  it('returns null for countries without a polygon or unmapped ISIN codes', () => {
    expect(resolveAtlasName('Hong Kong', ATLAS)).toBeNull();
    expect(resolveAtlasName('XS', ATLAS)).toBeNull();
  });
});

describe('maxGeographicPct', () => {
  it('ignores pseudo-country buckets', () => {
    const data = [
      { name: 'International / Other', pct: 0.77 },
      { name: 'United States', pct: 0.16 },
      { name: 'Japan', pct: 0.02 },
    ];
    expect(maxGeographicPct(data)).toBe(0.16);
    expect(maxGeographicPct([{ name: 'Other', pct: 1 }])).toBe(0);
  });
});

describe('shadeT / shadeColor', () => {
  it('is 0 for no exposure, 1 at the max, monotonic in between', () => {
    expect(shadeT(0, 0.6)).toBe(0);
    expect(shadeT(0.6, 0.6)).toBeCloseTo(1);
    expect(shadeT(0.02, 0.6)).toBeGreaterThan(shadeT(0.005, 0.6));
    expect(shadeT(0.2, 0.6)).toBeGreaterThan(shadeT(0.02, 0.6));
  });
  it('keeps a 2% country visibly shaded when the US is 60%', () => {
    expect(shadeT(0.02, 0.6)).toBeGreaterThan(0.35); // a sqrt scale would give 0.18
  });
  it('clamps tiny exposures to the lightest step, never the base colour', () => {
    expect(shadeT(0.00001, 0.6)).toBe(0);
    expect(shadeColor(0.00001, 0.6)).not.toBe(`rgb(${BASE_RGB.join(',')})`);
  });
  it('handles a degenerate max', () => {
    expect(shadeT(0.0005, 0.0005)).toBe(1);
    expect(shadeT(0.5, 0)).toBe(0);
  });
});
