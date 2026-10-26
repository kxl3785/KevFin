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
import { countryNameForCode, isinToCountry, relabelCountry } from './country.js';
import type { Constituent } from './fundHoldings.js';

// SEC's fair-access policy 403s "undeclared automated tools": the User-Agent
// must identify the tool AND a real contact in "Name email@domain" form
// (https://www.sec.gov/os/accessing-edgar-data), and requests should accept
// gzip/deflate. A plain product string — or a GitHub noreply address — gets
// rejected, so there is deliberately NO built-in default identity: the user
// supplies a contact email (in-app Setup, SEC_CONTACT_EMAIL) and until then
// KevFin makes no requests to sec.gov at all. SEC_EDGAR_UA is an advanced
// override for the whole header value. Read per request (not at module load) so
// saving the email in the app takes effect without a restart.
export function edgarUserAgent(): string | null {
  const override = process.env.SEC_EDGAR_UA?.trim();
  if (override) return override;
  const email = process.env.SEC_CONTACT_EMAIL?.trim();
  return email ? `KevFin ${email}` : null;
}

export const NO_CONTACT_MESSAGE = 'SEC contact email not set';

// Typed failure so callers can tell "we never asked SEC" from "SEC said no".
export class EdgarError extends Error {
  constructor(message: string, readonly kind: 'no-contact' | 'http' | 'network', readonly status?: number) {
    super(message);
  }
}

// Last few EDGAR failures, surfaced via GET /api/meta/edgar so "why is this
// fund still showing top-10 holdings?" is answerable from the browser instead
// of container logs.
const recentErrors: { symbol: string; error: string; at: string }[] = [];
function noteError(symbol: string, err: unknown) {
  const error = err instanceof Error ? err.message : String(err);
  const at = new Date().toISOString();
  // Repeats of the same failure (every allocation load while no email is set)
  // refresh the newest entry instead of crowding out other errors.
  if (recentErrors[0]?.symbol === symbol && recentErrors[0].error === error) { recentErrors[0].at = at; return; }
  recentErrors.unshift({ symbol, error, at });
  if (recentErrors.length > 20) recentErrors.length = 20;
}

// Has SEC recently refused us (403 = bad/blocked identity, 429 = rate limit)?
// Cleared by any successful response and by saving a new contact email.
const BLOCKED_WINDOW_MS = 60 * 60 * 1000;
let blocked: { status: number; at: number } | null = null;

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

export function edgarHeaders(ua: string): Record<string, string> {
  return { 'User-Agent': ua, 'Accept-Encoding': 'gzip, deflate' };
}

// One SEC request. Refuses (without touching the network) when no identity is
// configured, and records 403/429 so allocation can explain missing look-through.
async function secFetch(url: string): Promise<Response> {
  const ua = edgarUserAgent();
  if (!ua) throw new EdgarError(NO_CONTACT_MESSAGE, 'no-contact');
  return throttled(async () => {
    const res = await fetch(url, { headers: edgarHeaders(ua) });
    if (!res.ok) {
      if (res.status === 403 || res.status === 429) blocked = { status: res.status, at: Date.now() };
      throw new EdgarError(`EDGAR HTTP ${res.status} for ${url}`, 'http', res.status);
    }
    blocked = null;
    return res;
  });
}

async function fetchText(url: string): Promise<string> {
  return (await secFetch(url)).text();
}

async function fetchJson(url: string): Promise<unknown> {
  return (await secFetch(url)).json();
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
      // invCountry is the issuer's country of risk; the ISIN prefix is only
      // where the security is registered (Cayman/Bermuda/Jersey shells, "XS"
      // Eurobond ISINs). Fall back to the ISIN when invCountry is missing or
      // not a real ISO country code.
      country: countryNameForCode(invCountry) ?? isinToCountry(isin) ?? undefined,
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

// --- Cache format ---
//
// edgar_fund_holdings.holdings used to be a bare Constituent[] whose countries
// came from ISIN prefixes (raw 2-letter codes for anything unmapped). Current
// rows are { v: EDGAR_CACHE_VERSION, constituents } with countries preferring
// N-PORT's invCountry. Bump the version whenever a parser change should make
// every install re-derive its cached holdings; a bare array reads as version 1.
// No SQL migration needed: the column is opaque JSON text.
export const EDGAR_CACHE_VERSION = 2;

export interface CachedHoldings { version: number; constituents: Constituent[] }

export function encodeHoldings(constituents: Constituent[]): string {
  return JSON.stringify({ v: EDGAR_CACHE_VERSION, constituents });
}

// Tolerant reader: null for empty/corrupt JSON. Old-version rows are re-labelled
// (raw "AR" -> "Argentina") so they are still usable as a stale fallback; the
// ISIN-derived countries themselves can only be corrected by refetching.
export function decodeHoldings(json: string | null): CachedHoldings | null {
  if (!json) return null;
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return null; }
  const version = Array.isArray(raw) ? 1 : Number((raw as { v?: unknown })?.v) || 1;
  const list = Array.isArray(raw) ? raw : (raw as { constituents?: unknown })?.constituents;
  if (!Array.isArray(list)) return null;
  const constituents = (list as Constituent[]).map(c =>
    version < EDGAR_CACHE_VERSION && c.country ? { ...c, country: relabelCountry(c.country) } : c);
  return { version, constituents };
}

