import { getAllTransactions } from './simplefin.js';
import { getDb } from '../db/schema.js';
import { autoCategory, getCategoryLabeler } from './budget.js';

// Fixed/committed bills (vs. flexible spend) and inflows to skip, in the new
// taxonomy. Category resolution is reused from budget.ts so the two stay in sync.
const FIXED_CATEGORIES = new Set(['Mortgage', 'Rent', 'Gas & Electric', 'Water', 'Internet & Phone', 'Insurance']);
// Income and internal money movement never count as recurring spend. Mirrors
// budget.ts's EXCLUDED_CATEGORIES — a Credit Card Payment is moving money to pay a
// card, not a recurring bill, and counting it double-counts the card's own
// itemized purchases (which already surface per-merchant here).
const SKIP_CATEGORIES = new Set(['Paychecks', 'Other Income', 'Dividends & Capital Gains', 'Transfers', 'Credit Card Payment']);

// ── Flexible-recurring scope ─────────────────────────────────────────────────
// This page exists to surface *optimizable* recurring fees — subscriptions,
// memberships, recurring services and the like — not habitual day-to-day spend.
// Groceries, restaurants, coffee, gas and ride-share all bill steadily every
// month too, but cutting them isn't "cancel a subscription," so categories like
// those are deliberately out of scope. A merchant qualifies as flexible recurring
// only when its category is in this set OR its name is a known subscription
// (SUBSCRIPTION_RE), so a service mis-filed under, say, "Personal" still surfaces.
const FLEXIBLE_RECURRING_CATEGORIES = new Set([
  'Subscriptions', 'Fitness', 'Entertainment & Recreation',
  'Financial Fees', 'Auto Payment', 'Child Care', 'Charity',
]);

// Exported for unit testing (see recurring.test.ts). `category` is the canonical
// (un-renamed) category from autoCategory / a txn rule.
export function inFlexibleRecurringScope(payee: string, category: string): boolean {
  return FLEXIBLE_RECURRING_CATEGORIES.has(category) || SUBSCRIPTION_RE.test(payee);
}

// ── Subscription signal ──────────────────────────────────────────────────────
// Known subscription / membership payees. Presence here relaxes the rules:
// 2+ months + CV < 0.40 is enough (handles price changes, free-trial gaps, etc.)
const SUBSCRIPTION_RE = /netflix|spotify|hulu|disney\+?|youtube.*premium|prime.?video|amazon.*prime|apple\s*(one|music|tv\+?|arcade)|icloud|google.*(one|storage)|hbo|max\b|paramount\+?|showtime|peacock|fubo|sling|tidal|pandora|deezer|adobe|figma|canva|notion|slack|dropbox|1password|lastpass|github|anthropic|openai|chatgpt|cursor|duolingo|headspace|calm|\bgym\b|equinox|planet.?fitness|la.?fitness|24.?hour|anytime.?fitness|crunch.?fitness|orange.?theory|blink.?fitness|ymca|peloton|classpass|linkedin.*premium|nytimes|new.?york.?times|wsj|wall.?street.?journal|substack|patreon|audible|kindle.?unlimited/i;

// ── Retail exclusion ─────────────────────────────────────────────────────────
// Retail / marketplace merchants that people also shop at irregularly. Cleared
// only if the charge is identically billed every month (CV < 0.08, fill ≥ 0.80,
// 4+ months) — the evidence bar for "this is a membership fee, not shopping."
// SUBSCRIPTION_RE is checked first, so "Amazon Prime" passes before hitting this.
const RETAIL_RE = /\bamazon\b|\bamzn\b|newegg|nordstrom|macy|bloomingdale|costco|target|walmart|wal-?mart|best.?buy|home.?depot|lowe.?s|wayfair|chewy|petco|petsmart|\bnike\b|\badidas\b|\bgap\b|h&m|zara|uniqlo|old.?navy|j\.?crew/i;

