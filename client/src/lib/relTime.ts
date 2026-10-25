import { sqliteUtcToIso } from './parseNum.ts';

// "just now" / "5m ago" / "3h ago" / "yesterday" / "4d ago" for a stored timestamp.
// `updated_at` columns are SQLite datetime('now'): UTC with no zone marker, which
// Date would otherwise read as local time (hours off) — normalise it to explicit
// UTC first. Mirrors the "Last synced" text in Setup.
export function relTime(iso: string | null, now: number = Date.now()): string {
  if (!iso) return 'never';
  const norm = sqliteUtcToIso(iso);
  const t = new Date(norm.includes('T') || norm.includes(' ') ? norm : norm + 'T00:00:00').getTime();
  if (isNaN(t)) return iso;
  const mins = Math.round((now - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return days === 1 ? 'yesterday' : `${days}d ago`;
}

// The most recent of a list of timestamps (SQLite or ISO), as the original string,
// or null when none parse.
export function newestTimestamp(stamps: string[]): string | null {
  let best: string | null = null;
  let bestT = -Infinity;
  for (const s of stamps) {
    const norm = sqliteUtcToIso(s);
    const t = new Date(norm.includes('T') || norm.includes(' ') ? norm : norm + 'T00:00:00').getTime();
    if (!isNaN(t) && t > bestT) { bestT = t; best = s; }
  }
  return best;
}
