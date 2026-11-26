import { getDb } from './schema.js';

// Persistent cache for provider payloads (SimpleFIN /accounts, Plaid
// transactions). These used to live as JSON blobs in the `meta` table, which
// mixed multi-MB payloads in with small settings and migration flags; they get
// their own table so meta stays a settings store. Entries survive restarts and
// are the offline fallback when a provider fetch fails.

export interface CacheEntry<T> { fetchedAt: number; payload: T }

export function readProviderCache<T>(key: string): CacheEntry<T> | null {
  const row = getDb().prepare('SELECT fetched_at, payload FROM provider_cache WHERE key = ?').get(key) as
    { fetched_at: number; payload: string } | undefined;
  if (!row) return null;
  try { return { fetchedAt: row.fetched_at, payload: JSON.parse(row.payload) as T }; } catch { return null; }
}

// Drop one cached payload (e.g. when its connection/item is disconnected) — the raw
// feed holds full balance/transaction history, which must not outlive the link.
export function deleteProviderCache(key: string): void {
  getDb().prepare('DELETE FROM provider_cache WHERE key = ?').run(key);
}

export function writeProviderCache<T>(key: string, entry: CacheEntry<T>): void {
  getDb().prepare('INSERT OR REPLACE INTO provider_cache (key, fetched_at, payload) VALUES (?, ?, ?)')
    .run(key, entry.fetchedAt, JSON.stringify(entry.payload));
}

// Entries by key prefix. Each is a range scan of the primary key (every key
// starting with `prefix` sorts between it and prefix + the last code point), so
// none of them reads a payload: some rows hold megabytes.
const range = (prefix: string): [string, string] => [prefix, prefix + '\u{10FFFF}'];

/** Every key that starts with `prefix`, with when it was fetched. */
export function listProviderCache(prefix: string): { key: string; fetchedAt: number }[] {
  return getDb().prepare('SELECT key, fetched_at AS fetchedAt FROM provider_cache WHERE key >= ? AND key < ? ORDER BY key')
    .all(...range(prefix)) as { key: string; fetchedAt: number }[];
}

export function countProviderCache(prefix: string): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM provider_cache WHERE key >= ? AND key < ?').get(...range(prefix)) as { n: number }).n;
}

export function deleteProviderCachePrefix(prefix: string): void {
  getDb().prepare('DELETE FROM provider_cache WHERE key >= ? AND key < ?').run(...range(prefix));
}
