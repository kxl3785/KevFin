// Deep fund holdings from SEC EDGAR N-PORT filings. Every US-registered fund
// (iShares, Schwab, SPDR, Invesco, … — not just Vanguard) must file its full
// portfolio quarterly on Form N-PORT, so this covers the issuers whose own
// APIs block scripts. The trade-off is freshness: holdings are as of the most
// recently filed quarter (public ~1–4 months after the fact), which is fine
// for allocation look-through — fund composition drifts slowly.
//
// Pipeline (3 requests per fund, then cached in SQLite for 30 days):
//   1. ticker → series id      via sec.gov/files/company_tickers_mf.json
//   2. series → latest N-PORT  via browse-edgar (atom feed, newest first)
//   3. filing → primary_doc.xml, <invstOrSec> blocks parsed for holdings
//
// N-PORT identifies holdings by name/CUSIP/ISIN — never ticker — so issuer
// names are matched to tickers via sec.gov/files/company_tickers.json using a
// normalized-name lookup. Unmatched holdings keep their (normalized) name as
// the aggregation key so the same stock still merges across funds.

import { getDb } from '../db/schema.js';
import { isinToCountry } from './country.js';
import type { Constituent } from './fundHoldings.js';

// SEC's fair-access policy 403s "undeclared automated tools": the User-Agent
// must identify the tool AND a contact in "Name email@domain" form
// (https://www.sec.gov/os/accessing-edgar-data) — a plain product string gets
// rejected. Set SEC_EDGAR_UA (e.g. "KevFin you@example.com") to declare
// yourself; the default declares the project via its GitHub noreply address.
const UA = process.env.SEC_EDGAR_UA ?? 'KevFin personal net-worth tracker kxl3785@users.noreply.github.com';

// Last few EDGAR failures, surfaced via GET /api/meta/edgar so "why is this
// fund still showing top-10 holdings?" is answerable from the browser instead
// of container logs.
const recentErrors: { symbol: string; error: string; at: string }[] = [];
function noteError(symbol: string, err: unknown) {
  recentErrors.unshift({ symbol, error: err instanceof Error ? err.message : String(err), at: new Date().toISOString() });
  if (recentErrors.length > 20) recentErrors.length = 20;
}

const POSITIVE_TTL_DAYS = 30; // holdings are quarterly; re-check monthly
const NEGATIVE_TTL_DAYS = 7;  // "no filing found" — re-check weekly
const MAP_TTL_MS = 7 * 24 * 3600 * 1000; // ticker-mapping files change rarely
const MAP_RETRY_MS = 10 * 60 * 1000;     // …but retry sooner after a failed fetch
// Bail on enormous filings (10k+-position bond funds). Their look-through
// would collapse to one non-equity lump anyway, which the name-based fallback
// in allocation.ts already produces without the download.
const MAX_DOC_BYTES = 20 * 1024 * 1024;

// --- Throttled fetch: SEC allows max 10 req/s; serialize with a small gap so
// a burst of funds fetched via Promise.all can't trip the limiter. ---
let queue: Promise<unknown> = Promise.resolve();
function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn);
  queue = run.then(
    () => new Promise(r => setTimeout(r, 150)),
    () => new Promise(r => setTimeout(r, 150)),
  );
  return run;
}

async function fetchText(url: string): Promise<string> {
  return throttled(async () => {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`EDGAR ${res.status} for ${url}`);
    return res.text();
  });
}

async function fetchJson(url: string): Promise<unknown> {
  return throttled(async () => {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`EDGAR ${res.status} for ${url}`);
    return res.json();
  });
}

// --- Pure parsers (exported for tests) ---

export interface FundSeries { cik: number; seriesId: string }

