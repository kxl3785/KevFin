// Sector and country for individual stocks from SEC EDGAR company records — the
// fallback for when Yahoo has no assetProfile for a ticker. Every SEC registrant
// (US-listed companies, plus foreign issuers filing 20-F/40-F) has a public
// "submissions" record carrying its SIC industry code, state of incorporation
// and business address.
//
// Pipeline (2 requests per ticker, then cached in SQLite):
//   1. ticker → CIK        via sec.gov/files/company_tickers.json (weekly, in memory)
//   2. CIK → company record via data.sec.gov/submissions/CIK##########.json
//
// Privacy: only the ticker symbol leaves the machine (and only as the choice of
// which public file to read), sent with the user's own declared SEC contact
// identity — the same requests the fund-holdings lookups in edgarHoldings.ts
// make, through the same throttle. No identity configured means no request.
//
// Caching: each ticker's answer is kept in provider_cache (`sec_company:TICKER`)
// for 30 days; "not an SEC registrant" is kept for 7 days; a failed lookup
// (network, 403/429, mapping unavailable) isn't kept at all, so the next call
// retries — meanwhile an expired answer is still served. The raw SEC fields are
// what's stored; sector and country are derived on read, so improving the maps
// below takes effect without invalidating the cache.

import { readProviderCache, writeProviderCache } from '../db/providerCache.js';
import { cachedMapping, edgarUserAgent, EdgarError, fetchJson } from './edgarHoldings.js';
import { countryCode, countryNameForCode } from './country.js';

export interface SecCompanyProfile {
  cik: number;
  name: string;
  sic: number | null;
  sicDescription: string | null;
  sector: string | null;
  country: string | null;
}

export const CACHE_PREFIX = 'sec_company:';
export const PROFILE_TTL_MS = 30 * 24 * 3600 * 1000;      // companies rarely change SIC or HQ
export const NOT_REGISTRANT_TTL_MS = 7 * 24 * 3600 * 1000; // newly listed tickers appear within days

// What's stored per ticker: SEC's raw fields (company === null: not a registrant).
interface StoredCompany {
  cik: number;
  name: string;
  sic: number | null;
  sicDescription: string | null;
  business: string | null;            // addresses.business.stateOrCountry (EDGAR code)
  businessDescription: string | null; // …stateOrCountryDescription
  incorporation: string | null;       // stateOfIncorporation (EDGAR code)
  incorporationDescription: string | null;
}
interface CachedCompany { company: StoredCompany | null }

// --- SIC → sector -----------------------------------------------------------
//
// SIC (1937, last revised 1987) predates GICS and Yahoo's sector taxonomy, so
// this is coarse: it classifies by what a company *makes* in its main
// establishment, not how markets group it (Amazon is "catalog & mail-order
// retail", Alphabet "computer programming services"). Good enough to place a
// stock Yahoo can't classify in roughly the right bucket; it never overrides
// Yahoo. Labels are Yahoo's eleven sectors, which the rest of the app uses.
//
// Rules are checked in order and the first match wins, so specific codes and
// narrow ranges sit above the broad division they carve out of.

const TECH = 'Technology', FIN = 'Financial Services', HEALTH = 'Healthcare';
const CYCL = 'Consumer Cyclical', COMM = 'Communication Services', IND = 'Industrials';
const DEF = 'Consumer Defensive', ENERGY = 'Energy', UTIL = 'Utilities';
const MAT = 'Basic Materials', RE = 'Real Estate';

