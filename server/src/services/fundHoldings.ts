// Per-fund deep holdings, tried in descending order of freshness:
//   1. the fund company's own published holdings — Vanguard's investor API
//      (current, reports tickers + ISINs) and SPDR's daily spreadsheet (US-
//      equity SPDR funds). iShares, Schwab and Invesco block scripted downloads.
//   2. a fund of funds (a target-date or balanced fund whose top holdings are
//      other funds, per Yahoo): each underlying fund is looked through in turn,
//      and an underlying bond fund becomes bond/cash rows from its composition.
//   3. the fund's latest quarterly SEC N-PORT filing (any US-registered fund,
//      ~2–5 months stale), whose own registered-fund holdings are opened too.
//   4. the documented sleeves of a few fund-of-funds and Vanguard proxy funds
//      (util/assumptions.ts) as a last resort.
// Only tickers are sent anywhere; nothing about the user's positions.

// percent is 0..1 of the fund. Optional fields:
//  - isin / cusip: identifiers, used to merge one stock across sources and to
//    look up a ticker (figi.ts) when only a name was known.
//  - named: `symbol` is a normalized company name, not a ticker.
//  - fund: the holding is itself a registered fund (a target-date fund's index
//    funds) — fetchDeepConstituents looks through it in turn.
//  - kind: set only on summary rows for a fund's non-equity part (bond / cash /
//    other); their symbol is a '— … —' label and country a pseudo-country.
export interface Constituent {
  symbol: string; name: string; percent: number; country?: string;
  isin?: string; cusip?: string; named?: boolean; fund?: boolean; kind?: 'bond' | 'cash' | 'other';
}

import { isinToCountry } from './country.js';
import { fetchEdgarConstituents, lump } from './edgarHoldings.js';
import { fetchSecurityMeta, type SecurityMeta, type FundComposition } from './yahooMeta.js';
import { readFirstSheet } from '../util/xlsx.js';
import { PROXY_FUND, FUND_OF_FUNDS } from '../util/assumptions.js';
import { readLookup, writeLookup, dropLookups } from './lookupCache.js';
import { noteLookupFailure } from './lookupHealth.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
// Hits expire after ~a day (fund companies refresh holdings at most daily) so a
// long-running server doesn't serve one fetch forever.
const CACHE_TTL_MS = 24 * 3600 * 1000;
// Misses are remembered only briefly. Without this every allocation load
// re-asked about every fund that had just said no, which is what made the
// Investments page slow. A "not found" is a firm answer, so it is kept longer
// than a block, throttle or network error, which may clear quickly.
const MISS_TTL_MS = 6 * 3600 * 1000;
const ERROR_TTL_MS = 2 * 60 * 1000;
const cache = new Map<string, { at: number; out: Constituent[]; ttl: number }>();
// One lookup per fund at a time: concurrent callers share the request.
const inflight = new Map<string, Promise<Constituent[]>>();
// Hits and firm misses are also kept in provider_cache, under the same TTLs, so
// a restart doesn't send the next Investments load back to every fund company.
// A failure is held in memory only: it should be gone after a restart.
const STORE_PREFIX = 'fund_holdings:';

/** Test hook: forget every remembered fund-company answer. */
export function clearFundHoldingsCache(): void {
  cache.clear();
  inflight.clear();
  dropLookups(STORE_PREFIX);
}

// The stored answer for `key`, read into memory the first time it is wanted.
function remembered(key: string): { at: number; out: Constituent[]; ttl: number } | undefined {
  const hit = cache.get(key);
  if (hit) return hit;
  const row = readLookup<{ out: Constituent[]; ttl: number }>(STORE_PREFIX + key);
  if (!row || !Array.isArray(row.payload?.out) || !Number.isFinite(row.payload.ttl)) return undefined;
  const stored = { at: row.fetchedAt, out: row.payload.out, ttl: row.payload.ttl };
  cache.set(key, stored);
  return stored;
}

