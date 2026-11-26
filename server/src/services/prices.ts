// Historical daily closing prices from the Yahoo Finance chart API
// (free, no API key). Symbols are used as-is; mutual funds (e.g. FXAIX) resolve.
// Only the ticker is sent.

import { getHoldingProfile, primaryTicker } from './holdingProfiles.js';
import { readLookup, writeLookup, dropLookups } from './lookupCache.js';
import { noteLookupFailure } from './lookupHealth.js';

// `close` is the raw closing price (used for real market-value reconstruction);
// `adjClose` is split- and distribution-adjusted (used for total-return
// performance, so coupon-heavy assets like bond funds don't look flat).
export interface PricePoint { date: string; close: number; adjClose: number }

// Maps untickered fund descriptions (e.g. 529 plan portfolios) to a chain of
// exchange-traded proxies (primary first). Earlier proxies are spliced in for
// dates the primary doesn't cover, so a newer ETF can fall back to an older one.
const PROXY_RULES: { match: RegExp; tickers: string[] }[] = [
  { match: /total\s*market/i, tickers: ['ITOT'] },     // US total stock market
  { match: /international/i, tickers: ['IXUS'] },       // total international stocks
  { match: /\b20\d\d\b|target|age[-\s]?based|portfolio/i, tickers: ['ITDD', 'AOA'] }, // target-date → AOA before ITDD existed
];

export function proxyTickers(description: string): string[] {
  for (const r of PROXY_RULES) if (r.match.test(description)) return r.tickers;
  return [];
}

// Some brokerages (e.g. Frec) report account balances but no per-position
// holdings, so a portfolio reconstruction has nothing to grow and the line
// stays flat. For those, infer an index proxy from the account's own name and
// grow the whole balance by it. Order matters — narrower rules come first.
const ACCOUNT_PROXY_RULES: { match: RegExp; tickers: string[] }[] = [
  { match: /info(rmation)?\s*tech|technology/i, tickers: ['XLK'] },     // S&P 500 tech sector
  { match: /developed\s*market/i, tickers: ['VEA'] },                   // developed ex-US
  { match: /emerging\s*market/i, tickers: ['VWO'] },                    // emerging markets
  { match: /s&?\s?p\s*500|large[-\s]?cap/i, tickers: ['IVV'] },         // S&P 500
  { match: /total\s*(stock|market)/i, tickers: ['ITOT'] },             // US total market
  { match: /bond|fixed\s*income/i, tickers: ['BND'] },                  // bonds
  { match: /treasur|t-?bill|money\s*market|cash/i, tickers: ['BIL'] },  // short treasuries / cash
];

export function accountProxyTickers(name: string): string[] {
  for (const r of ACCOUNT_PROXY_RULES) if (r.match.test(name)) return r.tickers;
  return [];
}

// Replace specific tickers that have no public market data with a close proxy.
const SYMBOL_SUBSTITUTIONS: Record<string, string[]> = {
  PDZJ: ['VFFVX'], // BJC 401(k) collective trust (no public data) → Vanguard Target Retirement 2055
};

// The effective ticker chain for a holding: the user's own description of what
// it tracks (holdingProfiles.ts) when there is one, else a substituted proxy for
// known dataless tickers, the real ticker, or a description-based proxy if
// untickered. A described mix ("VTI 60, BND 40") follows its HEAVIEST part
// here: price history is one series, and blending several into a synthetic one
// isn't attempted. The allocation look-through uses the full mix.
export function effectiveChain(symbol: string, description: string): string[] {
  const mix = getHoldingProfile(symbol, description);
  if (mix) return [primaryTicker(mix)];
  const s = symbol.trim().toUpperCase();
  if (s) return SYMBOL_SUBSTITUTIONS[s] ?? [symbol];
  return proxyTickers(description);
}

