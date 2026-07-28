import { getDb } from '../db/schema.js';

// Small key/value store on the `meta` table, used for the "when did we last do
// X" clocks that drive the startup catch-ups (real estate, history backfill).

export function getMeta(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setMeta(key: string, value: string): void {
  getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
}
