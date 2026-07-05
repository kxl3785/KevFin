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

export function writeProviderCache<T>(key: string, entry: CacheEntry<T>): void {
  getDb().prepare('INSERT OR REPLACE INTO provider_cache (key, fetched_at, payload) VALUES (?, ?, ?)')
    .run(key, entry.fetchedAt, JSON.stringify(entry.payload));
}
