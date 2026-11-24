// Read-only rebalancing worksheet maths for the Allocation page.
//
// Given what is held in each asset class, a set of target weights and a
// tolerance band, work out how far each class sits from its target and the
// dollar amount per class that would bring the mix back to target. A second
// mode splits a sum of new money across the classes so the mix moves toward
// the targets without selling anything.
//
// Everything here is amounts per asset class only — KevFin never places trades.
// All outputs are finite numbers (never NaN / Infinity), so the UI can render
// them directly.

export interface RebalanceRow {
  key: string;
  value: number;        // current dollars in the class (negatives/non-finite read as 0)
  actualPct: number;    // share of the worksheet total, in points (0..100)
  targetPct: number;    // target share, in points (0..100), renormalised to sum to 100
  driftPts: number;     // actualPct − targetPct: + = above target, − = below
  inBand: boolean;      // |driftPts| ≤ band (exactly at the edge counts as inside)
  delta: number;        // whole dollars to reach target: + = add, − = trim. Sums to exactly 0.
}

export interface RebalanceResult {
  total: number;        // sum of the (cleaned) class values
  rows: RebalanceRow[];
  // False when there is nothing to compare: no positive target, or nothing held.
  comparable: boolean;
  anyOutOfBand: boolean;
}

export interface NewMoneyRow {
  key: string;
  add: number;          // whole dollars of the new money going to this class (≥ 0)
  afterPct: number;     // share of (total + new money) after the split, in points
  targetPct: number;
}

export interface NewMoneyResult {
  amount: number;       // the new money, rounded to whole dollars (what the adds sum to)
  rows: NewMoneyRow[];
  // True when the new money is enough to bring every class exactly to target
  // (to within a dollar of rounding); false when it only moves part of the way.
  reachesTarget: boolean;
  // True when the money tops up every class that has a target to its share of
  // the targeted holdings plus the new money — i.e. it covers every shortfall.
  // This differs from reachesTarget only when something is held in a class with
  // no target (heldWithoutTarget): no amount can reach target then, because
  // that class would have to be sold.
  coversShortfalls: boolean;
  // Classes held (over 50 cents) whose target is 0%. The split never sells, so
  // these stay put and the other classes sit just under their targets.
  heldWithoutTarget: string[];
}

// Tolerance for float noise when comparing points against the band, so a class
// that is exactly 5.000 points off with a 5-point band counts as inside even if
// the division lands on 5.000000000001.
const EPS = 1e-9;