// One stored series per ticker, in memory and in provider_cache. Callers ask
// for very different windows (backfill, performance's 5-year lookback,
// allocation from the earliest lot date), and all are answered from the same
// series: `start`..`end` is the range Yahoo has been asked about, and a request
// inside it is a slice, with no network.
//
// The cache used to be keyed by ticker AND range in process memory. The range
// ends today, so every key went stale at midnight (and at every restart) and
// each ticker's whole 5-year history was downloaded again on the next load.
// Now a new day only fetches the days since the last stored close.
interface Series { start: string; end: string; fullAt: number; points: PricePoint[] }
// As stored: one [date, close, adjClose] row per day.
interface StoredSeries { start: string; end: string; fullAt: number; rows: [string, number, number][] }
const SERIES_PREFIX = 'prices:';
const MISS_PREFIX = 'prices_miss:';
const series = new Map<string, Series>();
// Tickers whose stored rows have been read into memory by this process.
const hydrated = new Set<string>();
// One request per ticker at a time. A caller whose range the pending request
// covers shares its answer (a failure included); any other waits its turn.
const inflight = new Map<string, { start: string; end: string; run: Promise<PricePoint[]> }>();
// "No such symbol" (404) is a firm answer, remembered for a few hours so a
// holding Yahoo can't price (a plan fund, a CUSIP) isn't re-requested on every
// page load. Any other failure (throttle, outage, network) is never remembered:
// the history rebuild depends on these prices, so the next call must try again.
const NOT_FOUND_TTL_MS = 6 * 3600 * 1000;
const notFound = new Map<string, number>(); // ticker -> when Yahoo said 404

// A top-up re-requests the last stored days along with the new ones, and the
// two copies must agree. adjClose is rewritten for EVERY earlier day when a
// fund pays a distribution (and close when a stock splits), so appending new
// days to a series adjusted on an older basis would bend the total-return
// line at the join. A disagreement means the basis moved: the whole series is
// downloaded again. Yahoo's figures for a day don't depend on the range asked
// for (checked: identical to ~1e-6, float noise), hence the tolerance.
const TOP_UP_OVERLAP_DAYS = 30;
const AGREE_TOLERANCE = 5e-6;
// And regardless, start over weekly, so a correction older than the overlap
// can't outlive a week.
const FULL_REFRESH_MS = 7 * 24 * 3600 * 1000;

/** Test hook: forget every remembered price answer. */
export function clearPriceCache(): void {
  series.clear();
  hydrated.clear();
  inflight.clear();
  notFound.clear();
  dropLookups(SERIES_PREFIX);
  dropLookups(MISS_PREFIX);
}

// Read a ticker's stored series (and any remembered 404) into memory, once.
function hydrate(ticker: string): void {
  if (hydrated.has(ticker)) return;
  hydrated.add(ticker);
  const row = readLookup<StoredSeries>(SERIES_PREFIX + ticker)?.payload;
  if (row && typeof row.start === 'string' && typeof row.end === 'string' && Array.isArray(row.rows)) {
    series.set(ticker, {
      start: row.start, end: row.end, fullAt: Number(row.fullAt) || 0,
      points: row.rows.map(([date, close, adjClose]) => ({ date, close, adjClose })),
    });
  }
  const miss = readLookup<unknown>(MISS_PREFIX + ticker);
  if (miss) notFound.set(ticker, miss.fetchedAt);
}

function remember(ticker: string, s: Series): void {
  series.set(ticker, s);
  notFound.delete(ticker);
  writeLookup<StoredSeries>(SERIES_PREFIX + ticker, Date.now(), {
    start: s.start, end: s.end, fullAt: s.fullAt, rows: s.points.map(p => [p.date, p.close, p.adjClose]),
  });
}

const within = (points: PricePoint[], startDate: string, endDate: string) =>
  points.filter(p => p.date >= startDate && p.date <= endDate);

