import { getDb } from '../db/schema.js';
import { getCategorizedTransactions, getCategoryLabeler } from './budget.js';

// Fixed/committed bills (vs. flexible spend) and inflows to skip, in the new
// taxonomy. Category resolution is reused from budget.ts so the two stay in sync.
const FIXED_CATEGORIES = new Set(['Mortgage', 'Rent', 'Gas & Electric', 'Water', 'Internet & Phone', 'Insurance']);
// Income and internal money movement never count as recurring spend. Mirrors
// budget.ts's EXCLUDED_CATEGORIES — a Credit Card Payment is moving money to pay a
// card, not a recurring bill, and counting it double-counts the card's own
// itemized purchases (which already surface per-merchant here).
const SKIP_CATEGORIES = new Set(['Paychecks', 'Other Income', 'Dividends & Capital Gains', 'Transfers', 'Credit Card Payment']);

// Housing carry — mortgage payments and HOA dues — is surfaced in the Budget
// housing-carry breakdown (interest vs principal, tax, insurance, HOA), so listing
// it here too would double-count it. Excluded from recurring costs entirely.
const EXCLUDED_FROM_RECURRING = new Set(['Mortgage']);
const HOA_RE = /\bhoa\b|home ?owners?(?:'| )?\s*assoc|homeowners? association/i;

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
  // Recurring household services — maid, landscaping, pool, pest control, etc.
  // They bill steadily and are cancellable, so they belong in the optimizable set
  // (still gated by qualifiesAsFlexible, so a one-off plumber visit won't surface).
  'Home Services',
]);

// Exported for unit testing (see recurring.test.ts). `category` is the canonical
// (un-renamed) category from autoCategory / a txn rule.
export function inFlexibleRecurringScope(payee: string, category: string): boolean {
  return FLEXIBLE_RECURRING_CATEGORIES.has(category) || SUBSCRIPTION_RE.test(payee);
}

// ── Suggestion scope (locale-agnostic) ───────────────────────────────────────
// The suggestion engine surfaces *possible* recurring items the detector isn't
// confident about yet. It keys off the transaction's CATEGORY and its billing
// PATTERN — never merchant-name lists — so it behaves the same for a user in
// Dallas, Lisbon or Tokyo.

// Categories where a charge is plausibly a recurring bill: the union of the
// fixed-bill and flexible-recurring sets. Used to decide what's worth suggesting.
const RECURRING_PRONE_CATEGORIES = new Set<string>([...FIXED_CATEGORIES, ...FLEXIBLE_RECURRING_CATEGORIES]);

// A tighter subset where even a SINGLE observed charge is worth asking "is this
// recurring?" — bills/services that are almost never genuine one-offs. Excludes
// the flexible categories that are commonly one-offs (Entertainment, Charity).
const LIKELY_BILL_CATEGORIES = new Set<string>([
  'Mortgage', 'Rent', 'Gas & Electric', 'Water', 'Internet & Phone', 'Insurance',
  'Subscriptions', 'Fitness', 'Child Care', 'Auto Payment', 'Home Services',
]);

// Tokens that carry no identity, dropped before comparing merchant names so
// spelling/structure variants collapse together. Intentionally generic (no
// place- or language-specific words) to stay locale-neutral.
const NAME_STOPWORDS = new Set([
  'the', 'llc', 'inc', 'co', 'corp', 'ltd', 'gmbh', 'and', 'intl', 'international',
  'service', 'services', 'payment', 'autopay', 'bill', 'pmt', 'recurring', 'monthly',
]);

/**
 * A loose signature for spotting the SAME merchant under different spellings
 * ("Maid Dallas" vs "Maid 4 Dallas"): lowercase, drop digits/punctuation and
 * short/noise tokens, then sort the remaining words. Returns '' when nothing
 * distinctive remains (such candidates are never merged). Exported for testing.
 */
export function fuzzyNameKey(payee: string): string {
  const toks = (payee || '')
    .toLowerCase()
    .replace(/[^a-z\s]+/g, ' ')           // strip digits & punctuation
    .split(/\s+/)
    .filter(w => w.length >= 3 && !NAME_STOPWORDS.has(w));
  return [...new Set(toks)].sort().join(' ');
}