// --- Mapping files, cached in memory (they're MBs, but fetched at most
// weekly). Single-flight: allocation fetches all funds via Promise.all, so
// concurrent callers must share one download instead of each pulling the file. ---

interface CachedMap<T> { fetchedAt: number; map: Map<string, T>; ok: boolean }
interface FetchOutcome { ok: boolean; status: number | null; error: string | null; at: string }

interface Mapping<T> {
  get: () => Promise<Map<string, T>>;
  reset: () => void;
  lastFetch: () => FetchOutcome | null;
  // " (HTTP 403)" / " (reason)" suffix for the error raised when the map is empty.
  failureSuffix: () => string;
}

function cachedMapping<T>(url: string, parse: (raw: unknown) => Map<string, T>): Mapping<T> {
  let cache: CachedMap<T> | null = null;
  let inflight: Promise<Map<string, T>> | null = null;
  let last: FetchOutcome | null = null;
  let gen = 0; // bumped by reset() so a download started before it can't repopulate the cache
  return {
    get: async () => {
      // A failed refresh keeps serving the stale map but retries sooner — the
      // `ok` flag distinguishes that from a genuinely fresh fetch.
      const ttl = cache && cache.ok && cache.map.size > 0 ? MAP_TTL_MS : MAP_RETRY_MS;
      if (cache && Date.now() - cache.fetchedAt < ttl) return cache.map;
      const myGen = gen;
      inflight ??= (async () => {
        try {
          const map = parse(await fetchJson(url));
          if (myGen === gen) { cache = { fetchedAt: Date.now(), map, ok: true }; last = { ok: true, status: 200, error: null, at: new Date().toISOString() }; }
          return map;
        } catch (err) {
          console.error(`EDGAR mapping fetch failed (${url}):`, err);
          noteError('(mapping)', err);
          if (myGen === gen) {
            cache = { fetchedAt: Date.now(), map: cache?.map ?? new Map(), ok: false }; // keep any stale map; retry sooner
            last = { ok: false, status: err instanceof EdgarError ? err.status ?? null : null, error: err instanceof Error ? err.message : String(err), at: new Date().toISOString() };
          }
          return cache?.map ?? new Map<string, T>();
        } finally {
          if (myGen === gen) inflight = null;
        }
      })();
      return inflight;
    },
    reset: () => { gen++; cache = null; inflight = null; last = null; },
    lastFetch: () => last,
    failureSuffix: () => (last && !last.ok ? (last.status ? ` (HTTP ${last.status})` : ` (${last.error})`) : ''),
  };
}

const mfTickerMapping = cachedMapping('https://www.sec.gov/files/company_tickers_mf.json', parseMfTickers);
const tickerByNameMapping = cachedMapping('https://www.sec.gov/files/company_tickers.json', parseCompanyTickers);

// --- Orchestration ---

