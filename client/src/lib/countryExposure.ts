// Pure helpers behind the Country / Region Exposure map: which allocation
// buckets are real countries, how they are matched to the world-atlas geometry
// (by ISO 3166-1 numeric id; by name only for slices without a code), where the
// places with no polygon get a marker, and the colour scale.

// Pseudo-countries produced by the server's look-through. They are valid rows
// in the breakdown list but have no geometry, so they must be left out of the
// map's colour scale (otherwise a 75% "International / Other" bucket flattens
// every real country to near-zero shade).
export const NON_GEOGRAPHIC = new Set([
  'International / Other', 'Other', 'Crypto', 'Bonds / Commodities / Cash',
]);

export const isGeographic = (name: string) => !NON_GEOGRAPHIC.has(name);

// ISO 3166-1 alpha-2 -> numeric code, as the zero-padded string that world-atlas
// countries-110m uses for each geometry's `id`. Covers every country that has a
// polygon in that atlas (see the test, which checks both directions). Kosovo has
// no numeric code and an id of null in the atlas; it is matched by name instead
// (ID_LESS_NAMES). Places in MARKER_COORDS below have no polygon at all.
export const ALPHA2_TO_NUMERIC: Record<string, string> = {
  AF: '004', AL: '008', AQ: '010', DZ: '012', AO: '024', AR: '032', AM: '051', AU: '036', AT: '040',
  AZ: '031', BS: '044', BD: '050', BY: '112', BE: '056', BZ: '084', BJ: '204', BT: '064', BO: '068',
  BA: '070', BW: '072', BR: '076', BN: '096', BG: '100', BF: '854', BI: '108', KH: '116', CM: '120',
  CA: '124', CF: '140', TD: '148', CL: '152', CN: '156', CO: '170', CG: '178', CD: '180', CR: '188',
  CI: '384', HR: '191', CU: '192', CY: '196', CZ: '203', DK: '208', DJ: '262', DO: '214', EC: '218',
  EG: '818', SV: '222', GQ: '226', ER: '232', EE: '233', SZ: '748', ET: '231', FK: '238', FJ: '242',
  FI: '246', FR: '250', TF: '260', GA: '266', GM: '270', GE: '268', DE: '276', GH: '288', GR: '300',
  GL: '304', GT: '320', GN: '324', GW: '624', GY: '328', HT: '332', HN: '340', HU: '348', IS: '352',
  IN: '356', ID: '360', IR: '364', IQ: '368', IE: '372', IL: '376', IT: '380', JM: '388', JP: '392',
  JO: '400', KZ: '398', KE: '404', KP: '408', KR: '410', KW: '414', KG: '417', LA: '418', LV: '428',
  LB: '422', LS: '426', LR: '430', LY: '434', LT: '440', LU: '442', MG: '450', MW: '454', MY: '458',
  ML: '466', MR: '478', MX: '484', MD: '498', MN: '496', ME: '499', MA: '504', MZ: '508', MM: '104',
  NA: '516', NP: '524', NL: '528', NC: '540', NZ: '554', NI: '558', NE: '562', NG: '566', MK: '807',
  NO: '578', OM: '512', PK: '586', PS: '275', PA: '591', PG: '598', PY: '600', PE: '604', PH: '608',
  PL: '616', PT: '620', PR: '630', QA: '634', RO: '642', RU: '643', RW: '646', SA: '682', SN: '686',
  RS: '688', SL: '694', SK: '703', SI: '705', SB: '090', SO: '706', ZA: '710', SS: '728', ES: '724',
  LK: '144', SD: '729', SR: '740', SE: '752', CH: '756', SY: '760', TW: '158', TJ: '762', TZ: '834',
  TH: '764', TL: '626', TG: '768', TT: '780', TN: '788', TR: '792', TM: '795', UG: '800', UA: '804',
  AE: '784', GB: '826', US: '840', UY: '858', UZ: '860', VU: '548', VE: '862', VN: '704', EH: '732',
  YE: '887', ZM: '894', ZW: '716',
};

// Atlas geometries whose id is null, matched by name when the slice's code says so.
const ID_LESS_NAMES: Record<string, string> = { XK: 'Kosovo' };