/**
 * Decide whether an unconfirmed, recurring-prone merchant is worth SUGGESTING,
 * and explain why. Pure and category/pattern-driven (no merchant names), so it's
 * unit-testable and locale-agnostic. Returns null when it shouldn't be shown.
 * Exported for testing.
 */
export function classifySuggestion(input: {
  distinctMonths: number;
  canonicalCategory: string;
  categoryLabel: string;
  payee: string;
  mergedNames: number; // how many distinct merchant spellings were merged (≥1)
}): { confidence: 'low' | 'medium'; reason: string } | null {
  const { distinctMonths, canonicalCategory, categoryLabel, payee, mergedNames } = input;
  if (distinctMonths >= 2) {
    return {
      confidence: 'medium',
      reason: mergedNames > 1
        ? `Looks like one merchant under ${mergedNames} different names — together it's billed across ${distinctMonths} months.`
        : `Charged in ${distinctMonths} months but not on a steady enough pattern to auto-detect — confirm to track it.`,
    };
  }
  // Single month: only worth surfacing for categories that are almost always bills.
  const likelyBill = LIKELY_BILL_CATEGORIES.has(canonicalCategory) || SUBSCRIPTION_RE.test(payee);
  if (!likelyBill) return null;
  return { confidence: 'low', reason: `Seen once, in a category that's usually a recurring bill (${categoryLabel}).` };
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
  annual?: boolean;       // true = billed yearly; monthlyAvg is the amortized (÷12) figure
  edited?: boolean;       // true = monthlyAvg is a user-entered override, not the detected value
  transactions: RecurringTxn[]; // the charges behind it (newest first); [] for manual items
}

// One underlying charge behind a recurring item or suggestion, shown in its
// detail box so the user can eyeball the actual history.
export interface RecurringTxn {
  date: string;
  amount: number;
  account: string;
  payee: string;
  description?: string;
}

