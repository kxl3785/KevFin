// Best-effort persistence for public market lookups (price history, fund
// company holdings, Yahoo fund details), in the provider_cache table.
//
// These used to live only in process memory, so every restart (and every
// deploy is one) threw them away and the next Investments load waited on all
// of them again. Only what a provider said about a TICKER is stored here,
// never anything about the user's positions.
//
// The cache is an optimisation, never a dependency: an unreadable row or a
// failed write is treated as "not cached" and the lookup carries on.
import { readProviderCache, writeProviderCache, deleteProviderCachePrefix, type CacheEntry } from '../db/providerCache.js';

// Never open the default (real) database from a test: a test that reaches a
// lookup without setting DB_PATH simply runs with the in-memory layer alone.
const unavailable = () => !!process.env.VITEST && !process.env.DB_PATH;

export function readLookup<T>(key: string): CacheEntry<T> | null {
  if (unavailable()) return null;
  try { return readProviderCache<T>(key); } catch { return null; }
}

export function writeLookup<T>(key: string, fetchedAt: number, payload: T): void {
  if (unavailable()) return;
  try { writeProviderCache<T>(key, { fetchedAt, payload }); } catch { /* best-effort */ }
}

export function dropLookups(prefix: string): void {
  if (unavailable()) return;
  try { deleteProviderCachePrefix(prefix); } catch { /* best-effort */ }
}
