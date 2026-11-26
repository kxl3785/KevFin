// Which budget categories are "bills": categories fed mostly by recurring
// charges (rent, insurance, a gym membership, the phone plan), as opposed to
// flexible spending you pace through the month (groceries, restaurants). The
// Budget overview shows bills as paid / due instead of as a pace against a
// budget, so a gym fee charged on day 2 doesn't read as "100% used" in amber.
//
// The rule, kept simple enough to state in a tooltip: a category is a bill when
// its recurring items (from the recurring detector, plus any the user added)
// add up to at least half of what the category typically costs a month (its
// average over the last 12 complete months). A category with recurring items
// but no spending history yet (a bill added by hand) counts as a bill too.

export const BILL_SHARE = 0.5;
export const BILL_RULE =
  'A category counts as a bill when its recurring charges make up at least half of what it typically costs a month (its average over the last 12 complete months).';

export interface BillSource { category: string; payee: string; monthlyAvg: number; annual?: boolean }
export interface BillCategory {
  category: string;
  recurringMonthly: number;   // sum of the recurring items' monthly figures (annual bills amortized ÷12)
  typicalMonthly: number;     // the category's trailing average monthly spend (0 = no history)
  share: number | null;       // recurringMonthly / typicalMonthly; null with no history
  items: { payee: string; monthlyAvg: number; annual: boolean }[];
}

export function isBill(recurringMonthly: number, typicalMonthly: number): boolean {
  if (!(recurringMonthly > 0)) return false;
  if (!(typicalMonthly > 0)) return true;
  return recurringMonthly / typicalMonthly >= BILL_SHARE;
}

// Group recurring items by category and keep the categories that pass the rule.
// `typical` maps a category to its average monthly spend. Categories in `skip`
// (the mortgage, which budgeting leaves out) are never bills.
export function billCategories(
  items: BillSource[],
  typical: Map<string, number>,
  skip: Set<string> = new Set(),
): BillCategory[] {
  const byCat = new Map<string, BillSource[]>();
  for (const it of items) {
    if (skip.has(it.category) || !(it.monthlyAvg > 0)) continue;
    (byCat.get(it.category) ?? byCat.set(it.category, []).get(it.category)!).push(it);
  }
  const out: BillCategory[] = [];
  for (const [category, list] of byCat) {
    const recurringMonthly = round2(list.reduce((s, i) => s + i.monthlyAvg, 0));
    const typicalMonthly = round2(typical.get(category) ?? 0);
    if (!isBill(recurringMonthly, typicalMonthly)) continue;
    out.push({
      category, recurringMonthly, typicalMonthly,
      share: typicalMonthly > 0 ? Math.round((recurringMonthly / typicalMonthly) * 100) / 100 : null,
      items: list
        .map(i => ({ payee: i.payee, monthlyAvg: round2(i.monthlyAvg), annual: !!i.annual }))
        .sort((a, b) => b.monthlyAvg - a.monthlyAvg),
    });
  }
  return out.sort((a, b) => b.recurringMonthly - a.recurringMonthly);
}

const round2 = (n: number) => Math.round(n * 100) / 100;
