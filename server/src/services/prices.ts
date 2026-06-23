// Historical monthly closing prices from the Yahoo Finance chart API
// (free, no API key). Symbols are used as-is; mutual funds (e.g. FXAIX) resolve.

export interface PricePoint { date: string; close: number }

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

// Replace specific tickers that have no public market data with a close proxy.
const SYMBOL_SUBSTITUTIONS: Record<string, string[]> = {
  PDZJ: ['VFFVX'], // BJC 401(k) collective trust (no public data) → Vanguard Target Retirement 2055
};

// The effective ticker chain for a holding: a substituted proxy for known
// dataless tickers, the real ticker, or a description-based proxy if untickered.
export function effectiveChain(symbol: string, description: string): string[] {
  const s = symbol.trim().toUpperCase();
  if (s) return SYMBOL_SUBSTITUTIONS[s] ?? [symbol];
  return proxyTickers(description);
}

const cache = new Map<string, PricePoint[]>();

export async function fetchDailyCloses(
  symbol: string,
  startDate: string,
  endDate: string
): Promise<PricePoint[]> {
  const key = symbol.toUpperCase();
  if (cache.has(key)) return cache.get(key)!;

  const p1 = Math.floor(new Date(startDate + 'T00:00:00Z').getTime() / 1000);
  const p2 = Math.floor(new Date(endDate + 'T00:00:00Z').getTime() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(key)}?period1=${p1}&period2=${p2}&interval=1d`;

  let points: PricePoint[] = [];
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (res.ok) {
      const data = (await res.json()) as {
        chart?: { result?: { timestamp?: number[]; indicators?: { quote?: { close?: (number | null)[] }[]; adjclose?: { adjclose?: (number | null)[] }[] } }[] };
      };
      const r = data.chart?.result?.[0];
      const ts = r?.timestamp ?? [];
      const close = r?.indicators?.quote?.[0]?.close ?? [];
      const adj = r?.indicators?.adjclose?.[0]?.adjclose ?? [];
      points = ts
        .map((t, i) => {
          const c = close[i] ?? adj[i];
          return c != null ? { date: new Date(t * 1000).toISOString().slice(0, 10), close: c } : null;
        })
        .filter((p): p is PricePoint => p !== null)
        .sort((a, b) => a.date.localeCompare(b.date));
    }
  } catch (err) {
    console.error(`Yahoo price fetch failed for ${symbol}:`, err);
  }

  cache.set(key, points);
  return points;
}

// Most recent close at or before `date`.
export function closeAsOf(series: PricePoint[], date: string): number | null {
  let close: number | null = null;
  for (const p of series) {
    if (p.date <= date) close = p.close;
    else break;
  }
  return close;
}