// One EDGAR round-trip: ticker → series → newest N-PORT → parsed holdings.
// Returns null when EDGAR definitively has nothing usable (not a registered
// fund, no filing, oversized filing); throws on transient/network failure so
// the caller can keep serving stale data instead of caching a false negative.
async function fetchFromEdgar(sym: string): Promise<NportResult | null> {
  const mfMap = await mfTickerMapping.get();
  if (mfMap.size === 0) throw new Error(`EDGAR fund-ticker mapping unavailable${mfTickerMapping.failureSuffix()}`);
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

  const tickerByName = await tickerByNameMapping.get();
  if (tickerByName.size === 0) throw new Error(`EDGAR company-ticker mapping unavailable${tickerByNameMapping.failureSuffix()}`);

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
  const cached = decodeHoldings(row?.holdings ?? null);
  // A row from an older cache format is treated as expired (once: the refetch
  // rewrites it in the current format) so the better country data takes effect.
  const current = !cached || cached.version >= EDGAR_CACHE_VERSION;
  if (row && current && row.fetched_at >= cutoff(row.holdings ? POSITIVE_TTL_DAYS : NEGATIVE_TTL_DAYS)) {
    return cached?.constituents ?? null;
  }

  // No contact identity: don't contact SEC at all. Serve stale holdings if we
  // have them; the cache row stays untouched (no false negative is recorded).
  if (!edgarUserAgent()) {
    noteError(sym, new EdgarError(NO_CONTACT_MESSAGE, 'no-contact'));
    return cached?.constituents ?? null;
  }

  let result: NportResult | null;
  try {
    result = await fetchFromEdgar(sym);
  } catch (err) {
    console.error(`EDGAR holdings fetch failed for ${sym}:`, err);
    noteError(sym, err);
    // Transient failure: serve stale holdings if we have them (an old-format
    // row is re-labelled by decodeHoldings), and leave the cache row untouched
    // so the next request retries.
    return cached?.constituents ?? null;
  }

  db.prepare(`
    INSERT INTO edgar_fund_holdings (symbol, as_of, holdings, fetched_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(symbol) DO UPDATE SET as_of = excluded.as_of, holdings = excluded.holdings, fetched_at = excluded.fetched_at
  `).run(sym, result?.asOf ?? null, result ? encodeHoldings(result.constituents) : null);
  return result?.constituents ?? null;
}

// Forget memoised mapping downloads/failures and any 403 flag so the very next
// request retries from scratch. Called when the contact email is saved.
export function resetEdgarState(): void {
  mfTickerMapping.reset();
  tickerByNameMapping.reset();
  blocked = null;
}

/**
 * Why look-through can't be fetched right now, or null if nothing is known to be
 * wrong. 'no-contact': no identity configured (we never asked SEC).
 * 'blocked': SEC answered 403/429 within the last hour. Cheap: reads state this
 * module already tracks.
 */
export interface LookThroughIssue { issue: 'no-contact' | 'blocked'; detail: string }
export function getLookThroughIssue(): LookThroughIssue | null {
  if (!edgarUserAgent()) {
    return { issue: 'no-contact', detail: 'Fund holdings need a contact email: SEC asks automated tools to identify themselves.' };
  }
  if (blocked && Date.now() - blocked.at < BLOCKED_WINDOW_MS) {
    return { issue: 'blocked', detail: `SEC answered HTTP ${blocked.status}${blocked.status === 429 ? ' (rate limit)' : ' — it may be rejecting the contact email'}.` };
  }
  return null;
}

// Diagnostics for GET /api/meta/edgar: the identity in use (never a secret),
// every cached symbol with its holdings count (null = EDGAR had nothing) and
// as-of date, the last ticker-mapping fetch outcome, and the most recent errors.
export interface EdgarStatus {
  identityConfigured: boolean;
  contactEmail: string | null;
  userAgent: string | null;
  lastMappingFetch: FetchOutcome | null;
  cache: { symbol: string; asOf: string | null; holdings: number | null; fetchedAt: string }[];
  recentErrors: { symbol: string; error: string; at: string }[];
}

export function getEdgarStatus(): EdgarStatus {
  const rows = getDb().prepare('SELECT symbol, as_of, holdings, fetched_at FROM edgar_fund_holdings ORDER BY fetched_at DESC')
    .all() as { symbol: string; as_of: string | null; holdings: string | null; fetched_at: string }[];
  const ua = edgarUserAgent();
  return {
    identityConfigured: ua != null,
    contactEmail: process.env.SEC_CONTACT_EMAIL?.trim() || null,
    userAgent: ua,
    lastMappingFetch: mfTickerMapping.lastFetch(),
    cache: rows.map(r => ({
      symbol: r.symbol, asOf: r.as_of,
      holdings: decodeHoldings(r.holdings)?.constituents.length ?? null,
      fetchedAt: r.fetched_at,
    })),
    recentErrors,
  };
}
