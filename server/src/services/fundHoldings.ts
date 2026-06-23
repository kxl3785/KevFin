// Per-issuer deep fund holdings. Only Vanguard's investor API is reachable
// without auth (iShares, Invesco, Schwab, SPDR, ProShares all block scripts),
// so this covers Vanguard ETFs and Vanguard fund-of-funds (e.g. target-date).

export interface Constituent { symbol: string; name: string; percent: number; country?: string } // percent 0..1 of the fund

import { isinToCountry } from './country.js';
import { PROXY_FUND, FUND_OF_FUNDS } from '../util/assumptions.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const cache = new Map<string, Constituent[]>();

// Vanguard returns up to ~500 stock holdings (ticker, shortName, percentWeight "6.70").
async function fetchVanguardStockHoldings(ticker: string): Promise<Constituent[]> {
  const key = `VG:${ticker.toUpperCase()}`;
  if (cache.has(key)) return cache.get(key)!;

  let out: Constituent[] = [];
  for (const kind of ['etfs', 'mutual-funds']) {
    try {
      const url = `https://investor.vanguard.com/investment-products/${kind}/profile/api/${ticker}/portfolio-holding/stock`;
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) continue;
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
    } catch { /* try next path */ }
  }
  cache.set(key, out);
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
    for (const u of underlying) {
      if (u.kind === 'bond') { bondWeight += u.weight; continue; }
      const holdings = await fetchVanguardStockHoldings(u.ticker);
      for (const h of holdings) {
        const e = byStock.get(h.symbol) ?? { name: h.name, percent: 0, country: h.country };
        e.percent += u.weight * h.percent;
        if (!e.country && h.country) e.country = h.country;
        byStock.set(h.symbol, e);
      }
    }
    const list: Constituent[] = [...byStock.entries()].map(([s, e]) => ({ symbol: s, name: e.name, percent: e.percent, country: e.country }));
    if (bondWeight > 0) list.push({ symbol: '— bonds —', name: 'Underlying bond funds', percent: bondWeight, country: 'Bonds / Commodities / Cash' });
    return list.length ? list : null;
  }

  // Blocked-issuer ETF → Vanguard proxy with reachable holdings.
  const proxy = PROXY_FUND[sym]?.proxy;
  if (proxy) {
    const h = await fetchVanguardStockHoldings(proxy);
    return h.length ? h : null;
  }

  // Directly-held Vanguard equity ETFs.
  if (VANGUARD_ETFS.has(sym)) {
    const h = await fetchVanguardStockHoldings(sym);
    return h.length ? h : null;
  }

  return null;
}

const VANGUARD_ETFS = new Set(['VTI', 'VXUS', 'VOO', 'VEA', 'VWO', 'VUG', 'VTV', 'VGT', 'VB', 'VO', 'VEU', 'VT', 'VTWO', 'VBR', 'VEXC', 'MGK']);