// A *possible* recurring item the detector isn't confident enough to list yet —
// surfaced at the top of the Recurring screen for the user to confirm or dismiss.
// Confirming POSTs it like any manual item (keyed by `merchant`); dismissing
// DELETEs that key (hiding it). Built from billing patterns + category, so it is
// locale-agnostic.
export interface RecurringSuggestion {
  merchant: string;       // key used to confirm (POST) / dismiss (DELETE)
  payee: string;
  category: string;       // display label
  monthlyAvg: number;
  lastAmount: number;
  occurrences: number;    // distinct months observed (across merged spellings)
  lastDate: string;
  isFixed: boolean;       // inferred from the category
  annual?: boolean;       // true = billed yearly; monthlyAvg is the amortized (÷12) figure
  reason: string;         // plain-language "why we think this might recur"
  confidence: 'low' | 'medium';
  aliases?: string[];     // other merchant spellings merged into this suggestion
  transactions: RecurringTxn[]; // the charges behind it (newest first), for the detail box
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

// Override the displayed monthly amount for an item (the user knows the real
// figure better than our average). For a manual item this updates its amount; for
// an auto-detected one it stores an amount override that wins over the computed
// average. The override key is the item's merchant key.
export function setRecurringAmount(merchant: string, amount: number): void {
  ensureRecurringTables();
  getDb().prepare(`
    INSERT INTO recurring_overrides (merchant, hidden, manual, amount) VALUES (?, 0, 0, ?)
    ON CONFLICT(merchant) DO UPDATE SET amount = excluded.amount
  `).run(merchant, Math.abs(amount));
}

// Reset an auto-detected item back to its detected amount by clearing the amount
// override, then dropping the row if it now holds nothing else. Manual items keep
// their amount (it IS the value), so this is a no-op for them.
export function clearRecurringAmount(merchant: string): void {
  ensureRecurringTables();
  const db = getDb();
  db.prepare('UPDATE recurring_overrides SET amount = NULL WHERE merchant = ? AND manual = 0').run(merchant);
  db.prepare('DELETE FROM recurring_overrides WHERE merchant = ? AND manual = 0 AND hidden = 0 AND amount IS NULL').run(merchant);
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
 *
 *   (D) Recurring household service (category 'Home Services' — maid, pool,
 *       landscaping, pest control, …):
 *         3+ distinct months  AND  CV < 0.55  AND  fill-rate ≥ 0.50
 *       These bill on an ongoing basis but vary in amount far more than a
 *       fixed-price subscription (seasonal mow frequency, the odd repair on top
 *       of the monthly fee), so the variance bar is relaxed. The 3-month + fill
 *       requirements still reject one-off jobs (a single plumber/roof visit).
 */
// Exported for unit testing (see recurring.test.ts). `category` is the canonical
// (un-renamed) category, used to pick the Home-Services tier.
export function qualifiesAsFlexible(payee: string, byMonth: Map<string, number[]>, category = ''): boolean {
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
  const isService = !isSub && !isRetail && category === 'Home Services';

  if (isSub)     return distinctMonths >= 2 && cv < 0.40;
  if (isRetail)  return distinctMonths >= 4 && cv < 0.08 && fillRate >= 0.80;
  if (isService) return distinctMonths >= 3 && cv < 0.55 && fillRate >= 0.50;
  return            distinctMonths >= 3 && cv < 0.25 && fillRate >= 0.35;
}

// ── Main export ──────────────────────────────────────────────────────────────

// One merchant's billing history over the analysis window.
interface MerchantGroup {
  payee: string;
  category: string;                 // canonical
  byMonth: Map<string, number[]>;   // YYYY-MM → [amounts]
  txns: RecurringTxn[];             // individual charges (for a suggestion's detail box)
  lastDate: string;
  lastAmount: number;
}

// Everything both the confirmed-items list and the suggestions need, loaded once.
interface RecurringContext {
  groups: Map<string, MerchantGroup>;
  hidden: Set<string>;
  manualRows: OverrideRow[];
  amountOverrides: Map<string, number>; // merchant → user-entered monthly amount (auto items)
  catLabeler: ReturnType<typeof getCategoryLabeler>;
}

// Names that mark a yearly charge even when we've only seen it once (a single
// annual fee gives no cadence to measure). Kept short and generic; cadence is the
// primary, locale-agnostic signal.
const ANNUAL_NAME_RE = /\bannual(?:ly)?\b|\byear(?:ly)?\b|\bannum\b/i;

/**
 * Average MONTHLY cost for a set of charges, amortizing annual bills across 12
 * months so a once-a-year fee shows its true monthly run-rate (e.g. a $480 annual
 * fee → $40/mo) instead of its full sticker amount.
 *
 * "Annual" is detected from the billing cadence — charges spaced ~a year apart —
 * which needs no merchant names and works in any locale. For a single charge
 * (no cadence to measure) the merchant name is the only hint, so ANNUAL_NAME_RE
 * is the fallback there. Everything else keeps the simple per-month average.
 * Exported for unit testing.
 */
export function monthlyCost(byMonth: Map<string, number[]>, payee = ''): { monthlyAvg: number; annual: boolean } {
  const months = [...byMonth.keys()].sort();
  const distinct = months.length;
  if (distinct === 0) return { monthlyAvg: 0, annual: false };
  const sumOf = (ms: string[]) => ms.reduce((s, m) => s + byMonth.get(m)!.reduce((a, v) => a + v, 0), 0);
  const total = sumOf(months);

  // Annual when the merchant names itself yearly, OR (with enough data) its charges
  // are spaced ~a year apart. The name always counts so a once-seen "Annual Fee"
  // is caught even before a second year of history exists.
  let annual = ANNUAL_NAME_RE.test(payee);
  if (!annual && distinct >= 2) {
    const cadence = monthsBetween(months[0], months[distinct - 1]) / (distinct - 1);
    annual = cadence >= 10;
  }
  if (!annual) return { monthlyAvg: total / distinct, annual: false };

  // Amortize the most recent YEAR of charges across 12 months. Summing only the
  // last 12 months (relative to the newest charge) is robust: a lone fee → fee/12;
  // several annual fees in one year → their sum/12; the same fee repeated across
  // years → just the latest year counts, so it never double-counts.
  const last = months[distinct - 1];
  const lastYear = months.filter(m => monthsBetween(m, last) <= 11);
  return { monthlyAvg: sumOf(lastYear) / 12, annual: true };
}

// The charges behind an item/suggestion, newest first, capped for a small payload.
const recentTxns = (txns: RecurringTxn[]): RecurringTxn[] =>
  txns.slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 24);

// Build the per-merchant billing groups from the SAME merged + deduped +
// categorized ledger the Budget view uses, so imported-document transactions
// (utilities, pool/maid/landscaping, etc.) — not just SimpleFIN feeds — feed
// recurring detection. Categories are canonical and already honor every
// txn/base/smart rule the user has set.
async function loadContext(): Promise<RecurringContext> {
  const db = getDb();
  ensureRecurringTables();
  const catLabeler = getCategoryLabeler();

  const overrideRows = db.prepare('SELECT merchant, hidden, manual, payee, category, amount, is_fixed FROM recurring_overrides').all() as OverrideRow[];
  const hidden = new Set(overrideRows.filter(r => r.hidden).map(r => r.merchant));
  const manualRows = overrideRows.filter(r => r.manual);
  // Amount overrides on AUTO-detected items: not manual, not hidden, amount set.
  const amountOverrides = new Map(
    overrideRows.filter(r => !r.manual && !r.hidden && r.amount != null).map(r => [r.merchant, r.amount as number])
  );

  // Only look at expense transactions (negative amounts) from the past 13 months.
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 13);
  const cutoffUnix = Math.floor(cutoff.getTime() / 1000);