const SIC_RULES: [lo: number, hi: number, sector: string | null][] = [
  // Agriculture, forestry, fishing
  [800, 899, MAT],      // forestry
  [100, 999, DEF],      // crops, livestock, agricultural services, fishing

  // Mining: coal and oil & gas are Energy, the rest is materials
  [1200, 1399, ENERGY], // coal; crude petroleum & natural gas (1311); drilling & field services (1381-1389)
  [1000, 1499, MAT],    // metal ores, gold & silver, nonmetallic minerals

  // Construction
  [1520, 1531, CYCL],   // residential builders / operative builders (homebuilders → Residential Construction)
  [1500, 1799, IND],

  // Manufacturing
  [2000, 2199, DEF],    // food, beverages (2080s), tobacco (2100-2111)
  [2200, 2399, CYCL],   // textiles, apparel
  [2451, 2452, CYCL],   // mobile & prefabricated homes
  [2400, 2499, MAT],    // lumber & wood
  [2500, 2599, CYCL],   // furniture & fixtures
  [2600, 2699, MAT],    // paper & paperboard
  [2700, 2749, COMM],   // newspapers (2711), periodicals, books, misc publishing
  [2750, 2799, IND],    // commercial printing, business forms, bookbinding
  [2830, 2836, HEALTH], // medicinal chemicals, pharma (2834), diagnostics (2835), biologicals (2836)
  [2840, 2844, DEF],    // soaps, detergents, perfumes & cosmetics
  [2800, 2899, MAT],    // chemicals, plastics materials (2800-2829), paints, ag chemicals
  [2900, 2999, ENERGY], // petroleum refining (2911), misc petroleum & coal products (2990)
  [3011, 3011, CYCL],   // tires
  [3021, 3021, CYCL],   // rubber & plastics footwear
  [3000, 3099, MAT],    // rubber & plastics products
  [3100, 3199, CYCL],   // leather goods, footwear
  [3200, 3399, MAT],    // stone, clay, glass, concrete (3200s); primary metals (3300s)
  [3400, 3499, IND],    // fabricated metal products, ordnance
  [3570, 3579, TECH],   // computers (3571), storage (3572), terminals, networking (3576), peripherals (3577)
  [3500, 3599, IND],    // industrial & commercial machinery
  [3630, 3639, CYCL],   // household appliances
  [3650, 3679, TECH],   // consumer electronics, communications equipment (3661/3663/3669), semis & components (3672-3679)
  [3695, 3695, TECH],   // magnetic & optical recording media
  [3600, 3699, IND],    // electrical equipment: transformers, motors, lighting, batteries
  [3711, 3711, CYCL],   // motor vehicles & car bodies
  [3714, 3714, CYCL],   // motor vehicle parts
  [3716, 3716, CYCL],   // motor homes
  [3732, 3732, CYCL],   // boat building
  [3751, 3751, CYCL],   // motorcycles, bicycles
  [3792, 3792, CYCL],   // travel trailers & campers
  [3700, 3799, IND],    // aircraft & parts, ships, railroad equipment, missiles, truck bodies
  [3812, 3812, IND],    // search, detection & navigation systems (defense electronics)
  [3826, 3826, HEALTH], // laboratory analytical instruments (life-science tools)
  [3840, 3851, HEALTH], // surgical & medical instruments (3841/3842), dental, X-ray, electromedical (3845), ophthalmic
  [3873, 3873, CYCL],   // watches & clocks
  [3800, 3899, TECH],   // measuring, testing & optical instruments, photographic equipment
  [3900, 3999, CYCL],   // jewelry, toys, sporting goods, misc consumer manufacturing

  // Transportation, communications, utilities
  [4610, 4619, ENERGY], // pipelines (not natural gas)
  [4700, 4700, CYCL],   // transportation services (online travel agencies file here)
  [4724, 4724, CYCL],   // travel agencies
  [4000, 4799, IND],    // railroads, trucking, water & air transport, freight forwarding
  [4800, 4899, COMM],   // telephone (4813), wireless (4812), broadcasting, cable (4841), comms services (4899)
  [4922, 4922, ENERGY], // natural gas transmission (midstream pipelines)
  [4950, 4959, IND],    // sanitary services, refuse & hazardous-waste systems
  [4900, 4991, UTIL],   // electric, gas, water, steam, cogeneration

  // Wholesale trade (5000-5199): mostly distributors, which Yahoo files by
  // what they distribute.
  [5045, 5045, TECH],   // computers & peripherals
  [5065, 5065, TECH],   // electronic parts
  [5047, 5047, HEALTH], // medical, dental & hospital equipment
  [5122, 5122, HEALTH], // drugs & druggists' sundries
  [5140, 5149, DEF],    // groceries & related products
  [5180, 5182, DEF],    // beer, wine & distilled beverages
  [5171, 5172, ENERGY], // petroleum products
  [5000, 5199, IND],    // industrial distribution

  // Retail trade
  [5331, 5331, DEF],    // variety stores (big-box discount / warehouse clubs)
  [5399, 5399, DEF],    // misc general merchandise stores
  [5400, 5499, DEF],    // grocery & food stores
  [5912, 5912, HEALTH], // drug stores & proprietary stores
  [5200, 5999, CYCL],   // everything else: building supply, apparel, auto dealers, restaurants (5812), catalog/online (5961)

  // Finance, insurance, real estate
  [6770, 6770, null],   // blank checks (SPACs): no operating business yet
  [6792, 6792, ENERGY], // oil royalty traders
  [6795, 6795, MAT],    // mineral royalty traders
  [6798, 6798, RE],     // real estate investment trusts
  [6500, 6599, RE],     // real estate operators, lessors, agents, developers (6500-6553)
  [6000, 6799, FIN],    // banks, credit, brokers (6211), insurance (6311-6411), holding & investment offices

  // Services
  [7000, 7099, CYCL],   // hotels, rooming houses, camps
  [7200, 7299, CYCL],   // personal services
  [7310, 7319, COMM],   // advertising
  [7370, 7379, TECH],   // computer programming, prepackaged software (7372), data processing, integrated systems
  [7300, 7399, IND],    // business services: credit reporting, equipment rental, staffing, misc (7380s)
  [7510, 7519, IND],    // truck & car rental and leasing
  [7500, 7599, CYCL],   // auto repair & services
  [7600, 7699, IND],    // misc repair services
  [7800, 7899, COMM],   // motion pictures: production (7812), services (7819), distribution, theaters, video rental
  [7900, 7999, CYCL],   // amusement & recreation (casinos, clubs, parks)
  [8000, 8099, HEALTH], // offices of doctors, hospitals, nursing, labs, home health
  [8100, 8199, IND],    // legal services
  [8200, 8299, DEF],    // educational services
  [8731, 8731, HEALTH], // commercial physical & biological research (CROs)
  [8700, 8799, IND],    // engineering, accounting, research, management & consulting services
];

