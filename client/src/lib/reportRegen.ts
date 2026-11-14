import { useSyncExternalStore } from 'react';

// Rebuilding the quarterly report, shared between the two places that can start
// it: the report view's own Regenerate button, and an assistant action card
// after a fix was applied (the stored report is a cached page, so a correction
// only shows in it after a rebuild). One tiny store so both show the same
// progress, a second click joins the run already in flight, and the report view
// reloads its frame when either finishes.

export interface ReportRegenState {
  status: 'idle' | 'running' | 'error';
  version: number;       // bumped after each successful rebuild; the frame reloads on change
  error: string | null;
}

let state: ReportRegenState = { status: 'idle', version: 0, error: null };
const listeners = new Set<() => void>();
const set = (next: ReportRegenState) => { state = next; listeners.forEach(l => l()); };

let inflight: Promise<boolean> | null = null;

/** Rebuild the report on the server (can take a minute or two). Resolves true on success. */
export function regenerateReport(): Promise<boolean> {
  if (inflight) return inflight;
  set({ ...state, status: 'running', error: null });
  inflight = fetch('/api/report/quarterly/regenerate', { method: 'POST' })
    .then(async res => {
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `Request failed (HTTP ${res.status})`);
      }
      set({ status: 'idle', version: state.version + 1, error: null });
      return true;
    })
    .catch((e: unknown) => {
      set({ ...state, status: 'error', error: e instanceof Error ? e.message : 'The report could not be rebuilt.' });
      return false;
    })
    .finally(() => { inflight = null; });
  return inflight;
}

export function useReportRegen(): ReportRegenState {
  return useSyncExternalStore(
    cb => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    () => state,
  );
}
