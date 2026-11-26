// Pure helpers behind the Investments page (pages/Allocation.tsx and
// components/allocation/*): which positions count as invested money, the
// headline figures at the top of the page, the wording of the allocation
// card's drift pills and "what to move" line, the concentration callout, the
// Positions table's sort, and the saved card layout. Dependency-free so the
// rules are unit-tested (investments.test.ts); the components only format.

import type { RebalanceResult, RebalanceRow } from './rebalance.ts';

// ---- Invested money vs other assets ---------------------------------------

// The slice of a position these helpers read (the page's HoldingRow has more).
export interface PositionLike {
  symbol: string;
  name: string;
  value: number;
  costBasis: number | null;
  costBasisCoveredValue: number;
  costBasisComplete: boolean;
  costBasisSource: string | null;
  assetClass: string;
  accounts: { name: string }[];
}

// A position is invested money when it sits in at least one brokerage or
// retirement account. Homes (equity) and manually tracked assets come back
// from the server with no accounts, so they are the "other assets".
export const isInvestment = (h: Pick<PositionLike, 'accounts'>) => h.accounts.length > 0;

export function splitPositions<T extends Pick<PositionLike, 'accounts'>>(rows: T[]): { invested: T[]; other: T[] } {
  const invested: T[] = [], other: T[] = [];
  for (const r of rows) (isInvestment(r) ? invested : other).push(r);
  return { invested, other };
}

// Invested total (the same base the server uses for the sector / country /
// stock shares) and how many distinct accounts hold it.
export function investedSummary(rows: Pick<PositionLike, 'value' | 'accounts'>[]): { total: number; accounts: number; positions: number } {
  const names = new Set<string>();
  let total = 0, positions = 0;
  for (const r of rows) {
    if (!isInvestment(r)) continue;
    positions++;
    total += Number.isFinite(r.value) ? r.value : 0;
    for (const a of r.accounts) names.add(a.name);
  }
  return { total, accounts: names.size, positions };
}

export interface GainSummary {
  gain: number | null;        // null when no position has a cost basis
  pct: number | null;         // gain ÷ cost; null when cost is 0
  cost: number;
  coveredValue: number;       // value of the positions (or lots) with a known basis
  allValue: number;
  withCost: number;           // positions with a cost basis
  count: number;              // positions considered
  anyEstimated: boolean;
  anyPartial: boolean;
}

// Unrealized gain over the positions that have a cost basis. Measured against
// the covered value, not the full value, so a PARTIAL basis (known for only
// some lots) isn't charged against the whole position (which would overstate
// the gain) — the same rule as each row's gain in the Positions table.
export function unrealizedGain(rows: Pick<PositionLike, 'value' | 'costBasis' | 'costBasisCoveredValue' | 'costBasisComplete' | 'costBasisSource'>[]): GainSummary {
  const basisRows = rows.filter(h => h.costBasis != null);
  const cost = basisRows.reduce((s, h) => s + (h.costBasis ?? 0), 0);
  const coveredValue = basisRows.reduce((s, h) => s + h.costBasisCoveredValue, 0);
  const gain = basisRows.length ? coveredValue - cost : null;
  return {
    gain,
    pct: gain != null && cost ? gain / cost : null,
    cost, coveredValue,
    allValue: rows.reduce((s, h) => s + h.value, 0),
    withCost: basisRows.length,
    count: rows.length,
    anyEstimated: basisRows.some(h => h.costBasisSource === 'estimated'),
    anyPartial: basisRows.some(h => !h.costBasisComplete),
  };
}

// ---- Allocation against targets --------------------------------------------

// The pill beside each bar: "+15 pts" / "−7 pts" when outside the band, "in
// band" otherwise. Whole points normally; a row just past the band edge would
// round to the edge ("5 pts" on a ±5 band, yet flagged outside), so it gets one
// decimal ("+5.2 pts"), and a drift too small even for that reads "just over".
export function driftPill(r: Pick<RebalanceRow, 'driftPts' | 'inBand'>, band: number): { text: string; out: boolean } {
  if (r.inBand) return { text: 'in band', out: false };
  const d = Number.isFinite(r.driftPts) ? r.driftPts : 0;
  const sign = d > 0 ? '+' : '−';
  const whole = Math.round(Math.abs(d));
  const one = Number(Math.abs(d).toFixed(1));
  const n = whole > band ? whole : one > band ? one : null;
  if (n == null) return { text: `just over ±${band}`, out: true };
  return { text: `${sign}${n} ${n === 1 ? 'pt' : 'pts'}`, out: true };
}

export interface OffTarget {
  out: number;                // kinds outside the band
  total: number;              // kinds compared
  worst: { key: string; driftPts: number } | null; // furthest outside, if any
}