// Memoized, single-flight fetch of one fund company's answer. The loader
// reports whether an empty answer was a firm "don't have it" or a failure.
async function memo(key: string, load: () => Promise<{ out: Constituent[]; firmMiss: boolean }>): Promise<Constituent[]> {
  const hit = remembered(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.out;
  const pending = inflight.get(key);
  if (pending) return pending;
  const run = (async () => {
    let out: Constituent[] = [], firmMiss = false;
    try { ({ out, firmMiss } = await load()); } catch { /* network: short hold */ }
    // An empty result may be a transient block/outage, so it is never kept for
    // long: pinning it would leave the fund holdings-less until a restart.
    const entry = { at: Date.now(), out, ttl: out.length ? CACHE_TTL_MS : firmMiss ? MISS_TTL_MS : ERROR_TTL_MS };
    cache.set(key, entry);
    if (out.length || firmMiss) writeLookup(STORE_PREFIX + key, entry.at, { out, ttl: entry.ttl });
    else noteLookupFailure();
    return out;
  })().finally(() => inflight.delete(key));
  inflight.set(key, run);
  return run;
}

// --- Vanguard ---------------------------------------------------------------

// Vanguard's investor API (moved under /vmf/api in 2026; the old
// /investment-products/…/profile/api path now 404s). Pages of up to 2000
// holdings; percentWeight is a percent of the WHOLE fund, so a balanced fund's
// stocks sum to ~60 and the rest is filled from its composition.
const VANGUARD_PAGE = 2000;
const VANGUARD_MAX_PAGES = 5; // 10,000 holdings: every Vanguard stock fund but the total-world ones, which keep ~99% by weight
// ETF share classes the API errors on, mapped to their mutual-fund twin (same portfolio).
export const VANGUARD_SHARE_CLASS: Record<string, string> = { VXUS: 'VTIAX' };

interface VanguardEntity { ticker?: string; shortName?: string; longName?: string; percentWeight?: string; isin?: string; cusip?: string }
interface VanguardPage { size?: number; fund?: { entity?: VanguardEntity[] }; response?: unknown }

async function loadVanguard(ticker: string): Promise<{ out: Constituent[]; firmMiss: boolean }> {
  const entities: VanguardEntity[] = [];
  for (let page = 0; page < VANGUARD_MAX_PAGES; page++) {
    const url = `https://investor.vanguard.com/vmf/api/${encodeURIComponent(ticker)}/portfolio-holding/stock?start=${page * VANGUARD_PAGE + 1}&count=${VANGUARD_PAGE}`;
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) {
      if (page > 0) break; // keep what the earlier pages gave
      return { out: [], firmMiss: res.status === 404 };
    }
    const data = (await res.json()) as VanguardPage;
    // A fund Vanguard doesn't serve comes back 200 with an error body or size 0.
    if (data.response !== undefined && !data.fund) return { out: [], firmMiss: page === 0 };
    const ent = data.fund?.entity ?? [];
    entities.push(...ent);
    if (ent.length < VANGUARD_PAGE || entities.length >= (data.size ?? 0)) break;
  }
  const out = entities
    .filter(e => e.ticker && e.ticker.trim())
    .map(e => {
      const c: Constituent = {
        // Share classes come as "BRK B"; Yahoo and the rest of the app use "BRK-B".
        symbol: e.ticker!.trim().toUpperCase().replace(/^([A-Z]+)[ ./]([A-Z])$/, '$1-$2'),
        name: e.shortName ?? e.longName ?? e.ticker!,
        percent: (parseFloat(e.percentWeight ?? '0') || 0) / 100,
        country: isinToCountry(e.isin) ?? undefined,
      };
      if (e.isin) c.isin = e.isin.toUpperCase();
      if (e.cusip) c.cusip = e.cusip.toUpperCase();
      return c;
    })
    .filter(c => c.percent > 0);
  return { out, firmMiss: true };
}

// Vanguard's stock holdings (ticker, name, percent of fund, ISIN country).
export async function fetchVanguardStockHoldings(ticker: string): Promise<Constituent[]> {
  const t = ticker.toUpperCase();
  const direct = await memo(`VG:${t}`, () => loadVanguard(t));
  if (direct.length || !VANGUARD_SHARE_CLASS[t]) return direct;
  return memo(`VG:${VANGUARD_SHARE_CLASS[t]}`, () => loadVanguard(VANGUARD_SHARE_CLASS[t]));
}

// --- SPDR (State Street) ------------------------------------------------------

