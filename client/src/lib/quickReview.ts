// Pure pieces of Quick review's merchant card (ReviewWizard): what one category
// tap sends to the server, and which key presses count as shortcuts.
import { isEmptySpec, type RuleSpec } from './ruleConditions.ts';
import type { RuleBuilderStatus } from '../hooks/useRuleBuilder.ts';

export interface ReviewApplyBody {
  ids: string[];          // the charges listed on the card — these always get the category
  category: string;
  merchant: string;       // the cluster's representative merchant key
  rule: RuleSpec | 'payee' | null; // ticked conditions; 'payee' = the default payee rule; null = no rule
}

// One tap = one request (POST /api/budget/review/apply). While the card's
// conditions are still loading, or failed to load, the tap falls back to the
// payee rule, which is what the chips would have started with. Once they have
// loaded, exactly what is ticked is applied: nothing ticked means no rule, only
// the listed charges.
export function reviewApplyBody(
  group: { merchant: string; txns: { id: string }[] },
  category: string,
  rule: { status: RuleBuilderStatus; spec: RuleSpec },
): ReviewApplyBody {
  return {
    ids: group.txns.map(t => t.id),
    category,
    merchant: group.merchant,
    rule: rule.status === 'ready' ? (isEmptySpec(rule.spec) ? null : rule.spec) : 'payee',
  };
}

// The amount a rule's "exact amount" condition should offer: the one that repeats
// most among the charges (a subscription's price), the most recent on a tie.
// Charges are most-recent first.
export function typicalAmount(txns: readonly { amount: number }[]): number {
  const seen = new Map<string, { amount: number; n: number }>();
  for (const t of txns) {
    const k = Math.abs(t.amount).toFixed(2);
    const e = seen.get(k);
    if (e) e.n++; else seen.set(k, { amount: t.amount, n: 1 });
  }
  let best: { amount: number; n: number } | null = null;
  for (const e of seen.values()) if (!best || e.n > best.n) best = e; // Map keeps first-seen (most recent) order
  return best?.amount ?? 0;
}

export type ReviewShortcut = { pick: number } | 'skip' | null;
interface KeyLike { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; defaultPrevented?: boolean; target?: unknown }
interface TargetLike { tagName?: string; isContentEditable?: boolean; closest?: (sel: string) => unknown }

// Focus is somewhere that takes typing (or inside the category picker's popover).
export function isTypingTarget(target: unknown): boolean {
  const t = target as TargetLike | null | undefined;
  if (!t || typeof t !== 'object') return false;
  const tag = (t.tagName ?? '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) return true;
  return typeof t.closest === 'function' && !!t.closest('[data-cat-popover]');
}

// Number keys 1..choices pick that suggested category; S skips. Nothing fires while
// a request is in flight, while something sits on top of the card (the category
// picker, a transaction's details), while typing, or with a modifier held.
export function reviewShortcut(e: KeyLike, state: { busy: boolean; blocked: boolean; choices: number }): ReviewShortcut {
  if (state.busy || state.blocked || e.defaultPrevented) return null;
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (isTypingTarget(e.target)) return null;
  if (e.key === 's' || e.key === 'S') return 'skip';
  if (/^[1-9]$/.test(e.key)) {
    const n = Number(e.key);
    return n <= Math.min(state.choices, 6) ? { pick: n - 1 } : null;
  }
  return null;
}
