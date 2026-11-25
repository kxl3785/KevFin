// Parse a user-typed money/number string, tolerating commas, $ and spaces
// (e.g. "495,000" or "$495,000" → 495000). parseFloat alone stops at the comma,
// which silently truncates "495,000" to 495 (and "$1500" to NaN → 0).
// Returns null for blank/unparseable input so callers that must not save a
// phantom 0 (budget targets, property values) can bail out instead.
// A trailing k / m / b scales the number ("15k" → 15000, "$1.2M" → 1200000):
// stripping the letter instead would silently save $15 or $1.
const SUFFIX: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 };
export function parseNumOrNull(s: string): number | null {
  const t = String(s).trim().toLowerCase().replace(/[\s,$]/g, '');
  const suffix = /\d([kmb])$/.exec(t)?.[1];
  const n = parseFloat((suffix ? t.slice(0, -1) : t).replace(/[^0-9.\-]/g, ''));
  if (isNaN(n)) return null;
  // Round a scaled value to cents so "1.15m" is 1150000, not 1149999.9999999998.
  return suffix ? Math.round(n * SUFFIX[suffix] * 100) / 100 : n;
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