// SPDR posts each ETF's full holdings daily as a spreadsheet. Its rows carry a
// ticker and CUSIP but no country, so it is used only for funds of US-listed
// stocks (≥ 90% of weight in USD lines): a US CUSIP (digit first) is a US
// issuer; anything else gets its country from the fund's N-PORT filing if one
// is cached, else none. Foreign-stock SPDR funds use N-PORT instead.
export function parseSpdrSheet(rows: string[][]): { out: Constituent[]; usdShare: number } {
  const hi = rows.findIndex(r => r[0]?.toLowerCase() === 'name' && r.some(c => c.toLowerCase() === 'weight'));
  if (hi < 0) return { out: [], usdShare: 0 };
  const col = (label: string) => rows[hi].findIndex(c => c.toLowerCase() === label);
  const iTicker = col('ticker'), iId = col('identifier'), iWeight = col('weight'), iCcy = col('local currency');
  const out: Constituent[] = [];
  let total = 0, usd = 0, cash = 0;
  for (const r of rows.slice(hi + 1)) {
    const name = (r[0] ?? '').trim();
    if (!name) break; // the holdings table ends at the first blank row (disclaimers follow)
    const w = parseFloat(r[iWeight] ?? '');
    if (!isFinite(w) || w <= 0) continue;
    total += w;
    const ccy = (iCcy >= 0 ? r[iCcy] : 'USD') || 'USD';
    if (ccy === 'USD') usd += w;
    const ticker = (r[iTicker] ?? '').trim().toUpperCase().replace('/', '-').replace(/\.(?=[A-Z]$)/, '-');
    if (!ticker || ticker === '-' || /\bcash\b|\bdollar\b|currency/i.test(name) && !/^[A-Z]{1,5}$/.test(ticker)) { cash += w; continue; }
    const id = iId >= 0 ? (r[iId] ?? '').trim().toUpperCase() : '';
    const c: Constituent = { symbol: ticker, name, percent: w / 100 };
    if (/^[0-9A-Z]{9}$/.test(id)) {
      c.cusip = id;
      if (ccy === 'USD' && /^\d/.test(id)) c.country = 'United States';
    }
    out.push(c);
  }
  if (cash > 0.05) out.push(lump('cash', cash / 100));
  return { out, usdShare: total ? usd / total : 0 };
}

async function loadSpdr(ticker: string): Promise<{ out: Constituent[]; firmMiss: boolean }> {
  const url = `https://www.ssga.com/us/en/intermediary/library-content/products/fund-data/etfs/us/holdings-daily-us-en-${encodeURIComponent(ticker.toLowerCase())}.xlsx`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) return { out: [], firmMiss: res.status === 404 };
  const { out, usdShare } = parseSpdrSheet(readFirstSheet(Buffer.from(await res.arrayBuffer())));
  // A non-US fund is a firm "use something else", not a failure.
  return usdShare >= 0.9 ? { out, firmMiss: true } : { out: [], firmMiss: true };
}

export async function fetchSpdrHoldings(ticker: string): Promise<Constituent[]> {
  const t = ticker.toUpperCase();
  const out = await memo(`SPDR:${t}`, () => loadSpdr(t));
  if (!out.some(c => !c.country && c.cusip)) return out;
  // Fill the few non-US issuers' countries from the fund's own N-PORT filing.
  const edgar = await fetchEdgarConstituents(t).catch(() => null);
  if (!edgar?.length) return out;
  const byCusip = new Map(edgar.filter(e => e.cusip && e.country).map(e => [e.cusip!, e.country!]));
  return out.map(c => (!c.country && c.cusip && byCusip.has(c.cusip) ? { ...c, country: byCusip.get(c.cusip) } : c));
}

// --- Composing ---------------------------------------------------------------

const FUND_TYPES = new Set(['MUTUALFUND', 'ETF', 'MONEYMARKET', 'CLOSEDENDFUND']);
const MAX_DEPTH = 2; // a target-date fund → its index funds → their stocks

// Bond / cash / other rows for `weight` of a fund with this composition.
function lumpsFor(comp: FundComposition, weight: number): Constituent[] {
  // Slivers under 0.1% of the fund (an index fund's futures) are left out
  // rather than shown as a 0.0% Alternatives slice.
  const out: Constituent[] = [];
  if (comp.bond * weight > 1e-3) out.push(lump('bond', comp.bond * weight));
  if (comp.cash * weight > 1e-3) out.push(lump('cash', comp.cash * weight));
  if (comp.other * weight > 1e-3) out.push(lump('other', comp.other * weight));
  return out;
}

