// The Investments page's three payloads (GET /api/allocation, with and without
// ?estimate=1; GET /api/performance; GET /api/allocation/fees), served from
// their last stored result (storedResult.ts) instead of being rebuilt on every
// request.
//
// The fingerprint below is what keeps a stored result honest: it must cover
// EVERY database input these three read. Anything added to getAllocation,
// getPerformance or getFeeCheckup that the user or a sync can change belongs
// in it, or a stored copy will outlive the change.
import { createHash } from 'crypto';
import { getDb } from '../db/schema.js';
import { getAllocation, type Allocation } from './allocation.js';
import { getPerformance, type PerformanceData } from './performance.js';
import { getFeeCheckup, type FeeCheckup } from './feeCheckup.js';
import { getPref } from './prefs.js';
import { listProviderCache, countProviderCache } from '../db/providerCache.js';
import { PROFILES_PREF } from './holdingProfiles.js';
import { OVERRIDES_PREF } from './expenseRatios.js';
import { edgarUserAgent } from './edgarHoldings.js';
import { CACHE_PREFIX as FIGI_PREFIX } from './figi.js';
import { appVersion } from './data.js';
import {
  serveStored, refreshStored, storedResultKeys, RESULT_PREFIX,
  type Fingerprint, type Served, type StoredSpec,
} from './storedResult.js';

const digest = (parts: unknown[]) => createHash('sha1').update(JSON.stringify(parts)).digest('hex');

export function investmentFingerprint(): Fingerprint {
  const db = getDb();
  const rows = (sql: string) => db.prepare(sql).all();
  // What the user sets. A change here must show on the very next fetch.
  const edits = digest([
    // A new build may compute (or shape) the answer differently.
    appVersion(),
    rows('SELECT id, name, custom_name, org_name, category, hidden FROM accounts ORDER BY id'),
    rows('SELECT symbol, asset_class FROM asset_class_overrides ORDER BY symbol'),
    rows('SELECT symbol, cost_basis FROM cost_basis_overrides ORDER BY symbol'),
    rows('SELECT symbol, cost_basis FROM imported_cost_basis ORDER BY symbol'),
    rows('SELECT id, address, zestimate, mortgage_balance, excluded_from_allocation FROM properties ORDER BY id'),
    rows('SELECT id, name, value FROM manual_assets ORDER BY id'),
    getPref(PROFILES_PREF),            // "what this holding tracks" descriptions
    getPref(OVERRIDES_PREF),           // the user's own expense ratios
    getPref('mon.fcBucketOverrides'),  // the Forecast's account reassignments (asset location)
    !!edgarUserAgent(),                // SEC holdings are only fetched with a contact email
  ]);
  // What a sync replaces: balances and the holdings feed (each connection's
  // payload is rewritten, with a new fetched_at, whenever it is fetched). Also
  // the count of CUSIP -> ticker answers, which arrive in the background after
  // a look-through and rename rows in it.
  const feed = digest([
    rows('SELECT id, balance FROM accounts ORDER BY id'),
    listProviderCache('sf_cache_'),
    countProviderCache(FIGI_PREFIX),
  ]);
  return { edits, feed };
}

// The spec for a stored key, or null for a key this build doesn't know.
function specFor(key: string): StoredSpec<unknown> | null {
  const name = key.slice(RESULT_PREFIX.length);
  const spec = (compute: () => Promise<unknown>) => ({ key, compute, fingerprint: investmentFingerprint });
  if (name === 'allocation') return spec(() => getAllocation());
  if (name === 'allocation:estimate') return spec(() => getAllocation({ estimate: true }));
  if (name === 'fees') return spec(() => getFeeCheckup());
  const perf = /^performance:(\d+)$/.exec(name);
  if (perf) return spec(() => getPerformance(Number(perf[1])));
  return null;
}

const serve = <T>(name: string) => serveStored(specFor(RESULT_PREFIX + name) as StoredSpec<T>);

export const servedAllocation = (estimate: boolean): Promise<Served<Allocation>> =>
  serve<Allocation>(estimate ? 'allocation:estimate' : 'allocation');

export const servedPerformance = (days: number): Promise<Served<PerformanceData>> =>
  serve<PerformanceData>(`performance:${days}`);

export const servedFeeCheckup = (): Promise<Served<FeeCheckup>> => serve<FeeCheckup>('fees');

// Recompute, in the background, every result the page has asked for before, if
// it is no longer current. Called where the inputs move without the page
// asking: after a sync, after the scheduled snapshots, and at startup, so the
// next visit finds a current copy instead of waiting for one. Never throws.
export function refreshInvestmentResults(): void {
  try {
    for (const key of storedResultKeys()) {
      const spec = specFor(key);
      if (spec) refreshStored(spec);
    }
  } catch (err) {
    console.error('[stored] could not refresh the Investments results:', err);
  }
}
