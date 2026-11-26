// Look through a listed company that is itself mostly a portfolio of other
// listed stocks — Berkshire Hathaway — the way a fund is looked through. Which
// companies, and how they are recognised, is the LISTED_HOLDINGS table in
// util/assumptions.ts.
//
// Only part of such a company can be opened, and the result says so:
//   - its listed-stock portfolio comes from its latest Form 13F-HR on EDGAR
//     (the information table, summed per CUSIP across the managers it is split
//     between; options — rows with a put/call — left out);
//   - each position's value over the company's market capitalisation (Yahoo)
//     is the share of one dollar of the company that sits in that stock;
//   - the rest — wholly owned businesses, cash, Treasury bills, bonds, and
//     listed stocks a 13F doesn't cover (Berkshire's Japanese trading houses)
//     — stays as the company, under its `remainderName`.
// If the filing or the market cap is missing, stale or implausible (the listed
// part outside 5–90% of the company), nothing is opened and the company shows
// as it always has.
//
// Requests: the company's EDGAR submissions list, the filing's index and its
// information table (SEC, with the contact identity edgarHoldings.ts manages),
// cached in provider_cache for 30 days like an N-PORT filing; and the market
// cap of each share class (Yahoo, the same session as yahooMeta.ts), kept a
// day. Only the company's public identifiers are sent.

import { LISTED_HOLDINGS, type ListedHoldingsCompany } from '../util/assumptions.js';
import { edgarUserAgent, fetchJson, fetchText, issuerTickerMap, normalizeIssuerName } from './edgarHoldings.js';
import type { Constituent } from './fundHoldings.js';
import { knownTicker, queueTickerLookups } from './figi.js';
import { fetchSecurityMeta, getSession, UA } from './yahooMeta.js';
import { readLookup, writeLookup } from './lookupCache.js';
import { noteLookupFailure } from './lookupHealth.js';

const DAY_MS = 86400e3;
const FILING_TTL_MS = 30 * DAY_MS;   // 13Fs are quarterly; re-check monthly
const NO_FILING_TTL_MS = 7 * DAY_MS;
const MARKET_CAP_TTL_MS = DAY_MS;
// Plausibility guards. A 13F is filed up to 45 days after its quarter, so the
// newest one is at most ~4.5 months old; one older than this means filings
// stopped (or we failed to see a newer one) and the numbers are not current.
export const MAX_FILING_AGE_DAYS = 200;
export const MIN_LISTED_SHARE = 0.05;
export const MAX_LISTED_SHARE = 0.9;
const CLASS_CAP_TOLERANCE = 0.1; // share classes' market caps must agree to 10%

// --- Recognising the company -------------------------------------------------

// "BRK.B", "BRK/B", "BRK B" → "BRK-B": how Yahoo and the rest of the app spell
// share classes.
export function dashClass(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/^([A-Z]+)[ ./]([A-Z])$/, '$1-$2');
}

/**
 * The LISTED_HOLDINGS key a holding or fund constituent refers to, or null.
 * Matches any spelling of a share class, the issuer's CUSIP / US ISIN, or —
 * for a filing that gave only a name — the normalized company name.
 */
export function listedCompanyKey(c: { symbol?: string; name?: string; cusip?: string; isin?: string; kind?: string }): string | null {
  if (c.kind) return null;
  const sym = c.symbol ? dashClass(c.symbol) : '';
  const cusip = (c.cusip ?? '').toUpperCase();
  const isin = (c.isin ?? '').toUpperCase();
  for (const [key, co] of Object.entries(LISTED_HOLDINGS)) {
    if (sym && co.symbols.includes(sym)) return key;
    if (cusip.startsWith(co.cusip6) || isin.startsWith(`US${co.cusip6}`)) return key;
    // Name keys only for rows whose symbol IS a name (no ticker was found), so
    // a ticker'd stock that merely shares words with the company never matches.
    const nameKey = normalizeIssuerName(c.name ?? '');
    if ((!c.symbol || c.symbol === nameKey) && co.names.includes(nameKey)) return key;
  }
  return null;
}