// A fund company's stock list covers only stocks; add the fund's non-stock part
// from its composition so a balanced fund isn't read as all-stock. Capped so the
// total never passes 100%.
function withNonStock(stocks: Constituent[], comp: FundComposition | null | undefined): Constituent[] {
  if (!comp || stocks.some(c => c.kind)) return stocks;
  const stockSum = stocks.reduce((s, c) => s + c.percent, 0);
  const room = Math.max(0, 1 - stockSum);
  const nonStock = comp.bond + comp.cash + comp.other;
  if (nonStock <= 0 || room <= 0) return stocks;
  const scale = Math.min(1, room / nonStock);
  return [...stocks, ...lumpsFor(comp, scale)];
}

// Sum rows that name the same holding (two sleeves both owning Apple), and the
// bond / cash / other rows by kind.
export function mergeConstituents(list: Constituent[]): Constituent[] {
  const by = new Map<string, Constituent>();
  for (const c of list) {
    const key = c.kind ? `kind:${c.kind}` : c.isin ? `isin:${c.isin}` : `sym:${c.symbol}`;
    const e = by.get(key);
    if (!e) { by.set(key, { ...c }); continue; }
    e.percent += c.percent;
    if (!e.country && c.country) e.country = c.country;
    // Prefer a real ticker over a name key for the merged row.
    if (e.named && !c.named) { e.symbol = c.symbol; delete e.named; }
  }
  return [...by.values()].sort((a, b) => (a.kind ? 1 : 0) - (b.kind ? 1 : 0) || b.percent - a.percent);
}

// Look through `weight` of an underlying fund.
async function expandFund(symbol: string, name: string, weight: number, meta: SecurityMeta | null, depth: number, seen: Set<string>): Promise<Constituent[]> {
  const comp = meta?.composition;
  // A bond / money-market fund: its composition is all we need, and skipping
  // the download avoids a 10,000-line bond-fund filing.
  if (comp && comp.stock < 0.05) return lumpsFor(comp, weight);
  const deep = seen.has(symbol) ? null : await fetchDeepConstituents(symbol, { depth: depth + 1, seen });
  // Whatever the deep list leaves uncovered (a fund company's top 2000 of a
  // 3,500-stock fund) stays unattributed; the caller's "beyond reported
  // holdings" row picks it up.
  if (deep?.length) return deep.map(c => ({ ...c, percent: c.percent * weight }));
  // No look-through for this sleeve: keep it as one opaque row for its stock
  // part, plus its bond/cash rows.
  const opaque: Constituent = { symbol, name, percent: weight * (comp ? comp.stock : 1), fund: true };
  return comp ? [opaque, ...lumpsFor(comp, weight)] : [opaque];
}

// Yahoo lists a fund of funds' underlying funds as its "top holdings" (VFFVX →
// VSMPX 55%, VGTSX 36%, VTBIX 6%, VTILX 3%). When most of the weight is in
// other funds and the list covers most of the fund, look through each one.
async function fromYahooFundOfFunds(meta: SecurityMeta, depth: number, seen: Set<string>): Promise<Constituent[] | null> {
  const hs = meta.holdings ?? [];
  const total = hs.reduce((s, h) => s + h.percent, 0);
  if (hs.length < 2 || total < 0.8) return null;
  const metas = await Promise.all(hs.map(h => fetchSecurityMeta(h.symbol).catch(() => null)));
  const fundWeight = hs.reduce((s, h, i) => s + (FUND_TYPES.has(metas[i]?.quoteType ?? '') ? h.percent : 0), 0);
  if (fundWeight < 0.5 * total) return null; // ordinary top-10 of a stock fund
  const parts = await Promise.all(hs.map((h, i) => FUND_TYPES.has(metas[i]?.quoteType ?? '')
    ? expandFund(h.symbol, h.name, h.percent, metas[i], depth, seen)
    : Promise.resolve([{ symbol: h.symbol, name: h.name, percent: h.percent }] as Constituent[])));
  return mergeConstituents(parts.flat());
}

