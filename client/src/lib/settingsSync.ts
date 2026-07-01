// Server-backed persistence for the `mon.*` client settings so a user's planning
// inputs (Forecast assumptions, earners, kids, budget/allocation prefs, …) follow
// them across browsers and devices on a shared (NAS) deployment. localStorage
// alone is per-device, which is why opening KevFin on a new computer previously
// reverted these to defaults. The server DB is the source of truth on load.

const SYNC_PREFIX = 'mon.';
// Keys that are derived (recomputed on load) or transient one-shot handoffs —
// no point round-tripping them, and syncing the navigation intents could fire a
// stale deep-link on another device.
const NO_SYNC = new Set([
  'mon.fcSummary',       // recomputed each Forecast render from synced inputs
  'mon.fcPendingImport', // one-shot document-import handoff, cleared after apply
  'mon.budgetDeepLink',  // in-session navigation intent
  'mon.forecastReturn',  // in-session navigation intent
]);

export function shouldSync(key: string): boolean {
  return key.startsWith(SYNC_PREFIX) && !NO_SYNC.has(key);
}

// The raw JSON we last know the server holds for a key, so a write that matches
// (e.g. the redundant one every usePersistentState hook fires on mount right
// after hydration) is skipped instead of re-uploaded.
const lastSynced = new Map<string, string>();
const timers = new Map<string, number>();

function putRaw(key: string, raw: string): Promise<Response> {
  return fetch(`/api/settings/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: raw }),
  });
}

// Pull every persisted setting from the server into localStorage BEFORE the app
// renders, so usePersistentState's synchronous initializer reads the synced
// value rather than a default. Then seed the server with any local `mon.*` keys
// it doesn't have yet — so the first device to upgrade uploads its existing
// planning inputs (rather than an empty server wiping them elsewhere).
export async function hydrateSettings(): Promise<void> {
  let server: Record<string, unknown> = {};
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch('/api/settings', { signal: ctrl.signal });
    clearTimeout(t);
    if (res.ok) server = await res.json();
    else return; // treat a server error like offline — keep local values
  } catch {
    return; // offline / server down — fall back to whatever localStorage holds
  }

  // Server wins on load.
  for (const [key, value] of Object.entries(server)) {
    if (typeof value !== 'string') continue;
    lastSynced.set(key, value);
    try { localStorage.setItem(key, value); } catch { /* ignore quota */ }
  }

  // Seed the server from this device for keys it hasn't seen yet.
  const seeds: Promise<unknown>[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !shouldSync(key) || key in server) continue;
    const raw = localStorage.getItem(key);
    if (raw == null) continue;
    lastSynced.set(key, raw);
    seeds.push(putRaw(key, raw).catch(() => lastSynced.delete(key)));
  }
  await Promise.allSettled(seeds);
}

// Debounced write-through: coalesce rapid edits (a number field commits on every
// keystroke) into one request per key. Best-effort — localStorage still holds the
// value if the request fails, and the next change retries.
export function syncSetting(key: string, value: unknown): void {
  if (!shouldSync(key)) return;
  let raw: string;
  try { raw = JSON.stringify(value); } catch { return; }
  if (lastSynced.get(key) === raw) return; // unchanged since last known server state
  lastSynced.set(key, raw);                // optimistic; rolled back on failure

  const existing = timers.get(key);
  if (existing) window.clearTimeout(existing);
  timers.set(key, window.setTimeout(() => {
    timers.delete(key);
    putRaw(key, raw).catch(() => {
      // Allow a later identical write to retry rather than being deduped away.
      if (lastSynced.get(key) === raw) lastSynced.delete(key);
    });
  }, 600));
}
