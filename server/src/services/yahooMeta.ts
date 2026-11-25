// Security metadata from Yahoo's quoteSummary (quote type, stock sector, and
// ETF/fund sector weightings, stock/bond/cash split, bond credit quality and
// fund company for look-through). Requires a cookie + crumb. Only the ticker
// symbol is sent.

export const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

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

// A fund's broad split as fractions of the whole fund (Yahoo's topHoldings
// stockPosition / bondPosition / cashPosition / ...). Preferred and convertible
// positions are folded into `bond` (income securities that behave more like
// bonds than stocks); `other` is whatever is left (derivatives, commodities).
export interface FundComposition { stock: number; bond: number; cash: number; other: number }

// Credit quality of a fund's BOND portion: rating label -> share of the bonds
// (sums to ~1). `govShare` is reported separately by Yahoo and overlaps the
// ratings (Treasuries are rated AA), so it's never added to them.
export interface BondProfile { ratings: Record<string, number>; govShare: number | null; duration: number | null; maturity: number | null }

export interface SecurityMeta {
  quoteType: string | null;            // ETF | EQUITY | MUTUALFUND | CRYPTOCURRENCY | ...
  sector: string | null;               // for equities
  country: string | null;              // for equities (issuer domicile)
  // For funds/ETFs: label -> weight 0..1 of the fund's STOCK portion (Yahoo's
  // weights always sum to 1, even for a 60/40 fund) — scale by composition.stock.
  sectorWeightings: Record<string, number> | null;
  holdings: FundHolding[] | null;      // top underlying holdings of a fund/ETF
  family: string | null;               // fund company ("Vanguard", "iShares", ...)
  composition: FundComposition | null; // stock/bond/cash split of a fund
  bonds: BondProfile | null;           // only for funds that hold bonds
}

export const RATING_LABELS: Record<string, string> = {
  aaa: 'AAA', aa: 'AA', a: 'A', bbb: 'BBB', bb: 'BB', b: 'B', below_b: 'Below B', other: 'Not rated',
};

const num = (v: unknown): number | null => {
  const raw = (v as { raw?: unknown } | null | undefined)?.raw;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
};

// Pure: the stock/bond/cash split from a quoteSummary topHoldings module, or null
// when Yahoo reports none (individual stocks, or funds it has no breakdown for).
export function parseComposition(th: Record<string, unknown> | undefined): FundComposition | null {
  if (!th) return null;
  const stock = Math.max(0, num(th.stockPosition) ?? 0);
  const bond = Math.max(0, (num(th.bondPosition) ?? 0) + (num(th.preferredPosition) ?? 0) + (num(th.convertiblePosition) ?? 0));
  const cash = Math.max(0, num(th.cashPosition) ?? 0);
  const other = Math.max(0, num(th.otherPosition) ?? 0);
  const sum = stock + bond + cash + other;
  // Positions are fractions that should sum to ~1; anything far off is junk.
  if (sum < 0.5 || sum > 1.5) return null;
  return { stock: stock / sum, bond: bond / sum, cash: cash / sum, other: other / sum };
}

// Pure: bond credit-quality profile, only when the fund actually holds bonds.
export function parseBondProfile(th: Record<string, unknown> | undefined, comp: FundComposition | null): BondProfile | null {
  if (!th || !comp || comp.bond < 0.02) return null;
  const ratings: Record<string, number> = {};
  let govShare: number | null = null;
  for (const entry of (th.bondRatings as Record<string, unknown>[] | undefined) ?? []) {
    for (const [k, v] of Object.entries(entry ?? {})) {
      const w = num(v);
      if (w == null) continue;
      if (k === 'us_government') { govShare = Math.max(0, Math.min(1, w)); continue; }
      if (w > 0 && RATING_LABELS[k]) ratings[RATING_LABELS[k]] = (ratings[RATING_LABELS[k]] ?? 0) + w;
    }
  }
  const total = Object.values(ratings).reduce((a, b) => a + b, 0);
  if (total > 0) for (const k of Object.keys(ratings)) ratings[k] /= total;
  const bh = th.bondHoldings as Record<string, unknown> | undefined;
  const duration = num(bh?.duration) ?? num(bh?.durationCat);
  const maturity = num(bh?.maturity) ?? num(bh?.maturityCat);
  if (total === 0 && duration == null && maturity == null) return null;
  return { ratings, govShare, duration, maturity };
}

