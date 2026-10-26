import { describe, it, expect } from 'vitest';
import atlas from 'world-atlas/countries-110m.json';
import {
  isGeographic, resolveAtlasName, maxGeographicPct, shadeT, shadeColor, BASE_RGB,
  ALPHA2_TO_NUMERIC, MARKER_COORDS, placeSlices, geoKey, type AtlasGeo,
} from './countryExposure.ts';

const GEOS: AtlasGeo[] = (atlas as unknown as { objects: { countries: { geometries: { id?: string | null; properties: { name: string } }[] } } })
  .objects.countries.geometries.map(g => ({ id: g.id, name: g.properties.name }));

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

describe('ALPHA2_TO_NUMERIC vs the bundled atlas', () => {
  const atlasIds = GEOS.filter(g => g.id != null).map(g => String(g.id));

  it('points every code at a geometry that exists', () => {
    for (const [code, id] of Object.entries(ALPHA2_TO_NUMERIC)) expect(atlasIds, code).toContain(id);
  });
  it('reaches every geometry that has an id (none is unmatchable)', () => {
    const covered = new Set(Object.values(ALPHA2_TO_NUMERIC));
    expect(atlasIds.filter(id => !covered.has(id))).toEqual([]);
  });
  it('has no duplicate numeric ids and well-formed keys', () => {
    const ids = Object.values(ALPHA2_TO_NUMERIC);
    expect(new Set(ids).size).toBe(ids.length);
    for (const [code, id] of Object.entries(ALPHA2_TO_NUMERIC)) { expect(code).toMatch(/^[A-Z]{2}$/); expect(id).toMatch(/^\d{3}$/); }
  });
  it('gives markers only to places without a polygon, at valid coordinates', () => {
    for (const [code, [lon, lat]] of Object.entries(MARKER_COORDS)) {
      expect(ALPHA2_TO_NUMERIC[code], code).toBeUndefined();
      expect(Math.abs(lon)).toBeLessThanOrEqual(180);
      expect(Math.abs(lat)).toBeLessThanOrEqual(90);
    }
    for (const code of ['HK', 'SG', 'BM', 'KY', 'JE', 'GG', 'IM', 'MO', 'BH', 'MT', 'MU', 'MC', 'LI', 'VG', 'MH', 'GI', 'CW', 'BB']) {
      expect(MARKER_COORDS[code], code).toBeDefined();
    }
  });
});

describe('placeSlices', () => {
  const s = (name: string, pct: number, code?: string) => ({ name, pct, code });
  const idOf = (name: string) => String(GEOS.find(g => g.name === name)!.id);

  it('matches polygons by ISO numeric id, not by name', () => {
    const p = placeSlices([
      s('United States', 0.5, 'US'), s('China', 0.1, 'CN'), s('United Kingdom', 0.05, 'GB'),
      s('Argentina', 0.01, 'AR'), s('Pakistan', 0.01, 'PK'), s('Czechia', 0.01, 'CZ'), s('South Korea', 0.01, 'KR'),
    ], GEOS);
    expect(p.unplaced).toEqual([]);
    expect(p.markers).toEqual([]);
    expect([...p.polygons.keys()].sort()).toEqual(['840', '156', '826', '032', '586', '203', '410'].sort());
    expect(p.polygons.get('840')!.name).toBe('United States');
    expect(p.polygons.get(idOf('Dem. Rep. Congo'))).toBeUndefined();
  });

  it('ignores a misleading display name when a code is present', () => {
    // The label would not resolve by name, but the code does.
    const p = placeSlices([s('Totally Different Label', 0.1, 'DE')], GEOS);
    expect(p.polygons.get('276')?.name).toBe('Totally Different Label');
  });

  it('matches Kosovo (null atlas id) through its code', () => {
    const p = placeSlices([s('Kosovo', 0.01, 'XK')], GEOS);
    expect(p.polygons.get(geoKey({ id: null, name: 'Kosovo' }))?.code).toBe('XK');
  });

  it('puts polygon-less places on the map as markers', () => {
    const p = placeSlices([s('Hong Kong', 0.04, 'HK'), s('Singapore', 0.02, 'SG'), s('Cayman Islands', 0.03, 'KY'), s('Bermuda', 0.01, 'BM')], GEOS);
    expect(p.polygons.size).toBe(0);
    expect(p.unplaced).toEqual([]);
    expect(p.markers.map(m => m.slice.code).sort()).toEqual(['BM', 'HK', 'KY', 'SG']);
    expect(p.markers.find(m => m.slice.code === 'SG')!.coordinates).toEqual(MARKER_COORDS.SG);
  });

  it('falls back to name aliases only for slices without a code', () => {
    const p = placeSlices([s('United States', 0.5), s('Czechia', 0.1), s('Hong Kong', 0.1)], GEOS);
    expect(p.polygons.get('840')).toBeDefined();
    expect(p.polygons.get('203')).toBeDefined();
    expect(p.unplaced.map(u => u.name)).toEqual(['Hong Kong']); // no code, no polygon: cannot be marked
  });

  it('leaves pseudo-countries and zero exposure out entirely, and reports unknowns', () => {
    const p = placeSlices([
      s('International / Other', 0.6), s('Crypto', 0.1), s('Bonds / Commodities / Cash', 0.1), s('Other', 0.05),
      s('Japan', 0, 'JP'), s('Atlantis', 0.01, 'ZZ'), s('Mystery', 0.01),
    ], GEOS);
    expect(p.polygons.size).toBe(0);
    expect(p.markers).toEqual([]);
    expect(p.unplaced.map(u => u.name)).toEqual(['Atlantis', 'Mystery']);
  });

  it('is case-insensitive on codes', () => {
    expect(placeSlices([s('Japan', 0.1, 'jp')], GEOS).polygons.get('392')).toBeDefined();
  });
});