/** Yahoo-style sector for a 4-digit SIC code, or null when it has no sensible one. */
export function sicToSector(sic: number | null): string | null {
  if (sic == null || !Number.isInteger(sic) || sic <= 0) return null;
  for (const [lo, hi, sector] of SIC_RULES) {
    if (sic >= lo && sic <= hi) return sector;
  }
  return null;
}

// --- EDGAR location code → country -----------------------------------------
//
// EDGAR's own state/country codes (not ISO): US states use their postal codes,
// everything else gets an arbitrary 2-character code ("X0" = United Kingdom,
// "A6" = Ontario). Source: https://www.sec.gov/submit-filings/filer-support-resources/edgar-state-country-codes
// Each is mapped to its ISO 3166-1 alpha-2 code so the label comes from
// country.ts and matches the rest of the app ("United Kingdom", "South Korea").
// Puerto Rico, Guam and the US Virgin Islands keep their own names, as Yahoo
// reports them. Not mapped (→ null): "XX" (unknown) and "P8" (Netherlands
// Antilles, dissolved in 2010 with no single successor code).

const US_CODES = (
  'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY ' +
  'NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY X1'
).split(' ');

// Canada: provinces A0-A9, Yukon B0, and Z4 (federal level).
const CANADA_CODES = 'A0 A1 A2 A3 A4 A5 A6 A7 A8 A9 B0 Z4'.split(' ');

