// Security metadata from Yahoo's quoteSummary (quote type, stock sector, and
// ETF/fund sector weightings for look-through). Requires a cookie + crumb.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

export const SECTOR_LABELS: Record<string, string> = {
  technology: 'Technology',
  financial_services: 'Financial Services',
  healthcare: 'Healthcare',
  consumer_cyclical: 'Consumer Cyclical',
  communication_services: 'Communication Services',
  industrials: 'Industrials',
  consumer_defensive: 'Consumer Defensive',
  energy: 'Energy',
  utilities: 'Utilities',
  basic_materials: 'Basic Materials',
  realestate: 'Real Estate',
};

export interface FundHolding { symbol: string; name: string; percent: number }

export interface SecurityMeta {
  quoteType: string | null;            // ETF | EQUITY | MUTUALFUND | CRYPTOCURRENCY | ...
  sector: string | null;               // for equities
  country: string | null;              // for equities (issuer domicile)
  sectorWeightings: Record<string, number> | null; // for funds/ETFs (label -> weight 0..1)
  holdings: FundHolding[] | null;      // top underlying holdings of a fund/ETF
}

let session: { cookie: string; crumb: string } | null = null;
const metaCache = new Map<string, SecurityMeta>();

async function getSession(force = false): Promise<{ cookie: string; crumb: string }> {
  if (session && !force) return session;
  // Grab cookies, then a matching crumb.
  let cookie = '';
  for (const url of ['https://fc.yahoo.com', 'https://finance.yahoo.com']) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      const sc = r.headers.getSetCookie?.() ?? [];
      if (sc.length) { cookie = sc.map(c => c.split(';')[0]).join('; '); break; }
    } catch { /* try next */ }
  }
  const r = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': UA, Cookie: cookie },
  });
  const crumb = (await r.text()).trim();
  session = { cookie, crumb };
  return session;
}

export async function fetchSecurityMeta(symbol: string): Promise<SecurityMeta> {
  const key = symbol.toUpperCase();
  if (metaCache.has(key)) return metaCache.get(key)!;

  // `cacheable` marks a CONCLUSIVE answer: a 200 (even an empty one) or a 404,
  // both of which mean "this is what Yahoo knows about the symbol". A throttle,
  // auth failure or outage is not conclusive and must not be memoized — the
  // allocation view fetches every symbol at once, so one 429 would otherwise pin
  // a holding to Uncategorized for the rest of the process lifetime.
  const empty: SecurityMeta = { quoteType: null, sector: null, country: null, sectorWeightings: null, holdings: null };

  const fetchOnce = async (retry: boolean): Promise<{ meta: SecurityMeta; cacheable: boolean }> => {
    const { cookie, crumb } = await getSession(retry);
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(key)}?modules=quoteType,assetProfile,topHoldings&crumb=${encodeURIComponent(crumb)}`;
    const res = await fetch(url, { headers: { 'User-Agent': UA, Cookie: cookie } });
    if (res.status === 401 && !retry) return fetchOnce(true); // refresh crumb once
    if (!res.ok) return { meta: empty, cacheable: res.status === 404 };

    const data = (await res.json()) as { quoteSummary?: { result?: any[] } };
    const r = data.quoteSummary?.result?.[0];
    if (!r) return { meta: empty, cacheable: true };

    let sectorWeightings: Record<string, number> | null = null;
    const sw = r.topHoldings?.sectorWeightings as Record<string, { raw?: number }>[] | undefined;
    if (sw?.length) {
      sectorWeightings = {};
      for (const entry of sw) {
        for (const [k, v] of Object.entries(entry)) {
          const w = v?.raw ?? 0;
          if (w > 0) sectorWeightings[SECTOR_LABELS[k] ?? k] = w;
        }
      }
    }

    let holdings: FundHolding[] | null = null;
    const hs = r.topHoldings?.holdings as { symbol?: string; holdingName?: string; holdingPercent?: { raw?: number } }[] | undefined;
    if (hs?.length) {
      holdings = hs
        .filter(h => h.symbol && (h.holdingPercent?.raw ?? 0) > 0)
        .map(h => ({ symbol: h.symbol!.toUpperCase(), name: h.holdingName ?? h.symbol!, percent: h.holdingPercent!.raw! }));
    }

    return {
      meta: {
        quoteType: r.quoteType?.quoteType ?? null,
        sector: r.assetProfile?.sector ?? null,
        country: r.assetProfile?.country ?? null,
        sectorWeightings,
        holdings,
      },
      cacheable: true,
    };
  };

  try {
    const { meta, cacheable } = await fetchOnce(false);
    if (cacheable) metaCache.set(key, meta);
    return meta;
  } catch {
    return empty; // network failure — retry on the next request
  }
}