let session: { cookie: string; crumb: string } | null = null;
// Memoized answers expire so a long-running server picks up reclassifications
// (a fund's sector mix, a ticker newly listed) instead of pinning the first
// answer for the process lifetime.
const META_TTL_MS = 24 * 3600 * 1000;
const metaCache = new Map<string, { at: number; meta: SecurityMeta }>();

// Exported so the expense-ratio lookup (expenseRatios.ts) reuses the same
// cookie + crumb rather than opening a second Yahoo session.
// The allocation view asks about every symbol at once. Without sharing, each of
// those lookups opened its own cookie + crumb handshake on a cold start.
let sessionInflight: Promise<{ cookie: string; crumb: string }> | null = null;
export async function getSession(force = false): Promise<{ cookie: string; crumb: string }> {
  if (session && !force) return session;
  if (sessionInflight) return sessionInflight;
  sessionInflight = openSession().finally(() => { sessionInflight = null; });
  return sessionInflight;
}

async function openSession(): Promise<{ cookie: string; crumb: string }> {
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

// Concurrent lookups of one symbol (the allocation view and the fee check-up
// often run together) share a single request.
const metaInflight = new Map<string, Promise<SecurityMeta>>();

export async function fetchSecurityMeta(symbol: string): Promise<SecurityMeta> {
  const key = symbol.toUpperCase();
  const hit = metaCache.get(key);
  if (hit && Date.now() - hit.at < META_TTL_MS) return hit.meta;
  const pending = metaInflight.get(key);
  if (pending) return pending;
  const run = loadSecurityMeta(key).finally(() => metaInflight.delete(key));
  metaInflight.set(key, run);
  return run;
}

async function loadSecurityMeta(key: string): Promise<SecurityMeta> {

  // `cacheable` marks a CONCLUSIVE answer: a 200 (even an empty one) or a 404,
  // both of which mean "this is what Yahoo knows about the symbol". A throttle,
  // auth failure or outage is not conclusive and must not be memoized — the
  // allocation view fetches every symbol at once, so one 429 would otherwise pin
  // a holding to Uncategorized for the rest of the process lifetime.
  const empty: SecurityMeta = { quoteType: null, sector: null, country: null, sectorWeightings: null, holdings: null, family: null, composition: null, bonds: null };

  const fetchOnce = async (retry: boolean): Promise<{ meta: SecurityMeta; cacheable: boolean }> => {
    const { cookie, crumb } = await getSession(retry);
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(key)}?modules=quoteType,assetProfile,topHoldings,fundProfile&crumb=${encodeURIComponent(crumb)}`;
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

    const composition = parseComposition(r.topHoldings);
    return {
      meta: {
        quoteType: r.quoteType?.quoteType ?? null,
        sector: r.assetProfile?.sector ?? null,
        country: r.assetProfile?.country ?? null,
        sectorWeightings,
        holdings,
        family: typeof r.fundProfile?.family === 'string' && r.fundProfile.family.trim() ? r.fundProfile.family.trim() : null,
        composition,
        bonds: parseBondProfile(r.topHoldings, composition),
      },
      cacheable: true,
    };
  };

  try {
    const { meta, cacheable } = await fetchOnce(false);
    if (cacheable) metaCache.set(key, { at: Date.now(), meta });
    return meta;
  } catch {
    return empty; // network failure — retry on the next request
  }
}