const EDGAR_TO_ISO: Record<string, string> = {
  B2: 'AF', Y6: 'AX', B3: 'AL', B4: 'DZ', B5: 'AS', B6: 'AD', B7: 'AO', '1A': 'AI', B8: 'AQ', B9: 'AG',
  C1: 'AR', '1B': 'AM', '1C': 'AW', C3: 'AU', C4: 'AT', '1D': 'AZ', C5: 'BS', C6: 'BH', C7: 'BD', C8: 'BB',
  '1F': 'BY', C9: 'BE', D1: 'BZ', G6: 'BJ', D0: 'BM', D2: 'BT', D3: 'BO', '1E': 'BA', B1: 'BW', D4: 'BV',
  D5: 'BR', D6: 'IO', D9: 'BN', E0: 'BG', X2: 'BF', E2: 'BI', E3: 'KH', E4: 'CM', E8: 'CV', E9: 'KY',
  F0: 'CF', F2: 'TD', F3: 'CL', F4: 'CN', F6: 'CX', F7: 'CC', F8: 'CO', F9: 'KM', G0: 'CG', Y3: 'CD',
  G1: 'CK', G2: 'CR', L7: 'CI', '1M': 'HR', G3: 'CU', G4: 'CY', '2N': 'CZ', G7: 'DK', '1G': 'DJ', G9: 'DM',
  G8: 'DO', H1: 'EC', H2: 'EG', H3: 'SV', H4: 'GQ', '1J': 'ER', '1H': 'EE', H5: 'ET', H7: 'FK', H6: 'FO',
  H8: 'FJ', H9: 'FI', I0: 'FR', I3: 'GF', I4: 'PF', '2C': 'TF', I5: 'GA', I6: 'GM', '2Q': 'GE', '2M': 'DE',
  J0: 'GH', J1: 'GI', J3: 'GR', J4: 'GL', J5: 'GD', J6: 'GP', GU: 'GU', J8: 'GT', Y7: 'GG', J9: 'GN',
  S0: 'GW', K0: 'GY', K1: 'HT', K4: 'HM', X4: 'VA', K2: 'HN', K3: 'HK', K5: 'HU', K6: 'IS', K7: 'IN',
  K8: 'ID', K9: 'IR', L0: 'IQ', L2: 'IE', Y8: 'IM', L3: 'IL', L6: 'IT', L8: 'JM', M0: 'JP', Y9: 'JE',
  M2: 'JO', '1P': 'KZ', M3: 'KE', J2: 'KI', M4: 'KP', M5: 'KR', M6: 'KW', '1N': 'KG', M7: 'LA', '1R': 'LV',
  M8: 'LB', M9: 'LS', N0: 'LR', N1: 'LY', N2: 'LI', '1Q': 'LT', N4: 'LU', N5: 'MO', '1U': 'MK', N6: 'MG',
  N7: 'MW', N8: 'MY', N9: 'MV', O0: 'ML', O1: 'MT', '1T': 'MH', O2: 'MQ', O3: 'MR', O4: 'MU', '2P': 'YT',
  O5: 'MX', '1K': 'FM', '1S': 'MD', O9: 'MC', P0: 'MN', Z5: 'ME', P1: 'MS', P2: 'MA', P3: 'MZ', E1: 'MM',
  T6: 'NA', P5: 'NR', P6: 'NP', P7: 'NL', '1W': 'NC', Q2: 'NZ', Q3: 'NI', Q4: 'NE', Q5: 'NG', Q6: 'NU',
  Q7: 'NF', '1V': 'MP', Q8: 'NO', P4: 'OM', R0: 'PK', '1Y': 'PW', '1X': 'PS', R1: 'PA', R2: 'PG', R4: 'PY',
  R5: 'PE', R6: 'PH', R8: 'PN', R9: 'PL', S1: 'PT', PR: 'PR', S3: 'QA', S4: 'RE', S5: 'RO', '1Z': 'RU',
  S6: 'RW', Z0: 'BL', U8: 'SH', U7: 'KN', U9: 'LC', Z1: 'MF', V0: 'PM', V1: 'VC', Y0: 'WS', S8: 'SM',
  S9: 'ST', T0: 'SA', T1: 'SN', Z2: 'RS', T2: 'SC', T8: 'SL', U0: 'SG', '2B': 'SK', '2A': 'SI', D7: 'SB',
  U1: 'SO', T3: 'ZA', '1L': 'GS', U3: 'ES', F1: 'LK', V2: 'SD', V3: 'SR', L9: 'SJ', V6: 'SZ', V7: 'SE',
  V8: 'CH', V9: 'SY', F5: 'TW', '2D': 'TJ', W0: 'TZ', W1: 'TH', Z3: 'TL', W2: 'TG', W3: 'TK', W4: 'TO',
  W5: 'TT', W6: 'TN', W8: 'TR', '2E': 'TM', W7: 'TC', '2G': 'TV', W9: 'UG', '2H': 'UA', C0: 'AE', X0: 'GB',
  '2J': 'UM', X3: 'UY', '2K': 'UZ', '2L': 'VU', X5: 'VE', Q1: 'VN', D8: 'VG', VI: 'VI', X8: 'WF', U5: 'EH',
  T7: 'YE', Y4: 'ZM', Y5: 'ZW',
};
for (const c of US_CODES) EDGAR_TO_ISO[c] = 'US';
for (const c of CANADA_CODES) EDGAR_TO_ISO[c] = 'CA';

