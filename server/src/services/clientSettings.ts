import { getDb } from '../db/schema.js';

// Server-side mirror of the browser's `mon.*` client settings (Forecast
// assumptions, earners, kids, budget/allocation prefs, …). localStorage is
// per-device, so on a shared (NAS) deployment a user opening KevFin from another
// computer would otherwise start from defaults. Persisting the settings here
// makes the database the source of truth and the inputs follow the user.
//
// Values are opaque JSON strings the client wrote; the server never parses them.

export function getAllClientSettings(): Record<string, string> {
  const rows = getDb().prepare('SELECT key, value FROM client_settings').all() as { key: string; value: string }[];
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export function setClientSetting(key: string, value: string): void {
  getDb().prepare(
    `INSERT INTO client_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value);
}
