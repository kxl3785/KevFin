import { getDb } from '../db/schema.js';

// Server-side store for the client's UI preferences — the `mon.*` keys the
// front-end used to keep only in the browser's localStorage (Forecast
// assumptions, risk profile, Investments box layout, budget settings, sort/
// filter, show/hide toggles, …).
//
// Keeping them in the DB makes this server the single source of truth, so the
// same settings appear on every browser, device, and hostname that reaches it —
// e.g. the LAN name (`jk-nas:3001`) and the Tailscale MagicDNS name
// (`jk-nas.taile0d08.ts.net:3001`) are different browser origins with separate
// localStorage, but they share this one DB.
//
// Values are stored verbatim as the JSON strings the client serializes, under a
// `pref:` namespace in the shared `meta` key/value table so they never collide
// with operational meta keys (daily_snapshot_enabled, last_real_estate_refresh).

const NS = 'pref:';

// Every stored preference as { key -> raw JSON string }. The client parses each.
export function getAllPrefs(): Record<string, string> {
  const rows = getDb()
    .prepare("SELECT key, value FROM meta WHERE key LIKE 'pref:%'")
    .all() as { key: string; value: string }[];
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key.slice(NS.length)] = r.value;
  return out;
}

// Upsert one preference. `value` is the raw JSON string as the client stored it.
export function setPref(key: string, value: string): void {
  getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(NS + key, value);
}

export function deletePref(key: string): void {
  getDb().prepare('DELETE FROM meta WHERE key = ?').run(NS + key);
}