/** Country label (as country.ts names it) for an EDGAR state/country code, else null. */
export function edgarLocationToCountry(code: string | null | undefined): string | null {
  if (!code) return null;
  const iso = EDGAR_TO_ISO[code.trim().toUpperCase()];
  return iso ? countryNameForCode(iso) : null;
}

// Resolve one location: the code first, then (for a code we don't know) the
// description EDGAR spells out when it's a plain country name.
function locationCountry(code: string | null, description: string | null): string | null {
  return edgarLocationToCountry(code) ?? countryNameForCode(countryCode(description));
}

// Business address first: a Delaware, Cayman or Bermuda incorporation says
// little about where the company actually operates. Incorporation is used only
// when there's no business address (or it's "XX", unknown).
function countryFor(c: StoredCompany): string | null {
  const hasBusiness = !!c.business && c.business !== 'XX';
  return hasBusiness
    ? locationCountry(c.business, c.businessDescription)
    : locationCountry(c.incorporation, c.incorporationDescription);
}

function toProfile(c: StoredCompany): SecCompanyProfile {
  return {
    cik: c.cik, name: c.name, sic: c.sic, sicDescription: c.sicDescription,
    sector: sicToSector(c.sic), country: countryFor(c),
  };
}

// --- Lookup -------------------------------------------------------------------

// Share classes: company_tickers.json writes "BRK-B"; brokers write BRK.B or BRK/B.
function normalizeTicker(ticker: string): string {
  return ticker.trim().toUpperCase().replace(/[./\s]+/g, '-');
}

// company_tickers.json: { "0": { cik_str, ticker, title }, … } → ticker → CIK.
// Roughly ordered by size, so the first entry for a ticker wins.
function parseTickerCiks(raw: unknown): Map<string, number> {
  const out = new Map<string, number>();
  for (const v of Object.values((raw as Record<string, unknown>) ?? {})) {
    const { cik_str, ticker } = (v ?? {}) as { cik_str?: unknown; ticker?: unknown };
    const cik = Number(cik_str);
    if (typeof ticker !== 'string' || !ticker || !(cik > 0)) continue;
    const key = normalizeTicker(ticker);
    if (!out.has(key)) out.set(key, cik);
  }
  return out;
}

