// Pure helpers behind the dashboard's summary cards: how net worth moved over the
// last 30 days and year to date, the 90-day sparkline, how accounts split between
// investing / cash / other, and when a mortgage is scheduled to be paid off.
// Kept free of React so the date and money edges are covered by tests.

import type { Account, ManualAsset, Snapshot } from '@shared/apiTypes';

/** Which series the user has left switched on (the KPI cards toggle them). */
export interface Composition { accounts: boolean; realEstate: boolean }

/** A snapshot's net worth restricted to the switched-on series. */
export function composedValue(s: Snapshot, c: Composition): number {
  return (c.accounts ? s.accounts_total : 0) + (c.realEstate ? s.real_estate_total : 0);
}

/** Snapshots oldest-first (the API returns newest-first). */
export function ascending(history: Snapshot[]): Snapshot[] {
  return [...history].sort((a, b) => a.date.localeCompare(b.date));
}

/** "YYYY-MM-DD" shifted back `days` calendar days. Done in UTC so DST can't skew it. */
export function isoDaysBefore(iso: string, days: number): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d - days));
  return t.toISOString().slice(0, 10);
}

/**
 * The snapshot in effect on `iso`: the last one dated on or before it. Null when
 * history starts after that day, so a change is never measured from a made-up base.
 */
export function snapshotOnOrBefore(asc: Snapshot[], iso: string): Snapshot | null {
  let found: Snapshot | null = null;
  for (const s of asc) {
    if (s.date.slice(0, 10) <= iso) found = s;
    else break;
  }
  return found;
}

export interface Change {
  amount: number;
  /** Fraction (0.08 = 8%). Null when the starting value is zero or negative, where a percentage means nothing. */
  pct: number | null;
}

function changeFrom(asc: Snapshot[], fromIso: string, c: Composition): Change | null {
  const latest = asc[asc.length - 1];
  const base = snapshotOnOrBefore(asc, fromIso);
  if (!latest || !base || base === latest) return null;
  const start = composedValue(base, c);
  const amount = composedValue(latest, c) - start;
  return { amount, pct: start > 0 ? amount / start : null };
}

/**
 * The hero card's two changes, measured from the latest snapshot: against the
 * value 30 days earlier, and against the last value of the previous year (so
 * YTD includes January 1st's own move). Either is null when history doesn't
 * reach back that far.
 */
export function headlineChanges(history: Snapshot[], c: Composition): { d30: Change | null; ytd: Change | null } {
  const asc = ascending(history);
  const latest = asc[asc.length - 1];
  if (!latest) return { d30: null, ytd: null };
  const year = Number(latest.date.slice(0, 4));
  return {
    d30: changeFrom(asc, isoDaysBefore(latest.date, 30), c),
    ytd: changeFrom(asc, `${year - 1}-12-31`, c),
  };
}

/** Values for the hero sparkline: every snapshot in the last `days` days, oldest first. */
export function sparkValues(history: Snapshot[], c: Composition, days = 90): number[] {
  const asc = ascending(history);
  const latest = asc[asc.length - 1];
  if (!latest) return [];
  const from = isoDaysBefore(latest.date, days);
  return asc.filter(s => s.date.slice(0, 10) >= from).map(s => composedValue(s, c));
}

export type MixKey = 'investing' | 'cash' | 'other';
export interface MixSlice { key: MixKey; label: string; value: number; share: number }

const MIX: { key: MixKey; label: string; categories: string[] }[] = [
  { key: 'investing', label: 'Investing', categories: ['brokerage'] },
  { key: 'cash', label: 'Cash', categories: ['banking'] },
  { key: 'other', label: 'Other', categories: ['other'] },
];

/**
 * How the positive side of "Accounts & assets" splits up. Hidden accounts are
 * left out (they're out of net worth too); credit cards are debt, so they're
 * left out of the bar rather than shrinking a slice. Empty slices are dropped.
 */
export function accountMix(accounts: Account[], manualAssets: ManualAsset[]): MixSlice[] {
  const items = [
    ...accounts.filter(a => !a.hidden).map(a => ({ category: a.category as string, value: a.balance })),
    ...manualAssets.map(m => ({ category: m.category as string, value: m.value })),
  ];
  const slices = MIX.map(m => ({
    key: m.key,
    label: m.label,
    value: items.filter(i => m.categories.includes(i.category)).reduce((s, i) => s + i.value, 0),
  })).filter(s => s.value > 0);
  const total = slices.reduce((s, x) => s + x.value, 0);
  return slices.map(s => ({ ...s, share: total > 0 ? s.value / total : 0 }));
}

/** "YYYY-MM" of the final scheduled payment, or null without usable loan terms. */
export function payoffMonth(startISO: string | null, termYears: number | null): string | null {
  if (!startISO) return null;
  const m = /^(\d{4})-(\d{2})/.exec(startISO);
  if (!m) return null;
  const months = Math.round((termYears ?? 30) * 12);
  if (months <= 0) return null;
  // The first payment is due the month after the loan starts, so the last one
  // lands `months` months after the start month.
  const idx = Number(m[1]) * 12 + (Number(m[2]) - 1) + months;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}