  const raw = (await getCategorizedTransactions()).filter(t => t.postedAt >= cutoffUnix && t.amount < 0);

  const groups = new Map<string, MerchantGroup>();
  for (const t of raw) {
    const cat = t.category; // canonical, final (already resolved against all rules)
    if (SKIP_CATEGORIES.has(cat)) continue;
    // Mortgage payments and HOA dues live in the housing-carry breakdown, not here.
    if (EXCLUDED_FROM_RECURRING.has(cat)) continue;
    if (HOA_RE.test(t.payee) || HOA_RE.test(t.description ?? '')) continue;

    const mk = t.merchant;
    const date = t.date;
    const ym = date.slice(0, 7);
    const amt = Math.abs(t.amount);

    let g = groups.get(mk);
    if (!g) {
      g = { payee: t.payee || t.description, category: cat, byMonth: new Map(), txns: [], lastDate: date, lastAmount: amt };
      groups.set(mk, g);
    }
    const monthAmts = g.byMonth.get(ym) ?? [];
    monthAmts.push(amt);
    g.byMonth.set(ym, monthAmts);
    g.txns.push({ date, amount: amt, account: t.account, payee: t.payee || t.description, description: t.description || undefined });
    if (date > g.lastDate) { g.lastDate = date; g.lastAmount = amt; }
  }
  return { groups, hidden, manualRows, amountOverrides, catLabeler };
}

// Whether a group is a CONFIRMED recurring item, and of which kind. null = not
// confident enough (a suggestion candidate). Fixed commitments always surface;
// flexible ones must be in an optimizable-fee category (or a named subscription)
// AND pass the subscription-quality filter.
function qualifyGroup(g: MerchantGroup): 'fixed' | 'flexible' | null {
  if (FIXED_CATEGORIES.has(g.category)) return 'fixed';
  if (g.byMonth.size < 2) return null;
  if (!inFlexibleRecurringScope(g.payee, g.category)) return null;
  if (!qualifiesAsFlexible(g.payee, g.byMonth, g.category)) return null;
  return 'flexible';
}

function itemsFrom(ctx: RecurringContext): RecurringItem[] {
  const { groups, hidden, manualRows, amountOverrides, catLabeler } = ctx;
  const items: RecurringItem[] = [];
  for (const [mk, g] of groups) {
    if (hidden.has(mk)) continue; // user removed this auto-detected item
    const kind = qualifyGroup(g);
    if (!kind) continue;
    const detected = monthlyCost(g.byMonth, g.payee);
    const override = amountOverrides.get(mk); // user-entered monthly amount wins
    items.push({
      merchant: mk,
      payee: g.payee,
      category: catLabeler.label(g.category), // canonical → renamed for display
      monthlyAvg: override ?? detected.monthlyAvg,
      annual: override != null ? false : detected.annual, // an override is a flat monthly figure
      edited: override != null,
      lastAmount: g.lastAmount,
      occurrences: g.byMonth.size,
      lastDate: g.lastDate,
      isFixed: kind === 'fixed',
      transactions: recentTxns(g.txns),
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
      transactions: [],
    });
  }

  // Sort: fixed first, then by monthly average descending.
  return items.sort((a, b) => {
    if (a.isFixed !== b.isFixed) return a.isFixed ? -1 : 1;
    return b.monthlyAvg - a.monthlyAvg;
  });
}

