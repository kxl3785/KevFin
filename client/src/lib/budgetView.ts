// Pure helpers behind the Budget tab's month picker, sub-tabs, transaction
// filters and day-grouped lists.

export type BudgetTab = 'overview' | 'transactions' | 'recurring' | 'cashflow' | 'setup';
export type CashView = 'month' | 'flow';

// Deep links (the `mon.budgetDeepLink` hand-off from other pages, and older
// saved links) may still name the six tabs the Budget page used to have: the
// Cash Flow chart and the Sankey are now the two views of "Cash flow", and
// Rules lives under "Categories & rules".
export function resolveBudgetTab(tab: string | undefined): { tab: BudgetTab; cashView?: CashView } | null {
  switch (tab) {
    case 'overview': case 'transactions': case 'recurring': case 'setup': return { tab };
    case 'cashflow': return { tab: 'cashflow', cashView: 'month' };
    case 'sankey': case 'flow': return { tab: 'cashflow', cashView: 'flow' };
    case 'rules': case 'categories': return { tab: 'setup' };
    default: return null;
  }
}

// Step through the months that have data (`months` is newest first, as the API
// sends it). dir −1 = an earlier month, +1 = a later one. null at either end.
export function stepMonth(months: string[], current: string, dir: -1 | 1): string | null {
  const i = months.indexOf(current);
  if (i < 0) return null;
  const j = i - dir; // newest first: earlier = further down the list
  return j >= 0 && j < months.length ? months[j] : null;
}

export const monthLong = (ym: string) =>
  new Date(ym + '-01T00:00:00').toLocaleString('en-US', { month: 'long', year: 'numeric' });

// "Mon, Jun 23" for a day header ("Mon, Jun 23, 2025" outside the current year).
export function dayHeader(date: string, thisYear = new Date().getFullYear()): string {
  const d = new Date(date.slice(0, 10) + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', ...(d.getFullYear() !== thisYear ? { year: 'numeric' } : {}) });
}

// Consecutive runs of rows on the same date, in the order given (the lists are
// already newest first).
export function groupByDay<T extends { date: string }>(rows: T[]): { date: string; rows: T[] }[] {
  const out: { date: string; rows: T[] }[] = [];
  for (const r of rows) {
    const day = r.date.slice(0, 10);
    const last = out[out.length - 1];
    if (last && last.date === day) last.rows.push(r); else out.push({ date: day, rows: [r] });
  }
  return out;
}

// --- Transactions filters ----------------------------------------------------

export const NEEDS_CATEGORY = 'Miscellaneous';
// An expense still in the catch-all category, matching the Overview's "Needs
// review" card and the Quick review queue.
export const needsCategory = (t: { category: string; amount: number }) => t.category === NEEDS_CATEGORY && t.amount < 0;

export type AmountFilter = 'any' | 'over100' | 'over500' | 'under20' | 'in' | 'out';
export const AMOUNT_FILTERS: { key: AmountFilter; label: string }[] = [
  { key: 'any', label: 'Any amount' },
  { key: 'over100', label: 'Over $100' },
  { key: 'over500', label: 'Over $500' },
  { key: 'under20', label: 'Under $20' },
  { key: 'in', label: 'Money in' },
  { key: 'out', label: 'Money out' },
];
// Sizes compare the amount's size, so "Over $100" catches a $100+ refund too.
export function amountMatches(amount: number, f: AmountFilter): boolean {
  const a = Math.abs(amount);
  switch (f) {
    case 'over100': return a > 100;
    case 'over500': return a > 500;
    case 'under20': return a < 20;
    case 'in': return amount > 0;
    case 'out': return amount < 0;
    default: return true;
  }
}

export interface TxnFilters { category: string; account: string; needsCategory: boolean; amount: AmountFilter; q: string }
export const NO_FILTERS: TxnFilters = { category: '', account: '', needsCategory: false, amount: 'any', q: '' };

export function filterTxns<T extends { payee: string; account: string; category: string; amount: number }>(rows: T[], f: TxnFilters): T[] {
  const q = f.q.trim().toLowerCase();
  return rows.filter(t =>
    (!f.category || t.category === f.category) &&
    (!f.account || t.account === f.account) &&
    (!f.needsCategory || needsCategory(t)) &&
    amountMatches(t.amount, f.amount) &&
    (!q || `${t.payee} ${t.account} ${t.category}`.toLowerCase().includes(q)));
}

// In / Out / Mortgage for a list of transactions. In and Out are summed by sign
// (so a refund counts as In rather than netting against Out); mortgage payments
// are counted on their own, whatever their sign, and kept out of Out — the same
// way the Overview leaves them out of "Spent".
export function inOutMortgage(rows: { category: string; amount: number }[], mortgageCategory = 'Mortgage') {
  let inflow = 0, outflow = 0, mortgage = 0;
  for (const t of rows) {
    if (t.category === mortgageCategory) mortgage += Math.abs(t.amount);
    else if (t.amount > 0) inflow += t.amount;
    else outflow -= t.amount;
  }
  return { inflow, outflow, mortgage };
}