const cikMapping = cachedMapping('https://www.sec.gov/files/company_tickers.json', parseTickerCiks);

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

// One SEC round-trip. null = definitively not a registrant (cacheable);
// throws on anything transient so nothing false gets cached.
async function lookup(ticker: string): Promise<StoredCompany | null> {
  const map = await cikMapping.get();
  if (map.size === 0) throw new Error(`SEC ticker mapping unavailable${cikMapping.failureSuffix()}`);
  const cik = map.get(ticker);
  if (!cik) return null;

  let sub: Record<string, unknown>;
  try {
    sub = (await fetchJson(`https://data.sec.gov/submissions/CIK${String(cik).padStart(10, '0')}.json`)) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof EdgarError && err.status === 404) return null; // listed CIK without a submissions record
    throw err;
  }
  const business = ((sub?.addresses as Record<string, unknown> | undefined)?.business ?? {}) as Record<string, unknown>;
  const sic = parseInt(String(sub?.sic ?? ''), 10);
  return {
    cik,
    name: str(sub?.name) ?? ticker,
    sic: Number.isInteger(sic) && sic > 0 ? sic : null,
    sicDescription: str(sub?.sicDescription),
    business: str(business.stateOrCountry)?.toUpperCase() ?? null,
    businessDescription: str(business.stateOrCountryDescription),
    incorporation: str(sub?.stateOfIncorporation)?.toUpperCase() ?? null,
    incorporationDescription: str(sub?.stateOfIncorporationDescription),
  };
}

const inflight = new Map<string, Promise<SecCompanyProfile | null>>();

async function resolve(ticker: string): Promise<SecCompanyProfile | null> {
  const cacheKey = CACHE_PREFIX + ticker;
  const now = Date.now();

  // An expired answer, kept to fall back on if the refresh fails.
  let stale: StoredCompany | null = null;
  try {
    const hit = readProviderCache<CachedCompany>(cacheKey);
    if (hit) {
      const company = hit.payload?.company ?? null;
      const ttl = company ? PROFILE_TTL_MS : NOT_REGISTRANT_TTL_MS;
      if (now - hit.fetchedAt < ttl) return company ? toProfile(company) : null;
      stale = company;
    }
  } catch { /* unreadable cache row: fall through to a fresh lookup */ }

  let company: StoredCompany | null;
  try {
    company = await lookup(ticker);
  } catch (err) {
    console.error(`SEC company lookup failed for ${ticker}:`, err);
    return stale ? toProfile(stale) : null; // not cached: the next call retries
  }
  try { writeProviderCache<CachedCompany>(cacheKey, { fetchedAt: now, payload: { company } }); } catch { /* best-effort */ }
  return company ? toProfile(company) : null;
}

/**
 * SEC's company profile for a stock ticker: name, SIC industry, and the sector
 * and country derived from them. null when no SEC contact email is set, the
 * ticker isn't an SEC registrant, or the lookup failed (failure is not cached).
 * Never throws. Concurrent calls for the same ticker share one lookup.
 */
export async function fetchSecCompanyProfile(ticker: string): Promise<SecCompanyProfile | null> {
  if (!edgarUserAgent()) return null; // no identity: never contact SEC
  const key = normalizeTicker(ticker ?? '');
  if (!key) return null;
  const pending = inflight.get(key);
  if (pending) return pending;
  const p: Promise<SecCompanyProfile | null> = resolve(key).finally(() => {
    if (inflight.get(key) === p) inflight.delete(key); // unless a reset replaced it
  });
  inflight.set(key, p);
  return p;
}

// Test hook: forget the in-memory ticker mapping and in-flight lookups.
export function resetSecCompanyState(): void {
  cikMapping.reset();
  inflight.clear();
}
