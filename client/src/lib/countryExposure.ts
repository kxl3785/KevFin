// Pure helpers behind the Country / Region Exposure map: which allocation
// buckets are real countries, how our country labels map onto the world-atlas
// geometry names, and the colour scale.

// Pseudo-countries produced by the server's look-through. They are valid rows
// in the breakdown list but have no geometry, so they must be left out of the
// map's colour scale (otherwise a 75% "International / Other" bucket flattens
// every real country to near-zero shade).
export const NON_GEOGRAPHIC = new Set([
  'International / Other', 'Other', 'Crypto', 'Bonds / Commodities / Cash',
]);

export const isGeographic = (name: string) => !NON_GEOGRAPHIC.has(name);

// Our label (country.ts) -> candidate names used by world-atlas countries-110m
// (Natural Earth). Anything not listed is tried as-is.
const ATLAS_ALIASES: Record<string, string[]> = {
  'United States': ['United States of America', 'United States'],
  'Czechia': ['Czechia', 'Czech Rep.', 'Czech Republic'],
  'South Korea': ['South Korea', 'Korea', 'Republic of Korea'],
  'Turkey': ['Turkey', 'Türkiye'],
  'Vietnam': ['Vietnam', 'Viet Nam'],
  'United Arab Emirates': ['United Arab Emirates'],
};

export function atlasNameCandidates(label: string): string[] {
  return ATLAS_ALIASES[label] ?? [label];
}

// Resolve our label to a name that exists in the atlas, or null when the
// country has no polygon at 110m resolution (Hong Kong, Singapore, Bermuda,
// Cayman Islands, Jersey, ... or an unmapped ISIN prefix such as "XS").
export function resolveAtlasName(label: string, atlasNames: Iterable<string>): string | null {
  const have = new Set(atlasNames);
  return atlasNameCandidates(label).find(n => have.has(n)) ?? null;
}

// Largest share among real countries only.
export function maxGeographicPct(data: { name: string; pct: number }[]): number {
  return data.reduce((m, d) => (isGeographic(d.name) && d.pct > m ? d.pct : m), 0);
}

// Smallest exposure that still gets a distinct shade; anything below is
// clamped to the lightest step so it never vanishes into the base colour.
export const MIN_SHADE_PCT = 0.001; // 0.1% of the portfolio

// 0..1 position on a log scale between MIN_SHADE_PCT and maxPct. A linear or
// sqrt scale hides everything but the dominant country when the US is 60%+.
export function shadeT(pct: number, maxPct: number): number {
  if (!(pct > 0) || !(maxPct > 0)) return 0;
  if (maxPct <= MIN_SHADE_PCT) return 1;
  const t = Math.log(pct / MIN_SHADE_PCT) / Math.log(maxPct / MIN_SHADE_PCT);
  return Math.min(1, Math.max(0, t));
}

export const BASE_RGB = [32, 36, 46];     // #20242e: no exposure
export const LOW_RGB = [58, 82, 150];     // smallest exposure: clearly distinct from base
export const HIGH_RGB = [138, 172, 255];  // largest exposure

export function shadeColor(pct: number, maxPct: number): string {
  const t = shadeT(pct, maxPct);
  const c = LOW_RGB.map((lo, i) => Math.round(lo + (HIGH_RGB[i] - lo) * t));
  return `rgb(${c.join(',')})`;
}