function daysBefore(date: string, n: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// Do the re-requested days match what is stored for them? Same days, same
// closes and adjusted closes, from `from` through the last stored day.
function agrees(stored: PricePoint[], fresh: PricePoint[], from: string): boolean {
  const last = stored[stored.length - 1].date;
  const a = stored.filter(p => p.date >= from);
  const b = fresh.filter(p => p.date <= last);
  if (!a.length || a.length !== b.length) return false;
  const close = (x: number, y: number) => Math.abs(x - y) <= AGREE_TOLERANCE * Math.max(Math.abs(x), Math.abs(y));
  return a.every((p, i) => p.date === b[i].date && close(p.close, b[i].close) && close(p.adjClose, b[i].adjClose));
}

export async function fetchDailyCloses(
  symbol: string,
  startDate: string,
  endDate: string
): Promise<PricePoint[]> {
  const ticker = symbol.toUpperCase();
  hydrate(ticker);

  for (;;) {
    const have = series.get(ticker);
    if (have && have.start <= startDate && have.end >= endDate) return within(have.points, startDate, endDate);
    const missAt = notFound.get(ticker);
    if (missAt != null && Date.now() - missAt < NOT_FOUND_TTL_MS) return [];
    const pending = inflight.get(ticker);
    if (!pending) break;
    if (pending.start <= startDate && pending.end >= endDate) return within(await pending.run, startDate, endDate);
    await pending.run.catch(() => []); // a different range: wait, then look again
  }

  // Never narrow what is stored: an older or longer window than before widens it.
  const have = series.get(ticker);
  const start = have && have.start < startDate ? have.start : startDate;
  const end = have && have.end > endDate ? have.end : endDate;
  const run = loadDailyCloses(symbol, ticker, start, end).finally(() => inflight.delete(ticker));
  inflight.set(ticker, { start, end, run });
  return within(await run, startDate, endDate);
}

// Bring the stored series for `ticker` up to `start`..`end` and return it.
// Returns [] (and stores nothing) when Yahoo can't be reached: only a real
// response is kept, so a transient failure can't pin a symbol empty or leave a
// series that silently stops short of today.
async function loadDailyCloses(symbol: string, ticker: string, start: string, end: string): Promise<PricePoint[]> {
  const have = series.get(ticker);
  const now = Date.now();
  const miss = () => {
    notFound.set(ticker, now);
    writeLookup(MISS_PREFIX + ticker, now, {});
    return [];
  };

  // Top-up: the stored series already reaches back far enough, so ask only for
  // its last days again plus whatever is new.
  if (have && have.points.length && have.start <= start && now - have.fullAt < FULL_REFRESH_MS) {
    const last = have.points[have.points.length - 1].date;
    const overlap = daysBefore(last, TOP_UP_OVERLAP_DAYS);
    const from = overlap > have.start ? overlap : have.start;
    const recent = await requestDailyCloses(symbol, ticker, from, end);
    if (recent === 'failed') return [];
    if (recent === 'unknown') return miss();
    if (agrees(have.points, recent, from)) {
      const points = [...have.points.filter(p => p.date < from), ...recent];
      remember(ticker, { start: have.start, end, fullAt: have.fullAt, points });
      return points;
    }
    // The overlap moved (a distribution or split re-based the history): start over.
  }

  const full = await requestDailyCloses(symbol, ticker, start, end);
  if (full === 'failed') return [];
  if (full === 'unknown') return miss();
  remember(ticker, { start, end, fullAt: now, points: full });
  return full;
}

// One Yahoo chart request. 'unknown' is a 404 (no such symbol); 'failed' is
// anything else that isn't an answer (throttle, outage, network).
async function requestDailyCloses(symbol: string, ticker: string, startDate: string, endDate: string): Promise<PricePoint[] | 'unknown' | 'failed'> {
  const p1 = Math.floor(new Date(startDate + 'T00:00:00Z').getTime() / 1000);
  const p2 = Math.floor(new Date(endDate + 'T00:00:00Z').getTime() / 1000);
  // The URL takes the bare ticker; the dates ride in period1/2 only.
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${p1}&period2=${p2}&interval=1d`;

  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (res.status === 404) return 'unknown';
    if (res.ok) {
      const data = (await res.json()) as {
        chart?: { result?: { timestamp?: number[]; indicators?: { quote?: { close?: (number | null)[] }[]; adjclose?: { adjclose?: (number | null)[] }[] } }[] };
      };
      const r = data.chart?.result?.[0];
      const ts = r?.timestamp ?? [];
      const close = r?.indicators?.quote?.[0]?.close ?? [];
      const adj = r?.indicators?.adjclose?.[0]?.adjclose ?? [];
      return ts
        .map((t, i) => {
          const c = close[i] ?? adj[i];
          if (c == null) return null;
          return { date: new Date(t * 1000).toISOString().slice(0, 10), close: c, adjClose: adj[i] ?? c };
        })
        .filter((p): p is PricePoint => p !== null)
        .sort((a, b) => a.date.localeCompare(b.date));
    }
  } catch (err) {
    console.error(`Yahoo price fetch failed for ${symbol}:`, err);
  }
  noteLookupFailure();
  return 'failed';
}

// Most recent close at or before `date`. Pass field='adjClose' for total-return
// (distribution-adjusted) pricing; defaults to the raw close.
export function closeAsOf(series: PricePoint[], date: string, field: 'close' | 'adjClose' = 'close'): number | null {
  let close: number | null = null;
  for (const p of series) {
    if (p.date <= date) close = field === 'adjClose' ? (p.adjClose ?? p.close) : p.close;
    else break;
  }
  return close;
}
