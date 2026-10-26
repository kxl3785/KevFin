// ISO 3166-1 alpha-2 <-> country name, used to estimate geographic exposure
// from fund holdings. The 2-letter code can come from an ISIN prefix (country of
// *registration*) or from N-PORT's <invCountry> (the issuer's country of risk,
// which edgarHoldings prefers).

// Bucket for anything that has a code-shaped prefix but is not a country: "XS"
// (Eurobond / international ISINs), "EU", "XC", "QZ" ... The allocation view
// treats it as a pseudo-country that is listed but not drawn.
export const INTERNATIONAL_OTHER = 'International / Other';

// Every officially assigned ISO 3166-1 alpha-2 code, plus XK (Kosovo, the
// de-facto code used by the EU/ECB and present in the world atlas). Anything
// outside this set is NOT a country, even if Intl.DisplayNames can name it
// ("EU" -> "European Union", "UN" -> "United Nations").
const ISO_ALPHA2 = new Set((
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ ' +
  'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR ' +
  'GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT ' +
  'JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ ' +
  'NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW ' +
  'SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ ' +
  'UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW XK'
).split(' '));

// Curated labels: these keep the names the app has always shown, and replace
// the awkward CLDR spellings of a few common ones. Everything else falls back
// to Intl.DisplayNames below.
const CURATED: Record<string, string> = {
  US: 'United States', CA: 'Canada', GB: 'United Kingdom', JP: 'Japan', CN: 'China',
  HK: 'Hong Kong', TW: 'Taiwan', KR: 'South Korea', IN: 'India', FR: 'France',
  DE: 'Germany', CH: 'Switzerland', NL: 'Netherlands', AU: 'Australia', BR: 'Brazil',
  ZA: 'South Africa', SE: 'Sweden', ES: 'Spain', IT: 'Italy', DK: 'Denmark',
  SG: 'Singapore', FI: 'Finland', BE: 'Belgium', NO: 'Norway', MX: 'Mexico',
  ID: 'Indonesia', TH: 'Thailand', MY: 'Malaysia', IE: 'Ireland', IL: 'Israel',
  SA: 'Saudi Arabia', AE: 'United Arab Emirates', NZ: 'New Zealand', PL: 'Poland',
  TR: 'Turkey', PT: 'Portugal', AT: 'Austria', GR: 'Greece', PH: 'Philippines',
  CL: 'Chile', LU: 'Luxembourg', BM: 'Bermuda', KY: 'Cayman Islands', QA: 'Qatar',
  KW: 'Kuwait', CO: 'Colombia', PE: 'Peru', HU: 'Hungary', CZ: 'Czechia',
  VN: 'Vietnam', EG: 'Egypt', JE: 'Jersey', GG: 'Guernsey', CR: 'Costa Rica',
  // Not in the original table, but common enough to pin down:
  RU: 'Russia', MO: 'Macao', PS: 'Palestine', MM: 'Myanmar', CD: 'DR Congo', CG: 'Congo',
  CI: "Côte d'Ivoire", MK: 'North Macedonia', FK: 'Falkland Islands', XK: 'Kosovo',
  CV: 'Cape Verde', SZ: 'Eswatini', TL: 'Timor-Leste', CW: 'Curaçao', VG: 'British Virgin Islands',
  AR: 'Argentina', PK: 'Pakistan', IM: 'Isle of Man', GI: 'Gibraltar', MH: 'Marshall Islands',
  MU: 'Mauritius', MC: 'Monaco', LI: 'Liechtenstein', MT: 'Malta', BH: 'Bahrain', BB: 'Barbados',
};

let displayNames: Intl.DisplayNames | null | undefined;
function intlName(code: string): string | undefined {
  if (displayNames === undefined) {
    try { displayNames = new Intl.DisplayNames('en', { type: 'region', fallback: 'none' }); }
    catch { displayNames = null; } // runtime without Intl.DisplayNames / ICU data
  }
  return displayNames?.of(code) ?? undefined;
}

// CLDR decorates a few regions ("Hong Kong SAR China", "Türkiye", curly
// apostrophes); flatten them to plain labels.
function normalizeIntlName(name: string): string {
  return name
    .replace(/\s+SAR China$/, '')
    .replace(/’/g, "'")
    .replace(/^Türkiye$/, 'Turkey')
    .replace(/^Myanmar \(Burma\)$/, 'Myanmar')
    .replace(/^Congo - Kinshasa$/, 'DR Congo')
    .replace(/^Congo - Brazzaville$/, 'Congo')
    .replace(/^Palestinian Territories$/, 'Palestine')
    .trim();
}

const nameCache = new Map<string, string | null>();

/** Display name for a real ISO 3166-1 alpha-2 code (any case), else null. */
export function countryNameForCode(code?: string | null): string | null {
  if (!code) return null;
  const c = code.trim().toUpperCase();
  if (!ISO_ALPHA2.has(c)) return null;
  let name = nameCache.get(c);
  if (name === undefined) {
    const raw = CURATED[c] ?? intlName(c);
    name = raw ? normalizeIntlName(raw) : null;
    nameCache.set(c, name);
  }
  return name;
}

// Extra spellings seen from other sources (Yahoo's `country`, older labels).
const NAME_ALIASES: Record<string, string> = {
  'usa': 'US', 'united states of america': 'US', 'uk': 'GB', 'great britain': 'GB',
  'türkiye': 'TR', 'turkiye': 'TR', 'korea': 'KR', 'republic of korea': 'KR', 'korea, republic of': 'KR',
  'russian federation': 'RU', 'czech republic': 'CZ', 'viet nam': 'VN', 'hong kong sar china': 'HK',
  'macau': 'MO', 'macao sar china': 'MO', 'ivory coast': 'CI', 'burma': 'MM', 'holland': 'NL',
  'democratic republic of the congo': 'CD', 'congo - kinshasa': 'CD', 'swaziland': 'SZ', 'macedonia': 'MK',
};

let codeByName: Map<string, string> | undefined;

/** The alpha-2 code for one of our country labels (case-insensitive), else null. */
export function countryCode(label?: string | null): string | null {
  if (!label) return null;
  if (!codeByName) {
    codeByName = new Map();
    for (const c of ISO_ALPHA2) {
      const n = countryNameForCode(c);
      if (n) codeByName.set(n.toLowerCase(), c);
    }
  }
  const key = label.trim().toLowerCase();
  return codeByName.get(key) ?? NAME_ALIASES[key] ?? null;
}

/**
 * Map an ISIN's 2-letter prefix to a country name. Returns null for missing or
 * too-short input. A prefix that is not a country (XS, EU, XC, QZ, ...) maps to
 * 'International / Other' rather than leaking a raw code into the breakdown.
 */
export function isinToCountry(isin?: string): string | null {
  if (!isin || isin.length < 2) return null;
  return countryNameForCode(isin.slice(0, 2)) ?? INTERNATIONAL_OTHER;
}

/**
 * Re-label a country value that was stored by an older version, which fell back
 * to the raw 2-letter code: "AR" -> "Argentina", "XS" -> "International / Other".
 * Anything that is not a bare 2-letter code is returned unchanged.
 */
export function relabelCountry(label: string): string {
  if (/^[A-Za-z]{2}$/.test(label)) return countryNameForCode(label) ?? INTERNATIONAL_OTHER;
  return label;
}

/** Our canonical label for a country given any known spelling; unknown labels pass through. */
export function canonicalCountryName(label: string): string {
  const code = countryCode(label);
  return (code && countryNameForCode(code)) || label;
}
