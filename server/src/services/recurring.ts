import { getAllTransactions } from './simplefin.js';
import { getDb } from '../db/schema.js';

const FIXED_CATEGORIES = new Set(['Mortgage', 'Bills & Utilities']);
const SKIP_CATEGORIES = new Set(['Income', 'Transfers']);

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
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function monthsBetween(m1: string, m2: string): number {
  const [y1, mo1] = m1.split('-').map(Number);
  const [y2, mo2] = m2.split('-').map(Number);
  return (y2 - y1) * 12 + (mo2 - mo1);
}

function coefficientOfVariation(values: number[]): number {
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
function qualifiesAsFlexible(payee: string, byMonth: Map<string, number[]>): boolean {
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
  const overrides = new Map(
    (db.prepare('SELECT merchant, category FROM txn_rules').all() as { merchant: string; category: string }[])
      .map(r => [r.merchant, r.category])
  );

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

  const merchantKey = (payee: string, desc: string) =>
    (payee || desc || 'Unknown').trim().toLowerCase().slice(0, 40);

  const groups = new Map<string, {
    payee: string;
    category: string;
    byMonth: Map<string, number[]>;  // YYYY-MM → [amounts]
    lastDate: string;
    lastAmount: number;
  }>();

  for (const t of raw) {
    const mk = merchantKey(t.payee, t.description);
    const cat = (overrides.get(mk) as string | undefined) ?? resolveCategory(t.payee, t.description, t.amount);
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
    const isFixed = FIXED_CATEGORIES.has(g.category);

    // Fixed commitments (mortgage, bills) always surface; flexible ones must pass
    // the subscription-quality filter defined above.
    if (!isFixed && g.byMonth.size < 2) continue;
    if (!isFixed && !qualifiesAsFlexible(g.payee, g.byMonth)) continue;

    const allAmounts = [...g.byMonth.values()].flat();
    const monthlyAvg = allAmounts.reduce((s, v) => s + v, 0) / g.byMonth.size;

    items.push({
      merchant: mk,
      payee: g.payee,
      category: g.category,
      monthlyAvg,
      lastAmount: g.lastAmount,
      occurrences: g.byMonth.size,
      lastDate: g.lastDate,
      isFixed,
    });
  }

  // Sort: fixed first, then by monthly average descending.
  return items.sort((a, b) => {
    if (a.isFixed !== b.isFixed) return a.isFixed ? -1 : 1;
    return b.monthlyAvg - a.monthlyAvg;
  });
}

// ── Category resolution ──────────────────────────────────────────────────────
// Kept in sync with budget.ts TRANSFER_RE — avoids a circular import.

const TRANSFER_RE = /payment thank you|autopay|online payment|\btransfer\b|zelle|venmo|cash app|moneyline|brokerage services|fid bkg|robinhood money|money payment|bilt card|card pmt|card payment|credit card payment|(?:american express|amex|discover|capital one|citi|citibank|wells fargo|bank of america|chase|barclays|synchrony).*credit card|^\s*to (brokerage|chase|personal|savings|checking|bilt|wells|bank|american express|amex)/i;
const MORTGAGE_RE = /\bmortgage\b|home loan|\bheloc\b|property payment|home equity|loancare|mr\.?\s*cooper|pennymac|quicken loan|rocket mortgage|newrez|nationstar|shellpoint|phh mortgage|sps servicing|carrington mortgage/i;

const RULES: { re: RegExp; cat: string }[] = [
  { re: /grocery|whole foods|trader joe|safeway|kroger|costco|wal-?mart|aldi|publix|wegmans|h-?e-?b|sprouts|food market|supermarket/i, cat: 'Groceries' },
  { re: /doordash|uber eats|grubhub|restaurant|cafe|coffee|starbucks|mcdonald|chipotle|pizza|grill|kitchen|\bbar\b|taco|sushi|dunkin|panera|chick-?fil|wendy|burger|\bdd \*/i, cat: 'Dining' },
  { re: /uber|lyft|shell|chevron|exxon|\bgas\b|fuel|parking|\btoll|\bbp\b|\b76\b|arco|metro|transit|amtrak|caltrain/i, cat: 'Transport' },
  { re: /netflix|spotify|hulu|disney\+?|youtube ?premium|prime video|patreon|icloud|google (storage|one)|hbo|paramount|adobe|membership|subscription/i, cat: 'Subscriptions' },
  { re: /electric|water util|\bpg&e\b|comcast|xfinity|at&t|verizon|t-mobile|utility|insurance|\brent\b|internet/i, cat: 'Bills & Utilities' },
  { re: /pharmacy|\bcvs\b|walgreens|doctor|dental|medical|clinic|hospital|\bgym\b|fitness|equinox/i, cat: 'Health' },
  { re: /airlines?|hotel|airbnb|expedia|booking\.com|marriott|hilton|\bdelta\b|united air|southwest|car rental|hertz|enterprise rent/i, cat: 'Travel' },
  { re: /cinema|movie|theater|amc |steam|playstation|xbox|nintendo|ticketmaster|concert/i, cat: 'Entertainment' },
  { re: /amazon|amzn|best buy|ebay|etsy|\bnike\b|apple\.com|target|nordstrom|macy|\bshop\b/i, cat: 'Shopping' },
  { re: /\bfee\b|interest charge|finance charge|service charge|overdraft/i, cat: 'Fees' },
];

function resolveCategory(payee: string, description: string, amount: number): string {
  const text = `${payee} ${description}`;
  if (TRANSFER_RE.test(text)) return 'Transfers';
  if (MORTGAGE_RE.test(text)) return 'Mortgage';
  if (amount > 0) return 'Income';
  for (const r of RULES) if (r.re.test(text)) return r.cat;
  return 'Other';
}
