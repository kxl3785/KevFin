import { useState, useEffect, useRef } from 'react';
import { syncSetting } from '../lib/settingsSync.ts';

// Fired on every persisted write so other hooks/components watching the same key
// in this tab update live (the native `storage` event only fires across tabs).
const PERSIST_EVENT = 'kevfin:persist';

interface PersistDetail { key: string; raw: string }

// Write a value to localStorage and notify every usePersistentState hook bound to
// the same key — in this tab (via PERSIST_EVENT) and others (via `storage`). Lets
// a component push data into another component's persisted state without a shared
// store: e.g. the document importer populating the Forecast page's settings.
export function writePersistent<T>(key: string, value: T) {
  let raw: string;
  try { raw = JSON.stringify(value); } catch { return; }
  try { localStorage.setItem(key, raw); } catch { /* ignore quota errors */ }
  window.dispatchEvent(new CustomEvent<PersistDetail>(PERSIST_EVENT, { detail: { key, raw } }));
  syncSetting(key, value); // mirror to the server so it follows the user across devices
}

// useState that persists to localStorage under `key` and stays in sync with any
// other hook/component bound to the same key (this tab and across tabs).
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

  // Persist on change, broadcasting to anything else watching this key.
  useEffect(() => {
    let raw: string;
    try { raw = JSON.stringify(value); } catch { return; }
    if (raw === serialized.current) return;
    serialized.current = raw;
    try { localStorage.setItem(key, raw); } catch { /* ignore quota / serialization errors */ }
    window.dispatchEvent(new CustomEvent<PersistDetail>(PERSIST_EVENT, { detail: { key, raw } }));
    syncSetting(key, value); // mirror to the server so it follows the user across devices
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

  return [value, setValue] as const;
}
