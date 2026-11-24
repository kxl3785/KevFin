// Display helpers for the contribution-aware returns panel. Pure, so the
// headline choice (period vs per-year) and the override bookkeeping are tested
// without rendering anything.

import { MINUS } from '../../lib/format.ts';

// `days`, when given, is the span this figure itself covers (an account that
// started empty counts from its first deposit); it labels the figure instead
// of the caller's span.
export interface Measure { periodReturn: number | null; annualized: number | null; days?: number }

const finite = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n);

/** "+10.9%", "−3.2%", "0.0%"; null for anything not a finite number. */
export function fmtPct(n: number | null | undefined): string | null {
  if (!finite(n)) return null;
  const v = n * 100;
  const body = Math.abs(v).toFixed(1);
  if (body === '0.0') return '0.0%';
  return `${v < 0 ? MINUS : '+'}${body}%`;
}

/** Plain words for how long a span is: "over 12 days", "over 6 months", "over 2.5 years". */
export function spanLabel(days: number): string {
  if (!finite(days) || days <= 0) return '';
  if (days < 60) return `over ${days} day${days === 1 ? '' : 's'}`;
  if (days <= 366) {
    const months = Math.max(2, Math.round(days / 30.44));
    return `over ${months} months`;
  }
  const years = Math.round((days / 365.25) * 10) / 10;
  return `over ${years % 1 === 0 ? years.toFixed(0) : years.toFixed(1)} years`;
}

/**
 * The number to headline: spans over a year show the per-year rate (with the
 * span's total underneath); a year or less shows the total for the span, since
 * stretching a few months to a yearly rate would extrapolate noise.
 */
export function headline(m: Measure | null | undefined, spanDays: number): { value: number | null; label: string; total: number | null } {
  if (!m) return { value: null, label: '', total: null };
  const days = finite(m.days) && m.days > 0 ? m.days : spanDays;
  if (days > 365 && finite(m.annualized)) return { value: m.annualized, label: 'a year', total: finite(m.periodReturn) ? m.periodReturn : null };
  return { value: finite(m.periodReturn) ? m.periodReturn : null, label: spanLabel(days), total: null };
}

/**
 * True when the dates actually measured fall well short of the period picked
 * (16 days of history with "1Y" selected, say). The card then says so once,
 * beside the period buttons, instead of repeating "over 16 days" on each tile.
 */
export function isShortSpan(measuredDays: number, pickedDays: number): boolean {
  return finite(measuredDays) && finite(pickedDays) && measuredDays > 0 && measuredDays < pickedDays * 0.8;
}

export type FlowOverride = 'include' | 'exclude';

/** Next overrides map after a switch: excluding stores 'exclude'; including returns to the default (key removed). */
export function nextOverrides(current: Record<string, FlowOverride>, id: string, include: boolean): Record<string, FlowOverride> {
  const next = { ...current };
  if (include) delete next[id];
  else next[id] = 'exclude';
  return next;
}

/**
 * The overrides to keep after a save failed: back to `previous` (what the
 * server still holds, so the switches match the figures again) — unless a
 * newer toggle has replaced `attempted` since, which then carries this change
 * along with it and must not be undone.
 */
export function afterFailedSave(
  current: Record<string, FlowOverride>,
  attempted: Record<string, FlowOverride>,
  previous: Record<string, FlowOverride>,
): Record<string, FlowOverride> {
  return current === attempted ? previous : current;
}

/** Privacy mode: hide every percentage in a sentence ("+28.7%" → "••%"), keeping names and dates. */
export function maskPercents(text: string): string {
  return text.replace(/[+\u2212-]?\d+(?:[.,]\d+)?\s?%/g, '••%');
}

/** "Nov 2025" from "2025-11". */
export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  if (!finite(y) || !finite(m)) return month;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}