// An N-PORT list whose holdings include registered funds: open those too.
async function expandEdgarFunds(list: Constituent[], depth: number, seen: Set<string>): Promise<Constituent[]> {
  const funds = list.filter(c => c.fund && !c.named);
  if (!funds.length || depth >= MAX_DEPTH) return list;
  const metas = await Promise.all(funds.map(f => fetchSecurityMeta(f.symbol).catch(() => null)));
  const expanded = await Promise.all(funds.map((f, i) => expandFund(f.symbol, f.name, f.percent, metas[i], depth, seen)));
  return mergeConstituents([...list.filter(c => !(c.fund && !c.named)), ...expanded.flat()]);
}

/**
 * Full constituents for a fund as fractions (0..1) of that fund, or null if no
 * deep source is available (caller should fall back to Yahoo top-10). Non-stock
 * parts come back as bond / cash / other rows (`kind`).
 */
export async function fetchDeepConstituents(symbol: string, opts: { depth?: number; seen?: Set<string> } = {}): Promise<Constituent[] | null> {
  const sym = symbol.toUpperCase();
  const depth = opts.depth ?? 0;
  const seen = new Set(opts.seen ?? []);
  seen.add(sym);
  const meta = await fetchSecurityMeta(sym).catch(() => null);
  if (meta?.quoteType === 'EQUITY' || meta?.quoteType === 'CRYPTOCURRENCY') return null; // nothing inside a single stock

  // 1. The fund company's own list.
  if (meta?.family === 'Vanguard' || VANGUARD_ETFS.has(sym) || VANGUARD_SHARE_CLASS[sym]) {
    const h = await fetchVanguardStockHoldings(sym);
    if (h.length) return withNonStock(h, meta?.composition);
  }
  if (/\bspdr\b|state street/i.test(meta?.family ?? '')) {
    const h = await fetchSpdrHoldings(sym);
    if (h.length) return withNonStock(h, meta?.composition);
  }

  // 2. A fund of funds, from Yahoo's list of its underlying funds.
  if (meta && depth < MAX_DEPTH) {
    const fof = await fromYahooFundOfFunds(meta, depth, seen);
    if (fof?.length) return fof;
  }

  // 3. The fund's latest quarterly N-PORT filing — any US-registered fund.
  const edgar = await fetchEdgarConstituents(sym);
  if (edgar?.length) return expandEdgarFunds(edgar, depth, seen);

  // 4. Documented sleeves, then a Vanguard proxy fund.
  const legacy = await fromDocumentedSleeves(sym);
  if (legacy) return legacy;
  const proxy = PROXY_FUND[sym]?.proxy;
  if (proxy) {
    const h = await fetchVanguardStockHoldings(proxy);
    return h.length ? h : null;
  }
  return null;
}

// A few fund-of-funds mapped by hand to their published sleeves (used when
// neither Yahoo nor SEC can describe them). Equity sleeves are decomposed to
// stocks, bond sleeves become one bond row.
async function fromDocumentedSleeves(sym: string): Promise<Constituent[] | null> {
  const underlying = FUND_OF_FUNDS[sym]?.constituents;
  if (!underlying) return null;
  const sleeves = underlying.filter(u => u.kind !== 'bond');
  // Sleeves are independent, so ask for them together rather than one by one.
  const sleeveHoldings = await Promise.all(sleeves.map(u => fetchVanguardStockHoldings(u.ticker)));
  const parts: Constituent[] = [];
  let bondWeight = 0;
  for (const u of underlying) {
    if (u.kind === 'bond') { bondWeight += u.weight; continue; }
    for (const h of sleeveHoldings[sleeves.indexOf(u)]) parts.push({ ...h, percent: h.percent * u.weight });
  }
  // Only usable if the equity sleeves actually resolved: a lump-only list
  // (all sleeve fetches failed) would be renormalized by the caller into a
  // 100%-bonds position.
  if (!parts.length && sleeves.length) return null;
  if (bondWeight > 0) parts.push(lump('bond', bondWeight));
  return parts.length ? mergeConstituents(parts) : null;
}

const VANGUARD_ETFS = new Set(['VTI', 'VXUS', 'VOO', 'VEA', 'VWO', 'VUG', 'VTV', 'VGT', 'VB', 'VO', 'VEU', 'VT', 'VTWO', 'VBR', 'VEXC', 'MGK']);