// The "Off target" headline: how many kinds sit outside the band and which is
// furthest out. null when there is nothing to compare (no targets, or nothing
// invested in the targeted kinds).
export function offTarget(result: RebalanceResult | null): OffTarget | null {
  if (!result || !result.comparable) return null;
  const outRows = result.rows.filter(r => !r.inBand);
  const worst = outRows.reduce<RebalanceRow | null>((w, r) => (!w || Math.abs(r.driftPts) > Math.abs(w.driftPts) ? r : w), null);
  return { out: outRows.length, total: result.rows.length, worst: worst ? { key: worst.key, driftPts: worst.driftPts } : null };
}

// "15 pts over" / "7 pts under" for the worst kind on the headline tile.
export function driftWords(driftPts: number): string {
  const n = Math.round(Math.abs(driftPts));
  const pts = `${n} ${n === 1 ? 'pt' : 'pts'}`;
  return n === 0 ? 'just off target' : `${pts} ${driftPts > 0 ? 'over' : 'under'}`;
}

// Round an "about" amount so the sentence doesn't pretend to the dollar:
// nearest $100 from $1,000 up, nearest $10 below that.
export function roundAbout(n: number): number {
  const a = Math.abs(n);
  const step = a >= 1000 ? 100 : 10;
  return Math.round(a / step) * step;
}

// One line under the allocation bars saying what would bring the mix back to
// its targets, from the rebalance worksheet's own per-kind amounts (so the two
// always agree). Only kinds outside the band are named; whatever is left over
// goes to (or comes from) the kinds already in band. `money` is the page's
// formatter, so privacy masking applies; `labelOf` turns a class key into its
// display name ("U.S. stocks").
export function movesText(
  result: RebalanceResult,
  money: (n: number) => string,
  labelOf: (key: string) => string,
  band: number,
): string {
  if (!result.comparable) return 'Nothing is invested in these kinds yet, so there is nothing to compare.';
  const outRows = result.rows.filter(r => !r.inBand && r.delta !== 0);
  if (!outRows.length) {
    return `Every kind sits within ±${band} ${band === 1 ? 'point' : 'points'} of its target.`;
  }
  const list = (keys: string[]) => {
    const names = keys.map(k => labelOf(k));
    return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  };
  const trims = outRows.filter(r => r.delta < 0);
  const adds = outRows.filter(r => r.delta > 0);
  const out = trims.reduce((s, r) => s - r.delta, 0);
  const inn = adds.reduce((s, r) => s + r.delta, 0);
  const amt = (n: number) => money(roundAbout(n));
  if (trims.length && adds.length) {
    return out >= inn
      ? `To get back on target: move about ${amt(out)} out of ${list(trims.map(r => r.key))}, with ${amt(inn)} of it into ${list(adds.map(r => r.key))}.`
      : `To get back on target: move about ${amt(inn)} into ${list(adds.map(r => r.key))}, with ${amt(out)} of it from ${list(trims.map(r => r.key))}.`;
  }
  if (trims.length) return `To get back on target: move about ${amt(out)} out of ${list(trims.map(r => r.key))} into the other kinds.`;
  return `To get back on target: move about ${amt(inn)} into ${list(adds.map(r => r.key))} from the other kinds.`;
}

// ---- What you own ------------------------------------------------------------

// Pseudo-rows in the server's look-through lists: they hold real money but
// aren't members of the list they sit in (a bond fund isn't a stock or a
// country). The page lists them in a footnote instead of among the bars.
export const isPseudoStock = (symbol: string) => symbol.startsWith('— ');
// Sector buckets for the parts of a fund that aren't company shares.
export const NON_SECTOR = new Set(['Bonds', 'Cash / Other', 'Commodities / Alternatives', 'Crypto']);
export const isRealSector = (name: string) => !NON_SECTOR.has(name);

export interface Concentration {
  pct: number;                // share of invested money (0..1)
  symbols: string[];          // the top stocks, largest first
  viaFunds: number;           // share of their value that comes through funds (0..1)
}

// "Your top 3 stocks are 29.7% of everything invested": the largest real stocks
// (pseudo-rows left out) by value. A stock held directly lists itself as one of
// its sources, so everything else came in through funds.
export function topConcentration(
  stocks: { symbol: string; value: number; pct: number; sources: { label: string; value: number }[] }[],
  n = 3,
): Concentration | null {
  const top = stocks.filter(s => !isPseudoStock(s.symbol) && s.value > 0).sort((a, b) => b.value - a.value).slice(0, n);
  if (top.length < Math.min(n, 2)) return null;
  const value = top.reduce((s, x) => s + x.value, 0);
  const direct = top.reduce((s, x) => s + x.sources.filter(src => src.label === x.symbol).reduce((t, src) => t + src.value, 0), 0);
  return {
    pct: top.reduce((s, x) => s + x.pct, 0),
    symbols: top.map(x => x.symbol),
    viaFunds: value > 0 ? Math.max(0, Math.min(1, 1 - direct / value)) : 0,
  };
}

// ---- Positions table sort -----------------------------------------------------

export type PositionSortKey = 'name' | 'class' | 'value' | 'cost' | 'gain' | 'fee' | 'feeCost';
export interface PositionSort { key: PositionSortKey; dir: 'asc' | 'desc' }