// [longitude, latitude] for places the 110m atlas has no polygon for (microstates,
// islands, territories). They are drawn as circle markers instead.
export const MARKER_COORDS: Record<string, [number, number]> = {
  HK: [114.17, 22.32], SG: [103.82, 1.35], BM: [-64.75, 32.30], KY: [-81.25, 19.31],
  JE: [-2.13, 49.21], GG: [-2.58, 49.46], IM: [-4.55, 54.24], MO: [113.54, 22.20],
  BH: [50.56, 26.07], MT: [14.45, 35.90], MU: [57.55, -20.35], MC: [7.42, 43.74],
  LI: [9.55, 47.16], VG: [-64.62, 18.42], MH: [171.18, 7.13], GI: [-5.35, 36.14],
  CW: [-68.99, 12.17], BB: [-59.54, 13.19],
  // Other places with no polygon, so they are not stranded in the unplaced list:
  AD: [1.60, 42.55], SM: [12.46, 43.94], VA: [12.45, 41.90], MV: [73.22, 3.20],
  SC: [55.49, -4.68], AG: [-61.80, 17.06], LC: [-60.98, 13.91], GD: [-61.68, 12.12],
  VC: [-61.20, 13.25], KN: [-62.78, 17.36], DM: [-61.37, 15.41], AW: [-69.97, 12.52],
  FO: [-6.8, 62.0], CV: [-24.0, 16.0], KM: [43.33, -11.65], WS: [-172.10, -13.76],
  TO: [-175.20, -21.18], KI: [173.03, 1.45], CK: [-159.78, -21.24], GU: [144.79, 13.44],
  MP: [145.75, 15.18], AS: [-170.13, -14.27], PF: [-149.41, -17.68], RE: [55.53, -21.12],
  MQ: [-61.02, 14.64], GP: [-61.55, 16.27], GF: [-53.13, 3.93], YT: [45.17, -12.83],
  AI: [-63.07, 18.22], MS: [-62.19, 16.74], TC: [-71.80, 21.69], VI: [-64.90, 18.34],
  SX: [-63.07, 18.04], BQ: [-68.25, 12.18], BL: [-62.83, 17.90], MF: [-63.05, 18.08],
  PM: [-56.33, 46.83], SH: [-5.72, -15.95], FM: [158.16, 6.92], PW: [134.58, 7.50],
  NR: [166.93, -0.52], TV: [177.65, -7.11], NU: [-169.87, -19.05], TK: [-171.82, -9.17],
  WF: [-177.15, -13.77], NF: [167.95, -29.04], CX: [105.63, -10.49], CC: [96.87, -12.16],
  ST: [6.61, 0.19], AX: [19.92, 60.18], SJ: [16.0, 78.0], IO: [72.42, -7.33],
  PN: [-128.32, -24.38], GS: [-36.59, -54.43], BV: [3.36, -54.42], HM: [73.5, -53.08],
  UM: [166.63, 19.3],
};

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

// Name-based fallback for slices that carry no alpha-2 code. Resolves our label
// to a name that exists in the atlas, or null when the country has no polygon
// at 110m resolution (Hong Kong, Singapore, ...) or is not a country at all.
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

// --- Matching slices to the map ---

export interface MapSlice { name: string; pct: number; code?: string }
export interface AtlasGeo { id?: string | null; name: string }

// Stable key for a geometry: its numeric id, or "name:<name>" for the few
// geometries whose id is null.
export const geoKey = (g: AtlasGeo): string => (g.id != null && g.id !== '' ? String(g.id) : `name:${g.name}`);

export interface Placement<S extends MapSlice> {
  polygons: Map<string, S>;                                  // geoKey -> slice
  markers: { slice: S; coordinates: [number, number] }[];    // no polygon; drawn as circles
  unplaced: S[];                                             // nothing to draw
}

// Decide how every slice with exposure is drawn. Slices with a code match the
// atlas by ISO numeric id (robust to the atlas renaming "Czech Rep." etc.);
// the display-name aliases are only a fallback for slices without a code.
export function placeSlices<S extends MapSlice>(slices: S[], atlas: AtlasGeo[]): Placement<S> {
  const ids = new Set(atlas.filter(g => g.id != null && g.id !== '').map(g => String(g.id)));
  const out: Placement<S> = { polygons: new Map(), markers: [], unplaced: [] };
  const byName = (name: string) => atlas.find(g => g.name === name);

  for (const s of slices) {
    if (!isGeographic(s.name) || !(s.pct > 0)) continue;
    const code = s.code?.toUpperCase();
    if (code) {
      const numeric = ALPHA2_TO_NUMERIC[code];
      const idLess = ID_LESS_NAMES[code] ? byName(ID_LESS_NAMES[code]) : undefined;
      if (numeric && ids.has(numeric)) out.polygons.set(numeric, s);
      else if (idLess) out.polygons.set(geoKey(idLess), s);
      else if (MARKER_COORDS[code]) out.markers.push({ slice: s, coordinates: MARKER_COORDS[code] });
      else out.unplaced.push(s);
      continue;
    }
    const name = resolveAtlasName(s.name, atlas.map(g => g.name));
    const geo = name ? byName(name) : undefined;
    if (geo) out.polygons.set(geoKey(geo), s);
    else out.unplaced.push(s);
  }
  return out;
}