// company_tickers_mf.json: { fields: ["cik","seriesId","classId","symbol"], data: [[…], …] }.
// Covers every mutual-fund/ETF share class; ETFs are a series with one class.
export function parseMfTickers(raw: unknown): Map<string, FundSeries> {
  const out = new Map<string, FundSeries>();
  const data = raw as { fields?: string[]; data?: unknown[][] };
  const fields = data?.fields ?? [];
  const iCik = fields.indexOf('cik'), iSeries = fields.indexOf('seriesId'), iSym = fields.indexOf('symbol');
  if (iCik < 0 || iSeries < 0 || iSym < 0) return out;
  for (const row of data.data ?? []) {
    const sym = String(row[iSym] ?? '').toUpperCase().trim();
    const seriesId = String(row[iSeries] ?? '');
    const cik = Number(row[iCik]);
    if (sym && /^S\d+$/.test(seriesId) && cik > 0 && !out.has(sym)) out.set(sym, { cik, seriesId });
  }
  return out;
}

// company_tickers.json: { "0": { cik_str, ticker, title }, … }, roughly ordered
// by size — so on a normalized-name collision the bigger issuer wins.
export function parseCompanyTickers(raw: unknown): Map<string, string> {
  const out = new Map<string, string>();
  for (const v of Object.values((raw as Record<string, unknown>) ?? {})) {
    const { ticker, title } = (v ?? {}) as { ticker?: string; title?: string };
    if (!ticker || !title) continue;
    const key = normalizeIssuerName(title);
    if (key && !out.has(key)) out.set(key, ticker.toUpperCase());
  }
  return out;
}

