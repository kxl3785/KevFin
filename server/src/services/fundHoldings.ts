// Per-issuer deep fund holdings. Only Vanguard's investor API is reachable
// without auth (iShares, Invesco, Schwab, SPDR, ProShares all block scripts),
// so this covers Vanguard ETFs and Vanguard fund-of-funds (e.g. target-date).

export interface Constituent { symbol: string; name: string; percent: number; country?: string } // percent 0..1 of the fund

import { isinToCountry } from './country.js';

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

// Vanguard fund-of-funds (target-date) constituents aren't exposed by the API,
// so map them to their documented underlying funds. Weights from the published
// glide path; equity sleeves are decomposed to stocks, bonds bucketed.
const FUND_OF_FUNDS: Record<string, { ticker: string; weight: number; kind: 'equity' | 'bond' }[]> = {
  // Vanguard Target Retirement 2055 (~90/10): Total US + Total Intl stocks, Total US + Intl bonds.
  VFFVX: [
    { ticker: 'VTI', weight: 0.54, kind: 'equity' },
    { ticker: 'VXUS', weight: 0.36, kind: 'equity' },
    { ticker: 'BND', weight: 0.07, kind: 'bond' },
    { ticker: 'BNDX', weight: 0.03, kind: 'bond' },
  ],
  // iShares LifePath Target Date 2040 (~75/25) — proxy for a 529 "Portfolio 2042".
  ITDD: [
    { ticker: 'VTI', weight: 0.45, kind: 'equity' },
    { ticker: 'VXUS', weight: 0.30, kind: 'equity' },
    { ticker: 'BND', weight: 0.18, kind: 'bond' },
    { ticker: 'BNDX', weight: 0.07, kind: 'bond' },
  ],
};

// Blocked-issuer ETFs → closest Vanguard equivalent (same index/style) whose
// holdings ARE reachable. Used as a stand-in for stock look-through only.
const PROXY_FUND: Record<string, string> = {
  IVV: 'VOO',   // iShares S&P 500 → Vanguard S&P 500
  SPY: 'VOO',   // SPDR S&P 500 → Vanguard S&P 500
  SCHX: 'VV',   // Schwab US Large-Cap → Vanguard Large-Cap
  ITOT: 'VTI',  // iShares Total US Market → Vanguard Total US Market
  QQQ: 'VUG',   // Invesco Nasdaq-100 → Vanguard Growth
  TQQQ: 'VUG',  // ProShares 3x Nasdaq-100 → Vanguard Growth (composition; ignores leverage)
  IXUS: 'VXUS', // iShares Total International → Vanguard Total International
  IEMG: 'VWO',  // iShares Emerging Markets → Vanguard Emerging Markets
  SCHF: 'VEA',  // Schwab International Equity → Vanguard Developed Markets
  IWM: 'VTWO',  // iShares Russell 2000 → Vanguard Russell 2000 (small-cap)
  SCHA: 'VB',   // Schwab US Small-Cap → Vanguard Small-Cap
  IJR: 'VB',    // iShares Core S&P Small-Cap → Vanguard Small-Cap
  IJH: 'VO',    // iShares Core S&P Mid-Cap → Vanguard Mid-Cap
};

/**
 * Full constituents for a fund as fractions (0..1) of that fund, or null if no
 * deep source is available (caller should fall back to Yahoo top-10).
 * For fund-of-funds, combines underlying equity sleeves and lumps bonds.
 */
export async function fetchDeepConstituents(symbol: string): Promise<Constituent[] | null> {
  const sym = symbol.toUpperCase();

  const underlying = FUND_OF_FUNDS[sym];
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
  const proxy = PROXY_FUND[sym];
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
