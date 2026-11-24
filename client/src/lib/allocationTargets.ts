// Custom allocation targets and the rebalancing tolerance band.
//
// The Allocation page can compare the current mix against one of the risk
// profiles' model portfolios (riskProfiles.ts) or against the user's own target
// per asset class. Both live in prefs: the chosen profile under
// `mon.riskProfile` (unchanged), and this module's settings under
// `mon.allocTargets`. With the defaults (mode 'profile'), the page behaves
// exactly as it did before custom targets existed.
//
// Percentages are kept to one decimal place and summed in whole tenths, so
// "33.3 + 33.3 + 33.4" is exactly 100 rather than 99.99999999999999.

import { ASSET_CLASS_META, type AssetClassKey, type RiskProfile } from './riskProfiles.ts';

export type TargetMode = 'profile' | 'custom';

export interface AllocTargetsPref {
  mode: TargetMode;
  // Target percent per asset class (0..100, at most one decimal). Missing = 0.
  custom: Partial<Record<AssetClassKey, number>>;
  // Tolerance band, in percentage points either side of each target.
  band: number;
}

export const TARGETS_PREF_KEY = 'mon.allocTargets';
export const DEFAULT_BAND = 5;
export const MAX_BAND = 25;
export const BAND_CHOICES = [1, 2, 3, 5, 10, 15, 20];

export const DEFAULT_TARGETS_PREF: AllocTargetsPref = { mode: 'profile', custom: {}, band: DEFAULT_BAND };

const CLASS_KEYS = ASSET_CLASS_META.map(m => m.key);

// Round to one decimal place via whole tenths.
const tenths = (n: number) => Math.round(n * 10);

// Coerce whatever is stored (hand-edited, older shape, partial) into a valid
// setting. Unknown classes, non-numbers and out-of-range values are dropped; a
// bad band falls back to the default; an unknown mode falls back to 'profile'.
export function normalizeTargetsPref(raw: unknown): AllocTargetsPref {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const mode: TargetMode = o.mode === 'custom' ? 'custom' : 'profile';
  const custom: Partial<Record<AssetClassKey, number>> = {};
  const c = o.custom && typeof o.custom === 'object' && !Array.isArray(o.custom) ? o.custom as Record<string, unknown> : {};
  for (const k of CLASS_KEYS) {
    const v = c[k];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 100) custom[k] = tenths(v) / 10;
  }
  const b = o.band;
  const band = typeof b === 'number' && Number.isFinite(b) && b >= 0 && b <= MAX_BAND ? b : DEFAULT_BAND;
  return { mode, custom, band };
}

// Sum of the custom targets, in percent, to one decimal place.
export function customTotal(custom: Partial<Record<string, number>>): number {
  let t = 0;
  for (const k of CLASS_KEYS) {
    const v = custom[k];
    if (typeof v === 'number' && Number.isFinite(v)) t += tenths(v);
  }
  return t / 10;
}

// Savable only when the targets add up to exactly 100%.
export function isCompleteTargets(custom: Partial<Record<string, number>>): boolean {
  return Math.round(customTotal(custom) * 10) === 1000;
}

// The custom targets as a full model record (every class present, missing = 0),
// or null when they don't add up to 100 — so a broken setting can never be
// drawn as if it were a real target.
export function customModel(custom: Partial<Record<string, number>>): Record<AssetClassKey, number> | null {
  if (!isCompleteTargets(custom)) return null;
  const out = {} as Record<AssetClassKey, number>;
  for (const k of CLASS_KEYS) {
    const v = custom[k];
    out[k] = typeof v === 'number' && Number.isFinite(v) && v > 0 ? tenths(v) / 10 : 0;
  }
  return out;
}

// Parse one typed target ("40", "12.5", "", "40%"). Blank means 0. Trailing
// zeros after the point don't count as decimals ("12.50", "40.00", "40."), so
// figures copied from a spreadsheet are accepted; "12.55" is still refused.
export function parseTargetInput(text: string): { value: number } | { error: string } {
  let t = text.trim().replace(/%$/, '').trim();
  if (/^\d*\.\d*$/.test(t) && /\d/.test(t)) t = t.replace(/0+$/, '').replace(/\.$/, '');
  if (t === '') return { value: 0 };
  if (!/^\d{1,3}(\.\d)?$|^\.\d$/.test(t)) {
    return /^\d*\.\d{2,}$/.test(t) ? { error: 'Use at most one decimal place.' } : { error: 'Enter a number from 0 to 100.' };
  }
  const v = Number(t);
  if (!Number.isFinite(v) || v > 100) return { error: 'Enter a number from 0 to 100.' };
  return { value: tenths(v) / 10 };
}

// "1.5 points left to assign" / "2 points over" / "Adds up to 100%".
export function totalMessage(total: number): { text: string; complete: boolean } {
  const diff = Math.round((100 - total) * 10) / 10;
  if (diff === 0) return { text: 'Adds up to 100%', complete: true };
  const n = Math.abs(diff);
  const unit = n === 1 ? 'point' : 'points';
  return diff > 0
    ? { text: `${n} ${unit} left to assign`, complete: false }
    : { text: `${n} ${unit} over 100%`, complete: false };
}

// The targets in use: the user's own when they chose them and they add up to
// 100%, otherwise the risk profile's model (null when neither is set). With the
// default settings this is exactly the risk profile's model, as before custom
// targets existed.
export function effectiveTargets(pref: AllocTargetsPref, riskProfile: RiskProfile | null | undefined): {
  model: Record<AssetClassKey, number> | null;
  source: 'custom' | 'profile' | null;
} {
  const custom = pref.mode === 'custom' ? customModel(pref.custom) : null;
  if (custom) return { model: custom, source: 'custom' };
  if (riskProfile) return { model: riskProfile.model, source: 'profile' };
  return { model: null, source: null };
}

// Wording for the Asset allocation chart's dashed bar and drift labels. A risk
// profile is a model portfolio ("Model (38%)", "12 pts below model"), exactly as
// before custom targets existed; the user's own targets are called targets
// ("Target (50%)", "12 pts below target") so the chart agrees with the worksheet.
export function targetWording(source: 'custom' | 'profile' | null): {
  bar: string; noun: string; footnoteLead: string;
} {
  return source === 'custom'
    ? { bar: 'Target', noun: 'target', footnoteLead: 'Targets compare' }
    : { bar: 'Model', noun: 'model', footnoteLead: 'Model compares' };
}

// Swap the trailing "model" in a drift label from allocationDrift's driftLabel
// ("3 pts above model") for the noun in use.
export function withTargetNoun(driftText: string, noun: string): string {
  return driftText.replace(/\bmodel$/, noun);
}
