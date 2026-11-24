// Per-issuer deep fund holdings, tried in descending order of freshness:
// Vanguard's investor API (current, reports tickers — but only Vanguard;
// iShares, Invesco, Schwab, SPDR, ProShares all block scripts), then the
// fund's latest quarterly SEC EDGAR N-PORT filing (any US-registered fund,
// ~1–4 months stale), then a Vanguard proxy fund as a last resort.

export interface Constituent { symbol: string; name: string; percent: number; country?: string } // percent 0..1 of the fund

import { isinToCountry } from './country.js';
import { fetchEdgarConstituents } from './edgarHoldings.js';
import { PROXY_FUND, FUND_OF_FUNDS } from '../util/assumptions.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
// Hits expire after ~a day (Vanguard refreshes holdings at most daily) so a
// long-running server doesn't serve one fetch forever.
const CACHE_TTL_MS = 24 * 3600 * 1000;
// Misses are remembered only briefly. Without this every allocation load
// re-asked Vanguard about every fund it had just said no to (two requests per
// fund, one after another for each sleeve of a fund-of-funds), which is what
// made the Investments page slow. A "not found" is a firm answer, so it is
// kept longer than a block, throttle or network error, which may clear quickly.
const MISS_TTL_MS = 6 * 3600 * 1000;
const ERROR_TTL_MS = 2 * 60 * 1000;
const cache = new Map<string, { at: number; out: Constituent[]; ttl: number }>();
// One lookup per fund at a time: concurrent callers share the request.
const inflight = new Map<string, Promise<Constituent[]>>();

/** Test hook: forget every remembered Vanguard answer. */
export function clearFundHoldingsCache(): void {
  cache.clear();
  inflight.clear();
}

// Vanguard returns up to ~500 stock holdings (ticker, shortName, percentWeight "6.70").
export async function fetchVanguardStockHoldings(ticker: string): Promise<Constituent[]> {
  const key = `VG:${ticker.toUpperCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.out;
  const pending = inflight.get(key);
  if (pending) return pending;

  const run = loadVanguardStockHoldings(ticker, key).finally(() => inflight.delete(key));
  inflight.set(key, run);
  return run;
}

async function loadVanguardStockHoldings(ticker: string, key: string): Promise<Constituent[]> {
  let out: Constituent[] = [];
  let firmMiss = true; // every path answered 404 (or 200 with nothing): Vanguard doesn't have it
  for (const kind of ['etfs', 'mutual-funds']) {
    try {
      const url = `https://investor.vanguard.com/investment-products/${kind}/profile/api/${ticker}/portfolio-holding/stock`;
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) { if (res.status !== 404) firmMiss = false; continue; }
      const data = (await res.json()) as { fund?: { entity?: { ticker?: string; shortName?: string; percentWeight?: string; isin?: string }[] } };
      const ent = data.fund?.entity ?? [];
      if (ent.length) {
        out = ent
          .filter(e => e.ticker && e.ticker.trim())
          .map(e => ({
            symbol: e.ticker!.toUpperCase(),
            name: e.shortName ?? e.ticker!,
            percent: (parseFloat(e.percentWeight ?? '0') || 0) / 100,
            country: isinToCountry(e.isin) ?? undefined,
          }));
        break;
      }
    } catch { firmMiss = false; /* try next path */ }
  }
  // An empty result may be a transient block/outage, so it is never kept for
  // long: pinning it would leave the fund holdings-less until a restart.
  cache.set(key, { at: Date.now(), out, ttl: out.length ? CACHE_TTL_MS : firmMiss ? MISS_TTL_MS : ERROR_TTL_MS });
  return out;
}

/**
 * Full constituents for a fund as fractions (0..1) of that fund, or null if no
 * deep source is available (caller should fall back to Yahoo top-10).
 * For fund-of-funds, combines underlying equity sleeves and lumps bonds.
 */
export async function fetchDeepConstituents(symbol: string): Promise<Constituent[] | null> {
  const sym = symbol.toUpperCase();

  const underlying = FUND_OF_FUNDS[sym]?.constituents;
  if (underlying) {
    const byStock = new Map<string, { name: string; percent: number; country?: string }>();
    let bondWeight = 0;
    // Sleeves are independent, so ask for them together rather than one by one.
    const sleeves = underlying.filter(u => u.kind !== 'bond');
    const sleeveHoldings = await Promise.all(sleeves.map(u => fetchVanguardStockHoldings(u.ticker)));
    for (const u of underlying) {
      if (u.kind === 'bond') { bondWeight += u.weight; continue; }
      const holdings = sleeveHoldings[sleeves.indexOf(u)];
      for (const h of holdings) {
        const e = byStock.get(h.symbol) ?? { name: h.name, percent: 0, country: h.country };
        e.percent += u.weight * h.percent;
        if (!e.country && h.country) e.country = h.country;
        byStock.set(h.symbol, e);
      }
    }
    // Only usable if the equity sleeves actually resolved: a lump-only list
    // (all sleeve fetches failed) would be renormalized by the caller into a
    // 100%-bonds position. Fall through to EDGAR instead.
    const hasEquitySleeves = underlying.some(u => u.kind !== 'bond');
    if (byStock.size > 0 || !hasEquitySleeves) {
      const list: Constituent[] = [...byStock.entries()].map(([s, e]) => ({ symbol: s, name: e.name, percent: e.percent, country: e.country }));
      if (bondWeight > 0) list.push({ symbol: '— bonds —', name: 'Underlying bond funds', percent: bondWeight, country: 'Bonds / Commodities / Cash' });
      if (list.length) return list;
    }
  }

  // Directly-held Vanguard equity ETFs — their own API is fresher than a
  // quarterly filing and reports tickers directly.
  if (VANGUARD_ETFS.has(sym)) {
    const h = await fetchVanguardStockHoldings(sym);
    if (h.length) return h;
  }

  // Everything else (and a Vanguard API miss): the fund's latest quarterly
  // N-PORT filing from SEC EDGAR — real holdings for any US-registered fund.
  const edgar = await fetchEdgarConstituents(sym);
  if (edgar?.length) return edgar;

  // Blocked-issuer ETF with no reachable filing → Vanguard proxy holdings.
  const proxy = PROXY_FUND[sym]?.proxy;
  if (proxy) {
    const h = await fetchVanguardStockHoldings(proxy);
    return h.length ? h : null;
  }

  return null;
}

const VANGUARD_ETFS = new Set(['VTI', 'VXUS', 'VOO', 'VEA', 'VWO', 'VUG', 'VTV', 'VGT', 'VB', 'VO', 'VEU', 'VT', 'VTWO', 'VBR', 'VEXC', 'MGK']);
