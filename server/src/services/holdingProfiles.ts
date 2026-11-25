import { getAllPrefs, setPref } from './prefs.js';

// The user's own description of what a dataless holding tracks. Some holdings
// have no public ticker or data at all: 401(k) collective trust funds, 529
// portfolios, HSA plan funds. The built-in rules in prices.ts (PROXY_RULES,
// SYMBOL_SUBSTITUTIONS) can only guess a stand-in; here the user says what the
// plan's fact sheet says instead — one ticker ("VFFVX") or a mix ("VTI 60,
// BND 40"). Whatever is stored here wins over those rules.
//
// Stored as one pref (JSON { [holdingId]: MixPart[] }), keyed by the same
// holdingId as the other per-holding overrides (classification, cost basis,
// expense ratio).

// weight is a FRACTION of the holding (0.6 = 60%); a mix's weights sum to 1.
export interface MixPart { ticker: string; weight: number }

export const PROFILES_PREF = 'mon.holdingProfiles';

export const MAX_PARTS = 10;
const TICKER = /^[A-Z0-9][A-Z0-9.\-^=]{0,14}$/;
// How far the weights may sum from 1 before we refuse rather than rescale:
// enough for rounded fact-sheet figures (33.3 / 33.3 / 33.4), not for a typo.
const SUM_SLACK = 0.005;

// Same rule as allocation.ts holdingId(): the display symbol, or the name when
// the holding carries no ticker. Duplicated rather than imported because
// prices.ts reads profiles, and allocation.ts imports prices.ts — importing
// allocation.ts from here would create a cycle. Keep the two in step.
export function profileKey(symbol: string, name: string): string {
  return symbol && symbol.trim() ? symbol.trim() : (name ?? '').trim();
}

// Validate a mix (from the route or from the stored pref). Tickers are
// upper-cased; weights are rescaled to sum to exactly 1 once they're known to
// be within SUM_SLACK of it.
export function validateMix(raw: unknown): { mix: MixPart[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: 'mix must be a list of { ticker, weight }' };
  if (raw.length < 1) return { error: 'mix needs at least one ticker' };
  if (raw.length > MAX_PARTS) return { error: `mix can list at most ${MAX_PARTS} tickers` };
  const parts: MixPart[] = [];
  const seen = new Set<string>();
  for (const p of raw) {
    if (!p || typeof p !== 'object') return { error: 'mix must be a list of { ticker, weight }' };
    const { ticker: t, weight: w } = p as { ticker?: unknown; weight?: unknown };
    const ticker = typeof t === 'string' ? t.trim().toUpperCase() : '';
    if (!TICKER.test(ticker)) return { error: `invalid ticker: ${typeof t === 'string' ? t.slice(0, 20) : String(t)}` };
    if (seen.has(ticker)) return { error: `${ticker} is listed twice` };
    seen.add(ticker);
    if (typeof w !== 'number' || !Number.isFinite(w) || w <= 0) return { error: `weight for ${ticker} must be a number above 0` };
    parts.push({ ticker, weight: w });
  }
  const sum = parts.reduce((s, p) => s + p.weight, 0);
  if (Math.abs(sum - 1) > SUM_SLACK) return { error: `weights must add up to 1 (100%), not ${Number(sum.toFixed(4))}` };
  return { mix: parts.map(p => ({ ticker: p.ticker, weight: p.weight / sum })) };
}

// Short-lived read cache. effectiveChain() runs in hot loops (performance.ts
// asks it per holding per date), and each read is a prefs scan plus a JSON
// parse. One second is long enough to cover a single request and short enough
// that a change made any other way (the generic prefs route, a restore) shows
// up straight away; setHoldingProfile() clears it outright.
const CACHE_MS = 1000;
let cached: { at: number; map: Map<string, MixPart[]> } | null = null;

// Every stored profile, keyed by holdingId. Tolerant: unreadable JSON gives an
// empty map, and any entry that fails validation (hand-edited, older format) is
// skipped rather than failing the rest.
export function getHoldingProfiles(): Map<string, MixPart[]> {
  // Never open the default (real) database from a test: a test that reaches
  // effectiveChain() without setting DB_PATH simply sees no profiles.
  if (process.env.VITEST && !process.env.DB_PATH) return new Map();
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) return cached.map;
  const map = new Map<string, MixPart[]>();
  const raw = getAllPrefs()[PROFILES_PREF];
  let v: unknown = null;
  if (raw) { try { v = JSON.parse(raw); } catch { v = null; } }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [id, mix] of Object.entries(v as Record<string, unknown>)) {
      if (!id.trim()) continue;
      const ok = validateMix(mix);
      if ('mix' in ok) map.set(id, ok.mix);
    }
  }
  cached = { at: now, map };
  return map;
}

export function getHoldingProfile(symbol: string, name: string): MixPart[] | null {
  const id = profileKey(symbol, name);
  if (!id) return null;
  return getHoldingProfiles().get(id) ?? null;
}

// Validate the PUT /api/allocation/holding-profile body: { id, mix }, where mix
// is a list of { ticker, weight } with weight a FRACTION, or null/undefined to
// clear the user's description.
export function parseProfileBody(body: unknown):
  { id: string; mix: MixPart[] | null } | { error: string } {
  const b = (body && typeof body === 'object' ? body : {}) as { id?: unknown; mix?: unknown };
  const id = typeof b.id === 'string' ? b.id.trim() : '';
  if (!id || id.length > 200) return { error: 'id required' };
  if (b.mix === null || b.mix === undefined) return { id, mix: null };
  const ok = validateMix(b.mix);
  if ('error' in ok) return { error: ok.error };
  return { id, mix: ok.mix };
}

// Store (or, with null, remove) one holding's description.
export function setHoldingProfile(id: string, mix: MixPart[] | null): void {
  cached = null;
  const all: Record<string, MixPart[]> = Object.fromEntries(getHoldingProfiles());
  if (mix == null) delete all[id];
  else all[id] = mix;
  setPref(PROFILES_PREF, JSON.stringify(all));
  cached = null;
}

// The part a single-ticker consumer (price history, metadata) should follow:
// the heaviest, with ties going to the first listed.
export function primaryTicker(mix: MixPart[]): string {
  let best = mix[0];
  for (const p of mix) if (p.weight > best.weight) best = p;
  return best?.ticker ?? '';
}