export interface RecurringItem {
  merchant: string;
  payee: string;
  category: string;
  monthlyAvg: number;
  lastAmount: number;
  occurrences: number;    // distinct months
  lastDate: string;
  isFixed: boolean;       // true = mortgage / committed bill; false = flexible/cancellable
  manual?: boolean;       // true = user-added (not auto-detected from transactions)
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// A merchant is keyed by its (lowercased, trimmed, truncated) payee/description.
// Shared between auto-detection and manual overrides so a manually-added item can
// dedupe against — or be removed in favour of — a later auto-detected one.
export function merchantKey(payee: string, desc = ''): string {
  return (payee || desc || 'Unknown').trim().toLowerCase().slice(0, 40);
}

// User edits layered on top of auto-detection: rows can hide an auto-detected item
// (hidden = 1) and/or define a manual recurring item (manual = 1). Lazily created
// like budget.ts's tables so a fresh DB needs no migration step.
export function ensureRecurringTables(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS recurring_overrides (
      merchant   TEXT PRIMARY KEY,
      hidden     INTEGER NOT NULL DEFAULT 0,
      manual     INTEGER NOT NULL DEFAULT 0,
      payee      TEXT,
      category   TEXT,
      amount     REAL,
      is_fixed   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

interface OverrideRow {
  merchant: string; hidden: number; manual: number;
  payee: string | null; category: string | null; amount: number | null; is_fixed: number;
}

// Add (or replace) a user-defined recurring item. Category is stored canonically.
// When isFixed isn't specified (e.g. "mark this transaction as recurring"), it's
// inferred from the category the same way auto-detection classifies fixed bills.
export function addRecurring(input: { payee: string; category: string; amount: number; isFixed?: boolean }): void {
  ensureRecurringTables();
  const canon = getCategoryLabeler().canon(input.category);
  const isFixed = input.isFixed ?? FIXED_CATEGORIES.has(canon);
  const mk = merchantKey(input.payee);
  getDb().prepare(`
    INSERT INTO recurring_overrides (merchant, hidden, manual, payee, category, amount, is_fixed)
    VALUES (@merchant, 0, 1, @payee, @category, @amount, @is_fixed)
    ON CONFLICT(merchant) DO UPDATE SET
      hidden = 0, manual = 1, payee = @payee, category = @category, amount = @amount, is_fixed = @is_fixed
  `).run({ merchant: mk, payee: input.payee.trim(), category: canon, amount: Math.abs(input.amount), is_fixed: isFixed ? 1 : 0 });
}

// Remove an item: drop a manual one outright, otherwise mark an auto-detected one
// hidden so it stays gone across refreshes.
export function removeRecurring(merchant: string): void {
  ensureRecurringTables();
  const db = getDb();
  const row = db.prepare('SELECT manual FROM recurring_overrides WHERE merchant = ?').get(merchant) as { manual: number } | undefined;
  if (row?.manual) {
    db.prepare('DELETE FROM recurring_overrides WHERE merchant = ?').run(merchant);
  } else {
    db.prepare(`
      INSERT INTO recurring_overrides (merchant, hidden, manual) VALUES (?, 1, 0)
      ON CONFLICT(merchant) DO UPDATE SET hidden = 1
    `).run(merchant);
  }
}

// Exported for unit testing (see recurring.test.ts).
export function monthsBetween(m1: string, m2: string): number {
  const [y1, mo1] = m1.split('-').map(Number);
  const [y2, mo2] = m2.split('-').map(Number);
  return (y2 - y1) * 12 + (mo2 - mo1);
}

// Exported for unit testing (see recurring.test.ts).
export function coefficientOfVariation(values: number[]): number {
  if (values.length < 2) return 0; // single data point is trivially "consistent"
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  if (mean === 0) return 1;
  const stddev = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
  return stddev / mean;
}

/**
 * True when this merchant's billing pattern looks like a subscription or
 * membership rather than lumpy discretionary shopping.
 *
 * Three tiers — tested in priority order:
 *
 *   (A) Known-subscription merchant (SUBSCRIPTION_RE):
 *         2+ distinct months  AND  per-month-total CV < 0.40
 *       Looser because price increases, gifted months, and short gaps are normal.
 *
 *   (B) General service (not in RETAIL_RE):
 *         3+ distinct months  AND  CV < 0.25  AND  fill-rate ≥ 0.35
 *       "Fill-rate" = distinct months / (span from first to last month, inclusive).
 *       A fill-rate of 0.35 passes quarterly billing (≈3 of 9 months) while
 *       filtering scattered one-offs (e.g. 3 purchases spread across 13 months).
 *
 *   (C) Retail / marketplace merchant (RETAIL_RE):
 *         4+ distinct months  AND  CV < 0.08  AND  fill-rate ≥ 0.80
 *       Effectively only catches an Amazon-style storage/Prime fee billed
 *       identically every month; all real shopping fails one of those tests.
 */
// Exported for unit testing (see recurring.test.ts).
export function qualifiesAsFlexible(payee: string, byMonth: Map<string, number[]>): boolean {
  const monthKeys = [...byMonth.keys()].sort();
  const distinctMonths = monthKeys.length;

  // Per-month totals drive the variance calculation; we want to flag cases
  // where the TOTAL SPEND at this merchant varies wildly month to month.
  const monthTotals = monthKeys.map(m => byMonth.get(m)!.reduce((s, v) => s + v, 0));
  const cv = coefficientOfVariation(monthTotals);

  // Fill-rate: how continuously does this appear within its active span?
  const spanMonths = distinctMonths >= 2
    ? monthsBetween(monthKeys[0], monthKeys[distinctMonths - 1]) + 1
    : 1;
  const fillRate = distinctMonths / spanMonths;

  const isSub = SUBSCRIPTION_RE.test(payee);
  const isRetail = !isSub && RETAIL_RE.test(payee);

  if (isSub)    return distinctMonths >= 2 && cv < 0.40;
  if (isRetail) return distinctMonths >= 4 && cv < 0.08 && fillRate >= 0.80;
  return           distinctMonths >= 3 && cv < 0.25 && fillRate >= 0.35;
}

// ── Main export ──────────────────────────────────────────────────────────────

export async function getRecurring(): Promise<RecurringItem[]> {
  const db = getDb();
  ensureRecurringTables();
  const catLabeler = getCategoryLabeler();
  const overrides = new Map(
    (db.prepare('SELECT merchant, category FROM txn_rules').all() as { merchant: string; category: string }[])
      .map(r => [r.merchant, r.category])
  );

  // User overrides: which auto-detected items to hide, and any manually-added items.
  const overrideRows = db.prepare('SELECT merchant, hidden, manual, payee, category, amount, is_fixed FROM recurring_overrides').all() as OverrideRow[];
  const hidden = new Set(overrideRows.filter(r => r.hidden).map(r => r.merchant));
  const manualRows = overrideRows.filter(r => r.manual);

  // Only look at expense transactions (negative amounts) from the past 13 months.
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 13);
  const cutoffUnix = Math.floor(cutoff.getTime() / 1000);

  const acctCat = new Map(
    (db.prepare('SELECT id, category FROM accounts').all() as { id: string; category: string }[])
      .map(a => [a.id, a.category])
  );

  const raw = (await getAllTransactions()).filter(t =>
    t.posted >= cutoffUnix &&
    t.amount < 0 &&
    acctCat.get(t.accountId) !== 'brokerage'
  );

  const groups = new Map<string, {
    payee: string;
    category: string;
    byMonth: Map<string, number[]>;  // YYYY-MM → [amounts]
    lastDate: string;
    lastAmount: number;
  }>();

  for (const t of raw) {
    const mk = merchantKey(t.payee, t.description);
    const cat = (overrides.get(mk) as string | undefined) ?? autoCategory(t.payee, t.description, t.amount);
    if (SKIP_CATEGORIES.has(cat)) continue;

    const date = new Date(t.posted * 1000).toISOString().slice(0, 10);
    const ym = date.slice(0, 7);
    const amt = Math.abs(t.amount);

    let g = groups.get(mk);
    if (!g) {
      g = { payee: t.payee || t.description, category: cat, byMonth: new Map(), lastDate: date, lastAmount: amt };
      groups.set(mk, g);
    }

    const monthAmts = g.byMonth.get(ym) ?? [];
    monthAmts.push(amt);
    g.byMonth.set(ym, monthAmts);

    if (date > g.lastDate) { g.lastDate = date; g.lastAmount = amt; }
  }

  const items: RecurringItem[] = [];
  for (const [mk, g] of groups) {
    if (hidden.has(mk)) continue; // user removed this auto-detected item
    const isFixed = FIXED_CATEGORIES.has(g.category);

    // Fixed commitments (mortgage, bills) always surface; flexible ones must be in
    // an optimizable-fee category (or a named subscription) AND pass the
    // subscription-quality filter defined above.
    if (!isFixed) {
      if (g.byMonth.size < 2) continue;
      if (!inFlexibleRecurringScope(g.payee, g.category)) continue;
      if (!qualifiesAsFlexible(g.payee, g.byMonth)) continue;
    }

    const allAmounts = [...g.byMonth.values()].flat();
    const monthlyAvg = allAmounts.reduce((s, v) => s + v, 0) / g.byMonth.size;

    items.push({
      merchant: mk,
      payee: g.payee,
      category: catLabeler.label(g.category), // canonical → renamed for display
      monthlyAvg,
      lastAmount: g.lastAmount,
      occurrences: g.byMonth.size,
      lastDate: g.lastDate,
      isFixed,
    });
  }

  // Append manually-added items, unless an auto-detected (and not hidden) item
  // already covers the same merchant — the real data wins over the manual stand-in.
  const present = new Set(items.map(i => i.merchant));
  const today = new Date().toISOString().slice(0, 10);
  for (const r of manualRows) {
    if (present.has(r.merchant)) continue;
    const amount = r.amount ?? 0;
    items.push({
      merchant: r.merchant,
      payee: r.payee || r.merchant,
      category: catLabeler.label(r.category || 'Miscellaneous'),
      monthlyAvg: amount,
      lastAmount: amount,
      occurrences: 0,
      lastDate: today,
      isFixed: !!r.is_fixed,
      manual: true,
    });
  }

  // Sort: fixed first, then by monthly average descending.
  return items.sort((a, b) => {
    if (a.isFixed !== b.isFixed) return a.isFixed ? -1 : 1;
    return b.monthlyAvg - a.monthlyAvg;
  });
}