// Near-misses worth a nudge: recurring-PRONE merchants that didn't make the
// confirmed cut, with same-merchant-different-spelling candidates merged so a
// service split as "Maid Dallas" + "Maid 4 Dallas" becomes one suggestion.
function suggestionsFrom(ctx: RecurringContext): RecurringSuggestion[] {
  const { groups, hidden, manualRows, catLabeler } = ctx;
  const manualKeys = new Set(manualRows.map(r => r.merchant));

  // Candidates: recurring-prone, unconfirmed, not hidden, not already manual.
  const cands: { mk: string; g: MerchantGroup }[] = [];
  for (const [mk, g] of groups) {
    if (hidden.has(mk) || manualKeys.has(mk)) continue;
    if (qualifyGroup(g)) continue; // already a confirmed item
    const prone = RECURRING_PRONE_CATEGORIES.has(g.category) || SUBSCRIPTION_RE.test(g.payee);
    if (!prone) continue;          // out of scope (groceries, restaurants, …)
    cands.push({ mk, g });
  }

  // Group by fuzzy name signature so different spellings of one merchant merge.
  // A blank signature (nothing distinctive) stays standalone under a unique key.
  const byFuzzy = new Map<string, { mk: string; g: MerchantGroup }[]>();
  for (const c of cands) {
    const sig = fuzzyNameKey(c.g.payee);
    const key = sig || ` ${c.mk}`;
    (byFuzzy.get(key) ?? byFuzzy.set(key, []).get(key)!).push(c);
  }

  const out: RecurringSuggestion[] = [];
  for (const members of byFuzzy.values()) {
    // Merge months/amounts across the spellings.
    const merged = new Map<string, number[]>();
    let lastDate = '';
    let lastAmount = 0;
    for (const c of members) {
      for (const [ym, arr] of c.g.byMonth) {
        const cur = merged.get(ym) ?? [];
        cur.push(...arr);
        merged.set(ym, cur);
      }
      if (c.g.lastDate > lastDate) { lastDate = c.g.lastDate; lastAmount = c.g.lastAmount; }
    }
    // Representative = the most-recently-active spelling, so confirm/dismiss
    // targets a real, current merchant key.
    const primary = members.slice().sort((a, b) => b.g.lastDate.localeCompare(a.g.lastDate))[0];
    const distinctMonths = merged.size;
    const { monthlyAvg, annual } = monthlyCost(merged, primary.g.payee);
    const category = primary.g.category;

    const verdict = classifySuggestion({
      distinctMonths,
      canonicalCategory: category,
      categoryLabel: catLabeler.label(category),
      payee: primary.g.payee,
      mergedNames: members.length,
    });
    if (!verdict) continue;

    const aliases = members.filter(c => c !== primary).map(c => c.g.payee);
    const transactions = recentTxns(members.flatMap(c => c.g.txns));
    out.push({
      merchant: primary.mk,
      payee: primary.g.payee,
      category: catLabeler.label(category),
      monthlyAvg,
      annual,
      lastAmount,
      occurrences: distinctMonths,
      lastDate,
      isFixed: FIXED_CATEGORIES.has(category),
      reason: verdict.reason,
      confidence: verdict.confidence,
      aliases: aliases.length ? aliases : undefined,
      transactions,
    });
  }

  // Most-promising first; cap so the section stays a glanceable nudge, not a list.
  const rank = { medium: 0, low: 1 };
  return out
    .sort((a, b) => (rank[a.confidence] - rank[b.confidence]) || (b.monthlyAvg - a.monthlyAvg))
    .slice(0, 8);
}

export async function getRecurring(): Promise<RecurringItem[]> {
  return itemsFrom(await loadContext());
}

export interface RecurringPayload { items: RecurringItem[]; suggestions: RecurringSuggestion[] }

// Confirmed items + ambiguous suggestions in one pass (a single ledger read).
export async function getRecurringPayload(): Promise<RecurringPayload> {
  const ctx = await loadContext();
  return { items: itemsFrom(ctx), suggestions: suggestionsFrom(ctx) };
}

