// Annual expense ratios for the fee check-up on the Allocation page.
//
// Source: the same Yahoo quoteSummary endpoint yahooMeta.ts already calls for
// sector data, asked for its fund modules (fundProfile + defaultKeyStatistics).
// Only the ticker symbol is sent — exactly like the existing price and metadata
// calls; no balance, account or other user data leaves the machine.
//
// Fund fees change rarely (once a year, at most), so each answer is kept in
// provider_cache for ~30 days per symbol. A "Yahoo has no figure" answer is kept
// for a week, and a failed lookup (throttle, outage) isn't kept at all, so the
// next visit retries; meanwhile an expired but known figure is still served
// (stale-on-error), so a refresh that hits a throttle never turns a fund that
// had a fee yesterday into "unknown" today. The user's own figures (stored in prefs) always win and
// are applied by the caller — see util/expenseRatio.ts classifyRatio().
import { getSession, UA } from './yahooMeta.js';
import { readProviderCache, writeProviderCache } from '../db/providerCache.js';
import { getAllPrefs, setPref } from './prefs.js';
import { extractExpenseRatio, isValidExpenseRatio, parseOverrides } from '../util/expenseRatio.js';

export const RATIO_TTL_MS = 30 * 24 * 3600 * 1000;
export const MISSING_TTL_MS = 7 * 24 * 3600 * 1000;
// v2: ratios are now read from Yahoo's exact `raw` value instead of its
// two-decimal display string, so rows cached under the old prefix (rounded:
// FXAIX's 0.015% stored as 0.01%) are left behind rather than served for a month.
export const CACHE_PREFIX = 'expense_ratio2:';

// The prefs key holding the user's per-holding figures ({ holdingId: ratio }).
// `mon.` like every other UI preference; written only by PUT /expense-ratio.
export const OVERRIDES_PREF = 'mon.expenseRatioOverrides';

interface CachedRatio { ratio: number | null }

// One symbol's published ratio, or null when unknown. Never throws.
export async function fetchExpenseRatio(symbol: string, now = Date.now()): Promise<number | null> {
  const key = symbol.trim().toUpperCase();
  if (!key) return null;
  const cacheKey = CACHE_PREFIX + key;

  // An expired but valid figure, kept to fall back on if the refresh fails.
  let stale: number | null = null;
  try {
    const hit = readProviderCache<CachedRatio>(cacheKey);
    if (hit) {
      const ttl = hit.payload?.ratio == null ? MISSING_TTL_MS : RATIO_TTL_MS;
      const valid = isValidExpenseRatio(hit.payload?.ratio) ? hit.payload.ratio : null;
      if (now - hit.fetchedAt < ttl) return valid;
      stale = valid;
    }
  } catch { /* unreadable cache row: fall through to a fresh lookup */ }

  // `cacheable` marks a conclusive answer (a 200, or a 404 for a ticker Yahoo
  // doesn't know); a throttle/auth failure/outage is retried next time.
  const fetchOnce = async (retry: boolean): Promise<{ ratio: number | null; cacheable: boolean }> => {
    const { cookie, crumb } = await getSession(retry);
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(key)}?modules=fundProfile,defaultKeyStatistics&crumb=${encodeURIComponent(crumb)}`;
    const res = await fetch(url, { headers: { 'User-Agent': UA, Cookie: cookie } });
    if (res.status === 401 && !retry) return fetchOnce(true); // stale crumb: refresh once
    if (!res.ok) return { ratio: null, cacheable: res.status === 404 };
    const data = (await res.json()) as { quoteSummary?: { result?: unknown[] } };
    return { ratio: extractExpenseRatio(data.quoteSummary?.result?.[0]), cacheable: true };
  };

  // A conclusive answer (200 or 404) replaces the cache, even when it now says
  // "no figure". An inconclusive one (throttle, outage, network failure) serves
  // the stale figure, if any, WITHOUT touching fetchedAt, so the next request
  // tries again.
  try {
    const { ratio, cacheable } = await fetchOnce(false);
    if (!cacheable) return stale;
    try { writeProviderCache<CachedRatio>(cacheKey, { fetchedAt: now, payload: { ratio } }); } catch { /* cache is best-effort */ }
    return ratio;
  } catch {
    return stale; // network failure — last known figure (or unknown), retried next request
  }
}

// The user's per-holding figures, keyed by holdingId (symbol, or name when the
// holding has no ticker).
export function getExpenseOverrides(): Record<string, number> {
  return parseOverrides(getAllPrefs()[OVERRIDES_PREF]);
}

// Set (ratio) or clear (null) one holding's figure. The caller validates.
export function setExpenseOverride(id: string, ratio: number | null): void {
  const all = getExpenseOverrides();
  if (ratio == null) delete all[id];
  else all[id] = ratio;
  setPref(OVERRIDES_PREF, JSON.stringify(all));
}
