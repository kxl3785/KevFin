// Parse a user-typed money/number string, tolerating commas, $ and spaces
// (e.g. "495,000" or "$495,000" → 495000). parseFloat alone stops at the comma,
// which silently truncates "495,000" to 495 (and "$1500" to NaN → 0).
// Returns null for blank/unparseable input so callers that must not save a
// phantom 0 (budget targets, property values) can bail out instead.
export function parseNumOrNull(s: string): number | null {
  const n = parseFloat(String(s).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? null : n;
}

// Same, but falls back to 0 — for fields where blank legitimately means zero.
export function parseNum(s: string): number {
  return parseNumOrNull(s) ?? 0;
}

// SQLite's datetime('now') is UTC "YYYY-MM-DD HH:MM:SS" with no zone marker, which
// `new Date()` would read as *local* time. Normalise it to an ISO UTC string; leave
// anything else (ISO with Z/offset, date-only) untouched.
export function sqliteUtcToIso(s: string): string {
  return /^\d{4}-\d\d-\d\d \d\d:\d\d(:\d\d)?$/.test(s) ? s.replace(' ', 'T') + 'Z' : s;
}
