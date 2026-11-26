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

// --- Overview categories card -------------------------------------------------

export interface ListCat { category: string; spent: number; count: number; target: number; period?: 'monthly' | 'annual'; excluded?: boolean }

// A category's monthly-equivalent budget (annual budgets count 1/12), as the
// server's totalBudget counts it.
export const monthlyTarget = (c: { target: number; period?: 'monthly' | 'annual' }) => (c.period === 'annual' ? c.target / 12 : c.target);

// The categories left out of spending and budgets: the server's greyed
// reference rows this month (`excluded`, i.e. the mortgage), plus the mortgage
// category by its display name even in a month it has no payment.
export function excludedCategoryNames(byCategory: ListCat[], groups: { categories: { name: string; canonical?: string }[] }[], mortgage = 'Mortgage'): Set<string> {
  const out = new Set([mortgage, ...byCategory.filter(c => c.excluded).map(c => c.category)]);
  for (const g of groups) for (const c of g.categories) if (c.canonical === mortgage) out.add(c.name);
  return out;
}

export interface CategoryGroups<T extends ListCat> {
  flexible: T[];       // read against a budget; the top N by spend plus any the user added
  bills: T[];          // categories fed mostly by recurring charges
  excluded: T[];       // greyed "not in spending" reference rows, shown last, never counted
  insertable: string[]; // offered under "Add category"
  flexSpent: number; flexBudget: number;
  ranked: number;                          // flexible candidates before the top-N cut
  rest: { count: number; spent: number };  // those past the top-N cut (not shown)
  hidden: { names: string[]; spent: number }; // hidden categories with spending this month
}

// Split the month's categories (byCategory, sorted by spend server-side) into
// the card's groups. Every bill is listed (a bill still due matters most when
// nothing has been charged, so bills don't compete for the top-N slots), then
// the top N other categories by spend, minus any the user hid, plus any they
// added (synthesised by `blank` at $0 when they have no row this month).
// Excluded categories never enter a group, a subtotal or "Add category", even
// when a saved hidden/added list names them: they only ever show as reference
// rows at the end (see healCategoryPrefs, which cleans such saved lists).
export function categoryGroups<T extends ListCat>(o: {
  byCategory: T[]; billNames: string[]; hidden: string[]; extra: string[]; categories: string[];
  excludedNames: Set<string>; topN: number; blank: (name: string) => T;
}): CategoryGroups<T> {
  const isExcl = (name: string) => o.excludedNames.has(name);
  const hidden = new Set(o.hidden.filter(n => !isExcl(n)));
  const billSet = new Set(o.billNames.filter(n => !isExcl(n)));
  const find = (name: string) => o.byCategory.find(c => c.category === name);
  const bills = [...billSet].filter(n => !hidden.has(n)).map(n => find(n) ?? o.blank(n));
  const candidates = o.byCategory.filter(c => !c.excluded && !isExcl(c.category) && !hidden.has(c.category) && !billSet.has(c.category));
  const flexible = candidates.slice(0, o.topN);
  const restRows = candidates.slice(o.topN);
  const shown = new Set([...flexible, ...bills].map(c => c.category));
  for (const name of o.extra) {
    if (shown.has(name) || hidden.has(name) || isExcl(name)) continue;
    flexible.push(find(name) ?? o.blank(name));
    shown.add(name);
  }
  const excluded = o.byCategory.filter(c => c.excluded && !shown.has(c.category));
  excluded.forEach(c => shown.add(c.category));
  const sum = (rows: ListCat[], f: (c: ListCat) => number) => rows.reduce((s, c) => s + f(c), 0);
  const rest = restRows.filter(c => !shown.has(c.category));
  const hiddenSpent = o.byCategory.filter(c => hidden.has(c.category) && !c.excluded && c.spent > 0.005);
  return {
    flexible, bills, excluded,
    insertable: o.categories.filter(c => !shown.has(c) && !isExcl(c)),
    flexSpent: sum(flexible, c => c.spent),
    flexBudget: sum(flexible, monthlyTarget),
    ranked: candidates.length,
    rest: { count: rest.length, spent: sum(rest, c => c.spent) },
    hidden: { names: hiddenSpent.map(c => c.category), spent: sum(hiddenSpent, c => c.spent) },
  };
}

// The saved hidden/added lists with any excluded category taken out, or null
// when there is nothing to clean. An older build let the mortgage be hidden
// and then added back, which put it into Flexible spending in every month;
// stripping it from both lists restores the reference row for good.
export function healCategoryPrefs(hidden: string[], extra: string[], excludedNames: Set<string>): { hidden: string[]; extra: string[] } | null {
  const h = hidden.filter(n => !excludedNames.has(n));
  const x = extra.filter(n => !excludedNames.has(n));
  return h.length === hidden.length && x.length === extra.length ? null : { hidden: h, extra: x };
}

// --- Budget box ---------------------------------------------------------------

// What the user typed in a category's budget box: an amount ("300", "$1,250.50",
// "1.5k", "2m"), blank (nothing to save), or not an amount at all. Stricter than
// parseNumOrNull, which strips every other character, so "abc30" saved $30.
export function parseBudgetInput(s: string): { kind: 'amount'; value: number } | { kind: 'blank' } | { kind: 'invalid' } {
  const t = s.replace(/\s+/g, '').toLowerCase();
  if (!t) return { kind: 'blank' };
  const m = /^\$?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)([km])?$/.exec(t);
  if (!m) return { kind: 'invalid' };
  const n = parseFloat(m[1].replace(/,/g, ''));
  const scale = m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : 1;
  // Round a scaled value to cents so "1.15m" is 1150000, not 1149999.9999999998.
  return { kind: 'amount', value: scale === 1 ? n : Math.round(n * scale * 100) / 100 };
}
