import { getAllTransactions } from './simplefin.js';
import { getDb } from '../db/schema.js';

const FIXED_CATEGORIES = new Set(['Mortgage', 'Bills & Utilities']);
const SKIP_CATEGORIES = new Set(['Income', 'Transfers']); // not meaningful as "recurring costs"

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

  // Group by merchant key. For each merchant, collect monthly amounts.
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

  // Keep only merchants that appear in 2+ distinct months.
  const items: RecurringItem[] = [];
  for (const [mk, g] of groups) {
    if (g.byMonth.size < 2) continue;

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
      isFixed: FIXED_CATEGORIES.has(g.category),
    });
  }

  // Sort: fixed first, then by monthly average descending.
  return items.sort((a, b) => {
    if (a.isFixed !== b.isFixed) return a.isFixed ? -1 : 1;
    return b.monthlyAvg - a.monthlyAvg;
  });
}

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