// --- The 13F filing ----------------------------------------------------------

// ticker: from the SEC company-ticker file when the filing was fetched, kept
// with it so the positions are named even when that file can't be fetched.
export interface ThirteenFRow { cusip: string; name: string; title: string; value: number; ticker?: string }
export interface ThirteenF { accession: string; period: string; filed: string; rows: ThirteenFRow[] }

function decodeXml(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
function field(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<(?:\\w+:)?${name}>([\\s\\S]*?)</(?:\\w+:)?${name}>`));
  return m ? decodeXml(m[1].trim()) : null;
}

/**
 * A 13F information table, one row per CUSIP: the managers a filer splits its
 * positions between are added together, option rows (put/call) are left out,
 * and values are in dollars (13F values have been whole dollars since 2023).
 * Largest first.
 */
export function parse13fInfoTable(xml: string): ThirteenFRow[] {
  const by = new Map<string, ThirteenFRow>();
  for (const m of xml.matchAll(/<(?:\w+:)?infoTable>([\s\S]*?)<\/(?:\w+:)?infoTable>/g)) {
    const block = m[1];
    if (field(block, 'putCall')) continue;
    const cusip = (field(block, 'cusip') ?? '').toUpperCase();
    const value = Number(field(block, 'value'));
    if (!/^[0-9A-Z]{9}$/.test(cusip) || !Number.isFinite(value) || value <= 0) continue;
    const row = by.get(cusip) ?? { cusip, name: field(block, 'nameOfIssuer') ?? cusip, title: field(block, 'titleOfClass') ?? '', value: 0 };
    row.value += value;
    by.set(cusip, row);
  }
  return [...by.values()].sort((a, b) => b.value - a.value);
}

// The newest original 13F-HR (not an amendment) in an EDGAR submissions list.
export function latest13f(raw: unknown): { accession: string; period: string; filed: string } | null {
  const r = (raw as { filings?: { recent?: Record<string, unknown[]> } })?.filings?.recent;
  const forms = r?.form ?? [];
  for (let i = 0; i < forms.length; i++) {
    if (forms[i] !== '13F-HR') continue;
    const accession = String(r?.accessionNumber?.[i] ?? '');
    const period = String(r?.reportDate?.[i] ?? '');
    const filed = String(r?.filingDate?.[i] ?? '');
    if (/^\d{10}-\d{2}-\d{6}$/.test(accession) && /^\d{4}-\d{2}-\d{2}$/.test(period)) return { accession, period, filed };
  }
  return null;
}

async function download13f(cik: number): Promise<ThirteenF | null> {
  const latest = latest13f(await fetchJson(`https://data.sec.gov/submissions/CIK${String(cik).padStart(10, '0')}.json`));
  if (!latest) return null;
  const base = `https://www.sec.gov/Archives/edgar/data/${cik}/${latest.accession.replace(/-/g, '')}`;
  const index = (await fetchJson(`${base}/index.json`)) as { directory?: { item?: { name?: string; size?: string | number }[] } };
  // The information table is the filing's other XML document (any name).
  const table = (index.directory?.item ?? [])
    .filter(i => i.name?.toLowerCase().endsWith('.xml') && i.name !== 'primary_doc.xml')
    .sort((a, b) => (Number(b.size) || 0) - (Number(a.size) || 0))[0];
  if (!table?.name) return null;
  const rows = parse13fInfoTable(await fetchText(`${base}/${table.name}`));
  const names = await issuerTickerMap();
  for (const r of rows) {
    const t = names.get(normalizeIssuerName(r.name));
    if (t) r.ticker = t;
  }
  return rows.length ? { ...latest, rows } : null;
}

// The company's latest 13F: cached 30 days (a "none" 7); on a failed request
// whatever was cached before is served, and nothing new is recorded.
async function cached13f(cik: number): Promise<ThirteenF | null> {
  const key = `13f:${cik}`;
  const row = readLookup<{ filing: ThirteenF | null }>(key);
  const stored = row?.payload && 'filing' in row.payload ? row.payload.filing : undefined;
  if (row && stored !== undefined && Date.now() - row.fetchedAt < (stored ? FILING_TTL_MS : NO_FILING_TTL_MS)) return stored;
  if (!edgarUserAgent()) return stored ?? null; // never asked SEC without a contact
  try {
    const filing = await download13f(cik);
    writeLookup(key, Date.now(), { filing });
    return filing;
  } catch (err) {
    console.error(`13F fetch failed for CIK ${cik}:`, err);
    noteLookupFailure();
    return stored ?? null;
  }
}

// --- Market capitalisation ------------------------------------------------------

// The whole company's market cap as Yahoo's quote for one share class reports
// it (the same figure for BRK-A and BRK-B: Yahoo counts both classes).
async function marketCap(symbol: string): Promise<number | null> {
  const key = `mktcap:${symbol}`;
  const row = readLookup<{ cap: number | null }>(key);
  if (row && Date.now() - row.fetchedAt < MARKET_CAP_TTL_MS) return row.payload?.cap ?? null;
  const once = async (retry: boolean): Promise<number | null> => {
    const { cookie, crumb } = await getSession(retry);
    const res = await fetch(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=price&crumb=${encodeURIComponent(crumb)}`,
      { headers: { 'User-Agent': UA, Cookie: cookie } });
    if (res.status === 401 && !retry) return once(true);
    if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
    const raw = ((await res.json()) as { quoteSummary?: { result?: { price?: { marketCap?: { raw?: unknown } } }[] } })
      .quoteSummary?.result?.[0]?.price?.marketCap?.raw;
    return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null;
  };
  try {
    const cap = await once(false);
    writeLookup(key, Date.now(), { cap });
    return cap;
  } catch {
    noteLookupFailure();
    return row?.payload?.cap ?? null;
  }
}

// --- Putting it together ------------------------------------------------------

export interface ListedPosition {
  symbol: string; name: string; cusip: string; value: number;
  share: number;            // of one dollar of the company
  named?: boolean;          // no ticker found: `symbol` is the normalized name
  sector?: string | null; country?: string;
}
export interface ListedLookThrough {
  key: string; symbol: string; remainderName: string;
  asOf: string; filed: string; marketCap: number;
  listedShare: number;      // the part opened into positions
  positions: ListedPosition[];
  sector: string | null;    // the company's own sector, for its remainder
  note: string;             // plain words for the page
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/**
 * The look-through for one company from its 13F rows and market cap (tickers
 * already attached to the rows), or null when any guard fails. Pure.
 */
export function buildLookThrough(
  key: string, co: ListedHoldingsCompany, filing: Pick<ThirteenF, 'period' | 'filed'>,
  positions: Omit<ListedPosition, 'share'>[], caps: (number | null)[], now = Date.now(),
): ListedLookThrough | null {
  const known = caps.filter((c): c is number => c != null && c > 0);
  if (!known.length) return null;
  const cap = known[0];
  if (known.some(c => Math.abs(c - cap) / cap > CLASS_CAP_TOLERANCE)) return null; // the classes disagree: don't trust either
  if ((now - Date.parse(`${filing.period}T00:00:00Z`)) / DAY_MS > MAX_FILING_AGE_DAYS) return null;
  const listedValue = positions.reduce((s, p) => s + p.value, 0);
  const listedShare = listedValue / cap;
  if (!(listedShare >= MIN_LISTED_SHARE && listedShare <= MAX_LISTED_SHARE)) return null;
  const name = co.remainderName.replace(/\s*\(.*\)$/, '');
  return {
    key, symbol: co.symbols[0], remainderName: co.remainderName,
    asOf: filing.period, filed: filing.filed, marketCap: cap, listedShare,
    positions: positions.map(p => ({ ...p, share: p.value / cap })),
    sector: null,
    note: `${pct(listedShare)} of ${name} is the listed stocks in its 13F filing for the quarter ended ${filing.period} ` +
      `(filed ${filing.filed}), counted under those stocks. The rest, its own businesses, cash and bonds, stays here.`,
  };
}

async function loadOne(key: string, co: ListedHoldingsCompany): Promise<ListedLookThrough | null> {
  const [filing, caps] = await Promise.all([
    cached13f(co.cik),
    Promise.all(co.symbols.map(s => marketCap(s))),
  ]);
  if (!filing) return null;
  // Tickers: OpenFIGI's answer for the CUSIP if it has one (it tells share
  // classes apart: GOOGL / GOOG), else the SEC ticker file's by name; the rest
  // stay name-keyed and are queued for OpenFIGI.
  const unknown: { cusip: string }[] = [];
  const positions = filing.rows.map(r => {
    const figi = knownTicker({ cusip: r.cusip });
    if (figi === undefined) unknown.push({ cusip: r.cusip });
    const symbol = figi ?? r.ticker ?? null;
    const p: Omit<ListedPosition, 'share'> = { symbol: symbol ?? normalizeIssuerName(r.name), name: r.name, cusip: r.cusip, value: r.value };
    if (!symbol) p.named = true;
    return p;
  });
  if (unknown.length) queueTickerLookups(unknown);
  const lt = buildLookThrough(key, co, filing, positions, caps);
  if (!lt) return null;
  // Sector and country of each position (Yahoo, cached a day like any
  // holding's), and the company's own sector for what stays as it.
  const metas = await Promise.all([co.symbols[0], ...lt.positions.map(p => p.named ? null : p.symbol)]
    .map(s => (s ? fetchSecurityMeta(s).catch(() => null) : Promise.resolve(null))));
  lt.sector = metas[0]?.sector ?? null;
  lt.positions.forEach((p, i) => {
    const m = metas[i + 1];
    p.sector = m?.sector ?? null;
    // A US CUSIP starts with a digit; a CINS (foreign issuer) with a letter.
    p.country = m?.country ?? (/^\d/.test(p.cusip) ? 'United States' : undefined);
  });
  return lt;
}

/** Every LISTED_HOLDINGS company that can be opened right now, by key. */
export async function fetchListedLookThroughs(): Promise<Map<string, ListedLookThrough>> {
  const entries = await Promise.all(Object.entries(LISTED_HOLDINGS).map(async ([key, co]) =>
    [key, await loadOne(key, co).catch(() => null)] as const));
  return new Map(entries.filter((e): e is [string, ListedLookThrough] => e[1] != null));
}

/**
 * A holdings list with each listed company opened: its row becomes one row per
 * 13F position (marked `via`) plus a remainder row under the company's own
 * symbol. Percents are preserved exactly, so the list's total doesn't move.
 */
export function openListedCompanies(list: Constituent[], lts: Map<string, ListedLookThrough>): Constituent[] {
  if (!lts.size) return list;
  const out: Constituent[] = [];
  for (const c of list) {
    const key = c.via ? null : listedCompanyKey(c); // never open an opened row again
    const lt = key ? lts.get(key) : undefined;
    if (!lt) { out.push(c); continue; }
    for (const p of lt.positions) {
      const row: Constituent = { symbol: p.symbol, name: p.name, percent: c.percent * p.share, cusip: p.cusip, via: lt.key };
      if (p.country) row.country = p.country;
      if (p.named) row.named = true;
      out.push(row);
    }
    out.push({ symbol: lt.symbol, name: lt.remainderName, percent: c.percent * (1 - lt.listedShare), country: c.country ?? 'United States', via: lt.key });
  }
  return out;
}