// Clean a dollar figure: anything non-finite or negative counts as 0. A class
// can only come out negative from odd feed data (short options, margin); a
// rebalance toward a target share of a negative holding has no sensible reading.
function clean(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

// Row order: the caller's order first (e.g. the canonical asset-class order),
// then any other class in either input, largest holding first, then by name so
// the order is stable.
function orderKeys(values: Record<string, number>, targets: Record<string, number>, order: string[]): string[] {
  const keys = new Set<string>();
  for (const k of Object.keys(values)) if (clean(values[k]) > 0) keys.add(k);
  for (const k of Object.keys(targets)) if (clean(targets[k]) > 0) keys.add(k);
  const first = order.filter(k => keys.has(k));
  const rest = [...keys].filter(k => !order.includes(k))
    .sort((a, b) => clean(values[b]) - clean(values[a]) || a.localeCompare(b));
  return [...first, ...rest];
}

// Target weights as fractions summing to 1 (or all 0 when no positive target).
// Targets are expected to sum to 100 already; renormalising keeps the maths
// honest if a hand-edited setting does not.
function weights(keys: string[], targets: Record<string, number>): number[] {
  const raw = keys.map(k => clean(targets[k]));
  const sum = raw.reduce((s, v) => s + v, 0);
  return raw.map(v => (sum > 0 ? v / sum : 0));
}

// Round each raw figure to whole dollars so the results add up to exactly
// `targetSum` (an integer). Largest-remainder method: floor everything, then
// hand the leftover dollars, one each, to the figures with the biggest
// fractional parts (ties go to the earlier row). Each result stays within a
// dollar of its raw figure.
export function roundToSum(raw: number[], targetSum: number): number[] {
  const floors = raw.map(v => Math.floor(v));
  const floorSum = floors.reduce((s, v) => s + v, 0);
  let need = Math.round(targetSum - floorSum);
  need = Math.max(0, Math.min(raw.length, need));
  const byRemainder = raw
    .map((v, i) => ({ i, r: v - floors[i] }))
    // Remainders within float noise of each other count as a tie (so 66.67 and
    // 33.33 split evenly read the same), and ties go to the earlier row.
    .sort((a, b) => (Math.abs(b.r - a.r) > 1e-9 ? b.r - a.r : a.i - b.i));
  const out = [...floors];
  for (let j = 0; j < need; j++) out[byRemainder[j].i] += 1;
  // Turn any −0 into 0 so the UI never shows "−$0".
  return out.map(v => (v === 0 ? 0 : v));
}

export function rebalance(
  values: Record<string, number>,
  targets: Record<string, number>,
  bandPts: number,
  order: string[] = [],
): RebalanceResult {
  const keys = orderKeys(values, targets, order);
  const vals = keys.map(k => clean(values[k]));
  const w = weights(keys, targets);
  const total = vals.reduce((s, v) => s + v, 0);
  const band = Number.isFinite(bandPts) && bandPts > 0 ? bandPts : 0;
  const hasTargets = w.some(x => x > 0);
  const comparable = hasTargets && total > 0;

  // Ideal move per class: its target share of today's total, less what it holds.
  // These sum to zero (Σ w·total − Σ value = total − total), so whole-dollar
  // rounding is done to a sum of exactly 0: every dollar trimmed somewhere is a
  // dollar added somewhere else.
  const raw = keys.map((_, i) => (comparable ? w[i] * total - vals[i] : 0));
  const deltas = roundToSum(raw, 0);

  const rows: RebalanceRow[] = keys.map((key, i) => {
    const actualPct = total > 0 ? (vals[i] / total) * 100 : 0;
    const targetPct = w[i] * 100;
    const driftPts = comparable ? actualPct - targetPct : 0;
    return {
      key, value: vals[i], actualPct, targetPct, driftPts,
      inBand: Math.abs(driftPts) <= band + EPS,
      delta: deltas[i],
    };
  });
  return { total, rows, comparable, anyOutOfBand: rows.some(r => !r.inBand) };
}

// Split `amount` of new money across the classes, adding only, so the mix moves
// as close to the targets as that money allows.
//
// "Water-filling": picture each class's holding as a fraction of its target
// weight, value / weight. The new money first goes to the class that is lowest
// on that measure, raising it until it draws level with the next-lowest, then to
// both together in proportion to their weights, and so on. In symbols, find the
// level L where Σ max(0, L·wᵢ − vᵢ) = amount, and give each class
// max(0, L·wᵢ − vᵢ). When the money covers every shortfall, L equals the new
// total and every class lands exactly on target, with anything left over spread
// by target weight; when it doesn't, the most-underweight classes are topped up
// first and no class above its target gets any. Classes with no target get none.
export function newMoneySplit(
  values: Record<string, number>,
  targets: Record<string, number>,
  amount: number,
  order: string[] = [],
): NewMoneyResult {
  const keys = orderKeys(values, targets, order);
  const vals = keys.map(k => clean(values[k]));
  const w = weights(keys, targets);
  const add = Math.round(clean(amount));
  const total = vals.reduce((s, v) => s + v, 0);
  const newTotal = total + add;

  let rawAdds = keys.map(() => 0);
  const targeted = keys.map((_, i) => i).filter(i => w[i] > 0);
  if (add > 0 && targeted.length) {
    // Visit targeted classes from most to least underweight (value / weight).
    const sorted = [...targeted].sort((a, b) => vals[a] / w[a] - vals[b] / w[b]);
    let sumV = 0, sumW = 0, level = 0;
    for (let k = 0; k < sorted.length; k++) {
      sumV += vals[sorted[k]];
      sumW += w[sorted[k]];
      level = (add + sumV) / sumW;
      const next = sorted[k + 1];
      // Stop once the level would not lift the next class off its own value.
      if (next === undefined || level <= vals[next] / w[next]) break;
    }
    rawAdds = keys.map((_, i) => (w[i] > 0 ? Math.max(0, level * w[i] - vals[i]) : 0));
  }
  const adds = add > 0 && targeted.length ? roundToSum(rawAdds, add) : rawAdds.map(() => 0);

  // Reaches target when, after the split, every class is within a dollar per
  // class of its target share of the new total (whole-dollar rounding aside).
  const reachesTarget = add > 0 && targeted.length > 0 &&
    keys.every((_, i) => Math.abs(vals[i] + adds[i] - w[i] * newTotal) <= 1);
  // Covers every shortfall when each targeted class ends within a dollar of its
  // share of the money that can move: the new total less what sits in classes
  // with no target (those are never sold, so they can't be part of the split).
  const untargetedHeld = keys.reduce((s, _, i) => (w[i] > 0 ? s : s + vals[i]), 0);
  const coversShortfalls = add > 0 && targeted.length > 0 &&
    targeted.every(i => Math.abs(vals[i] + adds[i] - w[i] * (newTotal - untargetedHeld)) <= 1);
  const heldWithoutTarget = keys.filter((_, i) => w[i] === 0 && vals[i] > 0.5);

  const rows: NewMoneyRow[] = keys.map((key, i) => ({
    key,
    add: adds[i],
    afterPct: newTotal > 0 ? ((vals[i] + adds[i]) / newTotal) * 100 : 0,
    targetPct: w[i] * 100,
  }));
  return { amount: targeted.length ? add : 0, rows, reachesTarget, coversShortfalls, heldWithoutTarget };
}

// ---- Worksheet display helpers -------------------------------------------
// Kept here (not in the component) so the wording rules can be unit-tested.

// The "now" share and the drift words for one row, e.g. "45.0%" and
// "5 points above". Normally one decimal. A row just past the band edge (say
// 5.04 points off a ±5 band) would read "5 points" yet be flagged outside the
// band, so those rows get two decimals ("5.04 points above", "45.04%"), and a
// drift too small even for that reads "just over 5 points above".
export function driftDisplay(
  r: Pick<RebalanceRow, 'actualPct' | 'driftPts' | 'inBand'>,
  band: number,
): { nowText: string; driftText: string } {
  const pct = (p: number, dp: number) => `${Number.isFinite(p) ? p.toFixed(dp) : (0).toFixed(dp)}%`;
  const pts = (n: number) => `${n} ${n === 1 ? 'point' : 'points'}`;
  const d = Number.isFinite(r.driftPts) ? r.driftPts : 0;
  const abs = Math.abs(d);
  const dir = d > 0 ? 'above' : 'below';
  if (r.inBand && abs < 0.05) return { nowText: pct(r.actualPct, 1), driftText: 'on target' };
  const one = Number(abs.toFixed(1));
  if (r.inBand || one > band) return { nowText: pct(r.actualPct, 1), driftText: `${pts(one)} ${dir}` };
  // Outside the band, but one decimal would read as inside it.
  const two = Number(abs.toFixed(2));
  return {
    nowText: pct(r.actualPct, 2),
    driftText: two > band ? `${pts(two)} ${dir}` : band > 0 ? `just over ${pts(band)} ${dir}` : `slightly ${dir}`,
  };
}

// A whole-dollar move as text: "+$5,000", "−$5,040", or "Under $1" when it
// rounds to nothing (a row can sit outside the band on a tiny total yet need
// less than a dollar). `money` is the page's formatter, so privacy masking applies.
export function deltaText(delta: number, money: (n: number) => string): string {
  if (!Number.isFinite(delta) || delta === 0) return `Under ${money(1)}`;
  return `${delta > 0 ? '+' : '−'}${money(Math.abs(delta))}`;
}

// The line under the new-money box describing the split. Three honest cases:
// the money lands every kind on target; it tops up every kind that has a target
// but something is held in a 0%-target class (the split never sells, so no
// amount reaches target and the others sit slightly under); or it isn't enough
// to top everything up, so the kinds furthest below come first.
export function newMoneyHelp(
  split: Pick<NewMoneyResult, 'amount' | 'reachesTarget' | 'coversShortfalls' | 'heldWithoutTarget'>,
  money: (n: number) => string,
  labelOf: (key: string) => string = k => k,
): string {
  const amt = money(split.amount);
  if (split.reachesTarget) return `How ${amt} would split so every kind lands on target, without selling anything.`;
  const held = split.heldWithoutTarget.map(labelOf);
  const names = held.length <= 1 ? held.join('') : `${held.slice(0, -1).join(', ')} and ${held[held.length - 1]}`;
  const zeroNote = held.length
    ? ` ${names} ${held.length === 1 ? 'has' : 'have'} a 0% target and this never sells, so the other kinds land slightly under their targets.`
    : '';
  if (split.coversShortfalls) {
    return `How ${amt} would split so every kind with a target is topped up evenly, without selling anything.${zeroNote}`;
  }
  return `How ${amt} would split to move toward the targets without selling anything. ` +
    (held.length
      ? `It isn't enough to top up every kind, so the kinds furthest below come first.${zeroNote}`
      : `It isn't enough to reach every target, so the kinds furthest below come first.`);
}

// Classes (in `order`, then any other) whose value nets below zero — e.g. a
// margin debit filed under Short Term. rebalance() counts these as $0, so the
// worksheet lists them in a note. Anything within 50 cents of zero is ignored.
export function negativeClasses(values: Record<string, number>, order: string[] = []): { key: string; value: number }[] {
  const keys = [...order.filter(k => k in values), ...Object.keys(values).filter(k => !order.includes(k)).sort()];
  return keys
    .filter(k => Number.isFinite(values[k]) && values[k] < -0.5)
    .map(k => ({ key: k, value: values[k] }));
}

// Parse the worksheet's "new money" box strictly: digits with optional comma
// grouping, optional cents and an optional leading "$". Anything else ("10k",
// "1e6", "1.2.3") is an error rather than a silent misread — the app-wide
// parseNumOrNull would strip the letters and read "10k" as $10. Blank → null
// (no new money).
export function parseNewMoney(text: string): { value: number } | { error: string } | null {
  const t = text.trim();
  if (t === '') return null;
  if (/^-/.test(t.replace(/^\$\s*/, ''))) return { error: 'Enter an amount of zero or more.' };
  const m = /^\$?\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d*)?|\.\d+)$/.exec(t);
  if (!m) return { error: 'Enter a dollar amount, like 10,000.' };
  const v = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(v) ? { value: v } : { error: 'Enter a dollar amount, like 10,000.' };
}