// Canonical form of an issuer name so "Apple Inc." (SEC ticker file) matches
// "APPLE INC" (N-PORT): uppercase, punctuation stripped, legal-form suffixes
// and share-class markers dropped. Applied to BOTH sides of the lookup, so
// over-stripping is harmless as long as it's consistent.
export function normalizeIssuerName(name: string): string {
  return name
    .toUpperCase()
    .replace(/['’.]/g, '')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\b(THE|INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|PLC|LP|LLC|NV|SA|SE|AG|AB|ASA|SPA|OYJ|CLASS|CL|SHS|SHARES|ADR|ADS|COM|NEW|[ABC])\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// The newest filing in a browse-edgar atom feed (entries are newest-first):
// pull cik + dash-less accession number from the first /Archives/ link, or
// fall back to the first accession-number-shaped string in the feed.
export function parseLatestFilingPath(atom: string): { cik: string | null; accession: string } | null {
  const href = atom.match(/Archives\/edgar\/data\/(\d+)\/(\d{12,})\//);
  if (href) return { cik: href[1], accession: href[2] };
  const acc = atom.match(/(\d{10})-(\d{2})-(\d{6})/);
  if (acc) return { cik: null, accession: `${acc[1]}${acc[2]}${acc[3]}` };
  return null;
}

function decodeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function tag(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? decodeXml(m[1].trim()) : null;
}

export interface NportResult { asOf: string | null; constituents: Constituent[] }

/**
 * Parse an N-PORT primary_doc.xml into look-through constituents. Equity
 * positions (assetCat EC/EP) become individual constituents with percent as a
 * fraction of the fund; everything else (bonds, repos, cash, derivatives) is
 * lumped into one non-equity row, mirroring how fund-of-funds bond sleeves are
 * lumped in fundHoldings.ts. Short/negative positions are skipped.
 */
export function parseNport(xml: string, tickerByName: Map<string, string>): NportResult {
  const asOf = tag(xml, 'repPdDate');
  const constituents: Constituent[] = [];
  let nonEquityPct = 0;

  for (const m of xml.matchAll(/<invstOrSec>([\s\S]*?)<\/invstOrSec>/g)) {
    const block = m[1];
    const pctVal = parseFloat(tag(block, 'pctVal') ?? '');
    if (!isFinite(pctVal) || pctVal <= 0) continue; // shorts/payables have no place in a long-only breakdown

    const assetCat = tag(block, 'assetCat');
    if (assetCat !== 'EC' && assetCat !== 'EP') { nonEquityPct += pctVal; continue; }

    // Issuer name; some filers put "N/A" in <name> and the real one in <title>.
    let name = tag(block, 'name') ?? '';
    if (!name || name.toUpperCase() === 'N/A') name = tag(block, 'title') ?? name;
    if (!name) continue;

    const isin = block.match(/<isin[^>]*value="([^"]+)"/)?.[1] ?? tag(block, 'isin') ?? undefined;
    const invCountry = tag(block, 'invCountry') ?? undefined;
    const normalized = normalizeIssuerName(name);
    const ticker = tickerByName.get(normalized)
      ?? tickerByName.get(normalizeIssuerName(tag(block, 'title') ?? ''));

    constituents.push({
      // Without a ticker, key by the normalized name so the same stock still
      // aggregates across EDGAR-sourced funds despite small name variations.
      symbol: ticker ?? normalized,
      name,
      percent: pctVal / 100,
      // isinToCountry reads the first two chars, so a bare ISO-2 invCountry works too.
      country: isinToCountry(isin) ?? isinToCountry(invCountry) ?? undefined,
    });
  }

  constituents.sort((a, b) => b.percent - a.percent);
  if (nonEquityPct > 0.1) {
    constituents.push({
      symbol: '— non-equity —', name: 'Bonds / cash / other',
      percent: nonEquityPct / 100, country: 'Bonds / Commodities / Cash',
    });
  }
  return { asOf, constituents };
}

// --- Mapping files, cached in memory (they're MBs, but fetched at most
// weekly). Single-flight: allocation fetches all funds via Promise.all, so
// concurrent callers must share one download instead of each pulling the file. ---

interface CachedMap<T> { fetchedAt: number; map: Map<string, T> }

function cachedMapping<T>(url: string, parse: (raw: unknown) => Map<string, T>): () => Promise<Map<string, T>> {
  let cache: CachedMap<T> | null = null;
  let inflight: Promise<Map<string, T>> | null = null;
  return async () => {
    const ttl = cache && cache.map.size > 0 ? MAP_TTL_MS : MAP_RETRY_MS;
    if (cache && Date.now() - cache.fetchedAt < ttl) return cache.map;
    inflight ??= (async () => {
      try {
        cache = { fetchedAt: Date.now(), map: parse(await fetchJson(url)) };
      } catch (err) {
        console.error(`EDGAR mapping fetch failed (${url}):`, err);
        noteError('(mapping)', err);
        cache = { fetchedAt: Date.now(), map: cache?.map ?? new Map() }; // keep any stale map; retry sooner
      } finally {
        inflight = null;
      }
      return cache.map;
    })();
    return inflight;
  };
}

const getMfTickerMap = cachedMapping('https://www.sec.gov/files/company_tickers_mf.json', parseMfTickers);
const getTickerByName = cachedMapping('https://www.sec.gov/files/company_tickers.json', parseCompanyTickers);

// --- Orchestration ---

// One EDGAR round-trip: ticker → series → newest N-PORT → parsed holdings.
// Returns null when EDGAR definitively has nothing usable (not a registered
// fund, no filing, oversized filing); throws on transient/network failure so
// the caller can keep serving stale data instead of caching a false negative.
async function fetchFromEdgar(sym: string): Promise<NportResult | null> {
  const mfMap = await getMfTickerMap();
  if (mfMap.size === 0) throw new Error('EDGAR fund-ticker mapping unavailable');
  const series = mfMap.get(sym);
  if (!series) return null; // not a US-registered fund (e.g. a stock) — cacheable negative

  const atom = await fetchText(
    `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${series.seriesId}&type=NPORT-P&dateb=&owner=include&count=10&output=atom`,
  );
  const filing = parseLatestFilingPath(atom);
  if (!filing) return null; // series exists but has never filed N-PORT (e.g. money-market funds)

  const base = `https://www.sec.gov/Archives/edgar/data/${filing.cik ?? series.cik}/${filing.accession}`;
  const index = (await fetchJson(`${base}/index.json`)) as { directory?: { item?: { name?: string; size?: string | number }[] } };
  const xmls = (index.directory?.item ?? []).filter(i => i.name?.toLowerCase().endsWith('.xml') && !/index/i.test(i.name));
  const doc = xmls.find(i => i.name === 'primary_doc.xml')
    ?? xmls.sort((a, b) => (Number(b.size) || 0) - (Number(a.size) || 0))[0];
  if (!doc?.name) return null;
  if (Number(doc.size) > MAX_DOC_BYTES) return null; // giant bond-fund filing; lump-only look-through isn't worth it

  const tickerByName = await getTickerByName();
  if (tickerByName.size === 0) throw new Error('EDGAR company-ticker mapping unavailable');

  const parsed = parseNport(await fetchText(`${base}/${doc.name}`), tickerByName);
  return parsed.constituents.length ? parsed : null;
}

// 'YYYY-MM-DD HH:MM:SS' UTC `days` ago — same format as SQLite's datetime('now'),
// so freshness is a plain string comparison.
function cutoff(days: number): string {
  return new Date(Date.now() - days * 86400e3).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Constituents for any US-registered fund from its latest quarterly N-PORT
 * filing, or null if EDGAR has nothing for the symbol. Cached in SQLite (30
 * days for hits, 7 for misses); on a transient EDGAR failure the previous
 * cached holdings keep being served no matter how old.
 */
export async function fetchEdgarConstituents(symbol: string): Promise<Constituent[] | null> {
  const sym = symbol.toUpperCase();
  const db = getDb();
  const row = db.prepare('SELECT holdings, fetched_at FROM edgar_fund_holdings WHERE symbol = ?')
    .get(sym) as { holdings: string | null; fetched_at: string } | undefined;
  if (row && row.fetched_at >= cutoff(row.holdings ? POSITIVE_TTL_DAYS : NEGATIVE_TTL_DAYS)) {
    return row.holdings ? (JSON.parse(row.holdings) as Constituent[]) : null;
  }

  let result: NportResult | null;
  try {
    result = await fetchFromEdgar(sym);
  } catch (err) {
    console.error(`EDGAR holdings fetch failed for ${sym}:`, err);
    noteError(sym, err);
    // Transient failure: serve stale holdings if we have them, and leave the
    // cache row untouched so the next request retries.
    return row?.holdings ? (JSON.parse(row.holdings) as Constituent[]) : null;
  }

  db.prepare(`
    INSERT INTO edgar_fund_holdings (symbol, as_of, holdings, fetched_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(symbol) DO UPDATE SET as_of = excluded.as_of, holdings = excluded.holdings, fetched_at = excluded.fetched_at
  `).run(sym, result?.asOf ?? null, result ? JSON.stringify(result.constituents) : null);
  return result?.constituents ?? null;
}

// Diagnostics for GET /api/meta/edgar: the User-Agent in use, every cached
// symbol with its holdings count (null = EDGAR had nothing) and as-of date,
// and the most recent fetch errors.
export interface EdgarStatus {
  userAgent: string;
  cache: { symbol: string; asOf: string | null; holdings: number | null; fetchedAt: string }[];
  recentErrors: { symbol: string; error: string; at: string }[];
}

export function getEdgarStatus(): EdgarStatus {
  const rows = getDb().prepare('SELECT symbol, as_of, holdings, fetched_at FROM edgar_fund_holdings ORDER BY fetched_at DESC')
    .all() as { symbol: string; as_of: string | null; holdings: string | null; fetched_at: string }[];
  return {
    userAgent: UA,
    cache: rows.map(r => ({
      symbol: r.symbol, asOf: r.as_of,
      holdings: r.holdings ? (JSON.parse(r.holdings) as unknown[]).length : null,
      fetchedAt: r.fetched_at,
    })),
    recentErrors,
  };
}
