import { useState, useEffect, useRef } from 'react';

// Fired on every persisted write so other hooks/components watching the same key
// in this tab update live (the native `storage` event only fires across tabs).
const PERSIST_EVENT = 'kevfin:persist';

interface PersistDetail { key: string; raw: string }

// --- Server-backed source of truth ------------------------------------------
// Preferences live in the DB on the server (see server/src/services/prefs.ts) so
// the same settings appear on every browser, device, and hostname that reaches
// it — the LAN name and the Tailscale MagicDNS name are different browser
// origins with separate localStorage, but they share one server. localStorage is
// kept as an instant, offline cache; the server is authoritative.

// Loaded once per page load and shared by every hook (one GET, not one per key).
// The resolved object IS `prefsCache`, so later writes that update the cache are
// visible to hooks that mount after the initial load.
let prefsCache: Record<string, string> | null = null;
let prefsPromise: Promise<Record<string, string>> | null = null;

function loadServerPrefs(): Promise<Record<string, string>> {
  if (!prefsPromise) {
    prefsPromise = fetch('/api/prefs')
      .then(r => (r.ok ? r.json() : {}))
      .catch(() => ({}))
      .then((obj: Record<string, string>) => { prefsCache = obj && typeof obj === 'object' ? obj : {}; return prefsCache; });
  }
  return prefsPromise;
}

// Debounced per-key PUT. Keeps the shared cache fresh immediately so a hook that
// mounts later (e.g. navigating to another page) doesn't hydrate a stale value.
const writeTimers: Record<string, ReturnType<typeof setTimeout>> = {};
function queueServerWrite(key: string, raw: string) {
  if (prefsCache) prefsCache[key] = raw;
  clearTimeout(writeTimers[key]);
  writeTimers[key] = setTimeout(() => {
    fetch(`/api/prefs/${encodeURIComponent(key)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: raw }),
    }).catch(() => { /* offline / server down: localStorage still holds it */ });
  }, 400);
}

// Write a value to localStorage, the server, and every usePersistentState hook
// bound to the same key — in this tab (via PERSIST_EVENT) and others (via
// `storage`). Lets a component push data into another component's persisted
// state without a shared store: e.g. the document importer populating the
// Forecast page's settings.
export function writePersistent<T>(key: string, value: T) {
  let raw: string;
  try { raw = JSON.stringify(value); } catch { return; }
  try { localStorage.setItem(key, raw); } catch { /* ignore quota errors */ }
  window.dispatchEvent(new CustomEvent<PersistDetail>(PERSIST_EVENT, { detail: { key, raw } }));
  queueServerWrite(key, raw);
}

// useState that persists to localStorage under `key`, hydrates from (and syncs
// to) the server as the source of truth, and stays in sync with any other
// hook/component bound to the same key (this tab and across tabs).
export function usePersistentState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw !== null ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });

  // The last JSON we wrote/adopted, so we can dedupe and avoid echo loops: an
  // incoming event whose payload equals this is one we already have.
  const serialized = useRef<string | undefined>(undefined);
  // Set once the user makes a real edit, so a slow server hydration can't clobber
  // it with the value the server held when the page loaded.
  const dirty = useRef(false);

  // Persist on change: localStorage (instant/offline) + broadcast + server.
  useEffect(() => {
    let raw: string;
    try { raw = JSON.stringify(value); } catch { return; }
    if (raw === serialized.current) return;
    // The very first run is the mount echo (writing our initial/local value back
    // out). Don't push that to the server before we've read what it holds, or
    // we'd overwrite the source of truth with a local default. Genuine edits
    // (every later run) do sync.
    const isMountEcho = serialized.current === undefined;
    serialized.current = raw;
    try { localStorage.setItem(key, raw); } catch { /* ignore quota / serialization errors */ }
    window.dispatchEvent(new CustomEvent<PersistDetail>(PERSIST_EVENT, { detail: { key, raw } }));
    if (!isMountEcho) { dirty.current = true; queueServerWrite(key, raw); }
  }, [key, value]);

  // Adopt external writes to the same key (other components this tab, or other tabs).
  useEffect(() => {
    function onPersist(e: Event) {
      const d = (e as CustomEvent<PersistDetail>).detail;
      if (!d || d.key !== key || d.raw === serialized.current) return;
      try { serialized.current = d.raw; setValue(JSON.parse(d.raw) as T); } catch { /* ignore */ }
    }
    function onStorage(e: StorageEvent) {
      if (e.key !== key || e.newValue == null || e.newValue === serialized.current) return;
      try { serialized.current = e.newValue; setValue(JSON.parse(e.newValue) as T); } catch { /* ignore */ }
    }
    window.addEventListener(PERSIST_EVENT, onPersist);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(PERSIST_EVENT, onPersist);
      window.removeEventListener('storage', onStorage);
    };
  }, [key]);

  // Hydrate from the server once (the source of truth). If the server has a value
  // for this key, adopt it; if it doesn't yet but we have a local one, migrate it
  // up so it becomes shared. A pending user edit (dirty) always wins.
  useEffect(() => {
    let cancelled = false;
    loadServerPrefs().then(prefs => {
      if (cancelled || dirty.current) return;
      const serverRaw = prefs[key];
      if (serverRaw != null && serverRaw !== serialized.current) {
        serialized.current = serverRaw;
        try { localStorage.setItem(key, serverRaw); } catch { /* ignore */ }
        try { setValue(JSON.parse(serverRaw) as T); } catch { /* ignore */ }
        window.dispatchEvent(new CustomEvent<PersistDetail>(PERSIST_EVENT, { detail: { key, raw: serverRaw } }));
      } else if (serverRaw == null && serialized.current != null && localStorage.getItem(key) != null) {
        // Server doesn't know this key yet but this browser has a stored value.
        // Seed it up ONLY if it's a real customization (differs from the default);
        // seeding a mere default could otherwise clobber a customization another
        // origin/browser hasn't uploaded yet.
        let initialRaw: string | undefined;
        try { initialRaw = JSON.stringify(initial); } catch { initialRaw = undefined; }
        if (serialized.current !== initialRaw) queueServerWrite(key, serialized.current);
      }
    });
    return () => { cancelled = true; };
  }, [key]);

  return [value, setValue] as const;
}
