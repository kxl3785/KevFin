// Map a security's ISIN prefix (first 2 chars = country of registration) to a
// country name. Used to estimate geographic exposure from fund holdings.
const ISIN_COUNTRY: Record<string, string> = {
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
};

export function isinToCountry(isin?: string): string | null {
  if (!isin || isin.length < 2) return null;
  const code = isin.slice(0, 2).toUpperCase();
  return ISIN_COUNTRY[code] ?? code;
}