// What each sortable column reads. Fee figures come from the fee check-up
// (looked up by the position's id); a missing figure is null and always sorts
// last, whichever way the column runs.
export function sortValue(
  h: Pick<PositionLike, 'symbol' | 'name' | 'value' | 'assetClass' | 'costBasis' | 'costBasisCoveredValue'>,
  key: PositionSortKey,
  fee?: { expenseRatio: number | null; annualCost: number | null } | null,
): number | string | null {
  switch (key) {
    case 'name': return (h.symbol || h.name).toLowerCase();
    case 'class': return h.assetClass.toLowerCase();
    case 'value': return h.value;
    case 'cost': return h.costBasis;
    case 'gain': return h.costBasis != null ? h.costBasisCoveredValue - h.costBasis : null;
    case 'fee': return fee?.expenseRatio ?? null;
    case 'feeCost': return fee?.annualCost ?? null;
  }
}

export function sortPositions<T extends Pick<PositionLike, 'symbol' | 'name' | 'value' | 'assetClass' | 'costBasis' | 'costBasisCoveredValue'>>(
  rows: T[],
  sort: PositionSort,
  feeOf: (h: T) => { expenseRatio: number | null; annualCost: number | null } | null | undefined = () => null,
): T[] {
  const mul = sort.dir === 'asc' ? 1 : -1;
  return rows
    .map((h, i) => ({ h, i, v: sortValue(h, sort.key, feeOf(h)) }))
    .sort((a, b) => {
      if (a.v == null || b.v == null) return a.v == null && b.v == null ? a.i - b.i : a.v == null ? 1 : -1;
      const c = typeof a.v === 'string' || typeof b.v === 'string'
        ? String(a.v).localeCompare(String(b.v))
        : (a.v as number) - (b.v as number);
      // Ties keep the server's order (largest first), so the sort is stable.
      return c !== 0 ? c * mul : a.i - b.i;
    })
    .map(x => x.h);
}

// Text columns start A→Z; number columns start largest first.
export const defaultSortDir = (key: PositionSortKey): 'asc' | 'desc' => (key === 'name' || key === 'class' ? 'asc' : 'desc');

// ---- Saved card layout ----------------------------------------------------------

export type CardWidth = 'half' | 'full';
export const INV_CARDS = ['assets', 'exposure', 'positions', 'location', 'bonds'] as const;
export const INV_DEFAULT_WIDTHS: Record<string, CardWidth> = { positions: 'full' };
// Cards the earlier page had, folded into one card here: the three exposure
// cards became the tabbed "What you own" card.
const RENAMED: Record<string, string> = { country: 'exposure', sector: 'exposure', stock: 'exposure' };

// Clean a saved card order (mon.allocOrder) for the cards that exist now. A
// layout saved by the earlier page names the old cards: those are renamed (the
// first of the three exposure cards takes their place), anything unknown or
// repeated is dropped, and a card the saved order lacks goes back where the
// default order has it (after the card it follows there), so no card is lost.
export function migrateOrder(saved: unknown): string[] {
  const known = new Set<string>(INV_CARDS);
  const out: string[] = [];
  for (const raw of Array.isArray(saved) ? saved : []) {
    if (typeof raw !== 'string') continue;
    const k = RENAMED[raw] ?? raw;
    if (known.has(k) && !out.includes(k)) out.push(k);
  }
  INV_CARDS.forEach((k, i) => {
    if (out.includes(k)) return;
    // Insert after the nearest earlier default card already placed; else first.
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const p = out.indexOf(INV_CARDS[j]);
      if (p >= 0) { at = p + 1; break; }
    }
    out.splice(at, 0, k);
  });
  return out;
}

// Clean saved card widths (mon.allocWidths): only known cards, only 'half' or
// 'full'. Old card names are dropped, so the merged card starts at its default.
export function migrateWidths(saved: unknown): Record<string, CardWidth> {
  const out: Record<string, CardWidth> = {};
  if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
    for (const [k, v] of Object.entries(saved as Record<string, unknown>)) {
      if ((INV_CARDS as readonly string[]).includes(k) && (v === 'half' || v === 'full')) out[k] = v;
    }
  }
  return out;
}

export const cardWidth = (widths: Record<string, CardWidth>, key: string): CardWidth =>
  widths[key] ?? INV_DEFAULT_WIDTHS[key] ?? 'half';

// A half-width card with nothing beside it (the next card is full width, or
// it's the last one) fills its row instead of leaving a blank half. Display
// only: the saved width is unchanged.
export function cardsFillingRow(keys: string[], isFull: (k: string) => boolean): Set<string> {
  const fills = new Set<string>();
  let waiting: string | null = null; // a half card that started a row
  for (const k of keys) {
    if (isFull(k)) { if (waiting) fills.add(waiting); waiting = null; }
    else waiting = waiting ? null : k;
  }
  if (waiting) fills.add(waiting);
  return fills;
}
