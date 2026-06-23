import { getDb } from '../db/schema.js';
import { getAllTransactions } from './simplefin.js';

export const CATEGORIES = [
  'Income', 'Groceries', 'Dining', 'Transport', 'Shopping', 'Bills & Utilities',
  'Subscriptions', 'Entertainment', 'Health', 'Travel', 'Transfers', 'Mortgage', 'Fees', 'Other',
] as const;
export type Category = typeof CATEGORIES[number];

// Keyword rules applied to "payee + description" (first match wins).
const RULES: { re: RegExp; cat: Category }[] = [
  { re: /payment thank you|autopay|online payment|\btransfer\b|zelle|venmo|cash app|\bach\b|withdrawal|\batm\b|bill ?pay/i, cat: 'Transfers' },
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

const PROTECTED = new Set(['Income', 'Transfers', 'Mortgage', 'Other']); // can't be removed

function ensureTables() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS txn_rules (merchant TEXT PRIMARY KEY, category TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS budget_targets (category TEXT PRIMARY KEY, monthly_limit REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS budget_categories (name TEXT PRIMARY KEY, sort INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS imported_txns (
      id TEXT PRIMARY KEY, date TEXT NOT NULL, amount REAL NOT NULL,
      payee TEXT NOT NULL, merchant TEXT NOT NULL, account TEXT NOT NULL, category TEXT
    );
  `);
  const count = (db.prepare('SELECT COUNT(*) AS n FROM budget_categories').get() as { n: number }).n;
  if (count === 0) {
    const ins = db.prepare('INSERT INTO budget_categories (name, sort) VALUES (?, ?)');
    CATEGORIES.forEach((c, i) => ins.run(c, i));
  }
}

export function getActiveCategories(): string[] {
  ensureTables();
  return (getDb().prepare('SELECT name FROM budget_categories ORDER BY sort, name').all() as { name: string }[]).map(r => r.name);
}

export function addCategory(name: string) {
  ensureTables();
  const clean = name.trim().slice(0, 30);
  if (!clean) return;
  const max = (getDb().prepare('SELECT COALESCE(MAX(sort),0) AS m FROM budget_categories').get() as { m: number }).m;
  getDb().prepare('INSERT OR IGNORE INTO budget_categories (name, sort) VALUES (?, ?)').run(clean, max + 1);
}

export function removeCategory(name: string) {
  ensureTables();
  if (PROTECTED.has(name)) return;
  const db = getDb();
  db.prepare('DELETE FROM budget_categories WHERE name = ?').run(name);
  db.prepare('DELETE FROM budget_targets WHERE category = ?').run(name);
  db.prepare('DELETE FROM txn_rules WHERE category = ?').run(name); // its merchants fall back to auto/Other
}

export function setTarget(category: string, limit: number) {
  ensureTables();
  if (limit > 0) {
    getDb().prepare('INSERT OR REPLACE INTO budget_targets (category, monthly_limit) VALUES (?, ?)').run(category, limit);
  } else {
    getDb().prepare('DELETE FROM budget_targets WHERE category = ?').run(category);
  }
}

function merchantKey(payee: string, description: string): string {
  return (payee || description || 'Unknown').trim().toLowerCase().slice(0, 40);
}

const TRANSFER_RE = /payment thank you|autopay|online payment|\btransfer\b|zelle|venmo|cash app|moneyline|brokerage services|fid bkg|robinhood money|money payment|bilt card|card pmt|card payment|^\s*to (brokerage|chase|personal|savings|checking|bilt|wells|bank)/i;

const MORTGAGE_RE = /\bmortgage\b|home loan|\bheloc\b|property payment|home equity|loancare|mr\.?\s*cooper|pennymac|quicken loan|rocket mortgage|newrez|nationstar|shellpoint|phh mortgage|sps servicing|carrington mortgage/i;

function autoCategory(payee: string, description: string, amount: number): Category {
  const text = `${payee} ${description}`;
  if (TRANSFER_RE.test(text)) return 'Transfers';
  if (MORTGAGE_RE.test(text)) return 'Mortgage';
  if (amount > 0) return 'Income';
  for (const r of RULES) if (r.re.test(text)) return r.cat;
  return 'Other';
}

export interface BudgetTxn {
  id: string; date: string; amount: number; description: string; payee: string;
  account: string; merchant: string; category: Category; suggested: Category;
}

export interface BudgetSummary {
  months: string[];                       // available YYYY-MM, newest first
  month: string;                          // the month being shown
  transactions: BudgetTxn[];              // for the requested month (excludes Transfers; Mortgage kept but flagged)
  byCategory: { category: string; spent: number; count: number; target: number; excluded?: boolean }[];
  needsReview: BudgetTxn[];               // uncategorized ('Other') expenses to assign
  income: number;
  spending: number;
  mortgage: number;                       // mortgage payments (excluded from spending)
  totalBudget: number;                    // sum of targets
  comparison: { priorMonth: number | null; priorYearAvg: number | null };
  dailyCumulative: { day: number; current: number | null; prior: number | null }[];
  importedCount: number;
}

function daysInMonth(ym: string): number {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function addMonths(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
}

// --- CSV import (e.g. Monarch) ---------------------------------------------

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (field !== '' || row.length) { row.push(field); rows.push(row); row = []; field = ''; }
      if (c === '\r' && text[i + 1] === '\n') i++;
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function normDate(s: string): string | null {
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const mdy = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (mdy) return `${mdy[3]}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`;
  const d = new Date(t);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export function getImported() {
  ensureTables();
  return getDb().prepare('SELECT id, date, amount, payee, account, category FROM imported_txns ORDER BY date DESC').all();
}
export function clearImported() {
  ensureTables();
  return getDb().prepare('DELETE FROM imported_txns').run().changes;
}
export function deleteImported(id: string) {
  ensureTables();
  getDb().prepare('DELETE FROM imported_txns WHERE id = ?').run(id);
}

// Physically delete imported transactions that duplicate a SimpleFIN transaction
// (matched on date | amount | merchant). Returns how many were removed.
const normAcct = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/\d+$/, '');
function acctCompatible(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const min = Math.min(a.length, b.length);
  return min >= 4 && (a.includes(b) || b.includes(a)); // e.g. "chasefreedom" ⊂ "chasefreedom"
}

export async function reconcileImported(): Promise<{ removed: number }> {
  ensureTables();
  const db = getDb();
  const sf = await getAllTransactions();

  // Tier 1: exact date|amount|merchant. Tier 2 (fuzzy): date|amount with a
  // compatible account, ignoring merchant — catches differently-labeled payees.
  const merchantKeyOf = (date: string, amount: number, merchant: string) => `${date}|${amount.toFixed(2)}|${merchant}`;
  const sfMerchantKeys = new Set<string>();
  const sfDateAmt = new Map<string, string[]>(); // 'date|amount' -> normalized accounts
  for (const t of sf) {
    const date = new Date(t.posted * 1000).toISOString().slice(0, 10);
    sfMerchantKeys.add(merchantKeyOf(date, t.amount, merchantKey(t.payee, t.description)));
    const da = `${date}|${t.amount.toFixed(2)}`;
    (sfDateAmt.get(da) ?? sfDateAmt.set(da, []).get(da)!).push(normAcct(t.accountName));
  }

  const rows = db.prepare('SELECT id, date, amount, merchant, account FROM imported_txns').all() as
    { id: string; date: string; amount: number; merchant: string; account: string }[];
  const del = db.prepare('DELETE FROM imported_txns WHERE id = ?');
  let removed = 0;
  db.transaction(() => {
    for (const r of rows) {
      let dup = sfMerchantKeys.has(merchantKeyOf(r.date, r.amount, r.merchant));
      if (!dup) {
        const accs = sfDateAmt.get(`${r.date}|${r.amount.toFixed(2)}`);
        if (accs) { const ra = normAcct(r.account); dup = accs.some(a => acctCompatible(a, ra)); }
      }
      if (dup) { del.run(r.id); removed++; }
    }
  })();
  return { removed };
}

export function importTransactions(csv: string): { imported: number; skipped: number } {
  ensureTables();
  const rows = parseCsv(csv).filter(r => r.some(c => c.trim() !== ''));
  if (rows.length < 2) return { imported: 0, skipped: 0 };
  const header = rows[0].map(h => h.trim().toLowerCase());
  const idx = (names: string[]) => header.findIndex(h => names.includes(h));
  const di = idx(['date', 'posted date', 'transaction date']);
  const mi = idx(['merchant', 'description', 'name', 'payee']);
  const ai = idx(['amount']);
  const acci = idx(['account', 'account name']);
  const ci = idx(['category']);
  if (di < 0 || ai < 0) throw new Error('CSV needs at least Date and Amount columns');

  const db = getDb();
  const ins = db.prepare('INSERT OR IGNORE INTO imported_txns (id, date, amount, payee, merchant, account, category) VALUES (?,?,?,?,?,?,?)');
  let imported = 0, skipped = 0;
  db.transaction(() => {
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const date = normDate(row[di] ?? '');
      if (!date) { skipped++; continue; }
      const amount = parseFloat((row[ai] ?? '').replace(/[$,()]/g, '')) || 0;
      const payee = (mi >= 0 ? row[mi] : '')?.trim() || 'Unknown';
      const account = (acci >= 0 ? row[acci] : '')?.trim() || 'Imported';
      const category = (ci >= 0 ? row[ci] : '')?.trim() || '';
      const merchant = merchantKey(payee, '');
      // Dedup key (also matches SimpleFIN at read time): date|amount|merchant|account.
      const id = `imp|${date}|${amount.toFixed(2)}|${merchant}|${account.toLowerCase().slice(0, 20)}`;
      const info = ins.run(id, date, amount, payee, merchant, account, category);
      info.changes > 0 ? imported++ : skipped++;
    }
  })();
  return { imported, skipped };
}

// Build the merged, categorized transaction list (SimpleFIN + imported, deduped,
// brokerage trades excluded). Shared by the monthly budget and the projection.
async function getCategorizedTransactions(): Promise<BudgetTxn[]> {
  ensureTables();
  const db = getDb();
  const overrides = new Map(
    (db.prepare('SELECT merchant, category FROM txn_rules').all() as { merchant: string; category: string }[])
      .map(r => [r.merchant, r.category as Category])
  );

  // Budgeting is about cash flow — exclude brokerage trades (buys/sells aren't spending).
  const acctCat = new Map(
    (db.prepare('SELECT id, category FROM accounts').all() as { id: string; category: string }[])
      .map(a => [a.id, a.category])
  );
  const activeSet = new Set(getActiveCategories());
  const sfRaw = (await getAllTransactions()).filter(t => acctCat.get(t.accountId) !== 'brokerage');
  const sfAll: BudgetTxn[] = sfRaw.map(t => {
    const m = merchantKey(t.payee, t.description);
    const date = new Date(t.posted * 1000).toISOString().slice(0, 10);
    const suggested = autoCategory(t.payee, t.description, t.amount); // rule-based guess, pre-override
    let category = overrides.get(m) ?? suggested;
    if (!activeSet.has(category)) category = 'Other';
    return { id: t.id, date, amount: t.amount, description: t.description, payee: t.payee || t.description, account: t.accountName, merchant: m, category, suggested };
  });

  // Merge imported (Monarch etc.) transactions, dropping any that duplicate a
  // SimpleFIN transaction by date|amount|merchant.
  const dedupKey = (date: string, amount: number, merchant: string) => `${date}|${amount.toFixed(2)}|${merchant}`;
  const seen = new Set(sfAll.map(t => dedupKey(t.date, t.amount, t.merchant)));
  const importedRows = db.prepare('SELECT * FROM imported_txns').all() as
    { id: string; date: string; amount: number; payee: string; merchant: string; account: string; category: string | null }[];
  const importedAll: BudgetTxn[] = [];
  for (const r of importedRows) {
    const key = dedupKey(r.date, r.amount, r.merchant);
    if (seen.has(key)) continue; // duplicate of a SimpleFIN txn
    seen.add(key);
    const suggested = autoCategory(r.payee, '', r.amount);
    let cat = overrides.get(r.merchant) as string | undefined;
    if (!cat && r.category) cat = [...activeSet].find(a => a.toLowerCase() === r.category!.toLowerCase());
    if (!cat) cat = suggested;
    if (!activeSet.has(cat)) cat = 'Other';
    importedAll.push({ id: r.id, date: r.date, amount: r.amount, description: r.payee, payee: r.payee, account: r.account, merchant: r.merchant, category: cat as Category, suggested });
  }
  return [...sfAll, ...importedAll];
}

export async function getBudget(month?: string): Promise<BudgetSummary> {
  ensureTables();
  const db = getDb();
  const targets = new Map(
    (db.prepare('SELECT category, monthly_limit FROM budget_targets').all() as { category: string; monthly_limit: number }[])
      .map(t => [t.category, t.monthly_limit])
  );

  const all = await getCategorizedTransactions();

  // Spending per month (excludes income/transfers/mortgage) for prior-period comparisons.
  const monthSpend = new Map<string, number>();
  for (const t of all) {
    if (t.category === 'Income' || t.category === 'Transfers' || t.category === 'Mortgage') continue;
    const spend = Math.max(0, -t.amount);
    if (spend) monthSpend.set(t.date.slice(0, 7), (monthSpend.get(t.date.slice(0, 7)) ?? 0) + spend);
  }

  const months = [...new Set(all.map(t => t.date.slice(0, 7)))].sort().reverse();
  const target = month && months.includes(month) ? month : months[0];

  // Transfers are excluded from the budget transaction list. Mortgage is kept
  // (shown grayed/“excluded”) so it stays visible without affecting totals.
  const txns = all
    .filter(t => t.date.slice(0, 7) === target && t.category !== 'Transfers')
    .sort((a, b) => b.date.localeCompare(a.date));

  const allMonthTxns = all.filter(t => t.date.slice(0, 7) === target);
  const catMap = new Map<string, { total: number; count: number }>();
  let income = 0;
  let spending = 0;
  let mortgage = 0;
  let mortgageCount = 0;
  for (const t of allMonthTxns) {
    if (t.category === 'Income') { income += t.amount; continue; }
    if (t.category === 'Transfers') continue;
    // Mortgage cash regardless of sign — some sources post loan payments as positive.
    if (t.category === 'Mortgage') { mortgage += Math.abs(t.amount); mortgageCount += 1; continue; }
    const spend = Math.max(0, -t.amount); // expenses are negative amounts
    if (spend === 0) continue;
    spending += spend;
    const e = catMap.get(t.category) ?? { total: 0, count: 0 };
    e.total += spend; e.count += 1;
    catMap.set(t.category, e);
  }

  // Include every category that has spending OR a target (so budgets show even at $0 spent).
  // Mortgage is intentionally omitted here — it's appended below as an excluded row.
  const catNames = new Set<string>([...catMap.keys(), ...targets.keys()]);
  catNames.delete('Mortgage');
  const byCategory: BudgetSummary['byCategory'] = [...catNames]
    .map(category => ({
      category,
      spent: catMap.get(category)?.total ?? 0,
      count: catMap.get(category)?.count ?? 0,
      target: targets.get(category) ?? 0,
    }))
    .sort((a, b) => b.spent - a.spent || b.target - a.target);

  // Mortgage stays visible as a grayed, excluded row (never counted in spending).
  if (mortgage > 0) {
    byCategory.push({ category: 'Mortgage', spent: mortgage, count: mortgageCount, target: 0, excluded: true });
  }

  const needsReview = txns.filter(t => t.category === 'Other' && t.amount < 0);
  const totalBudget = [...targets.values()].reduce((s, v) => s + v, 0);

  // Comparisons: prior month, and average of the same calendar month in prior years.
  const priorMonth = monthSpend.get(addMonths(target, -1)) ?? null;
  const mm = target.slice(5, 7);
  const yy = parseInt(target.slice(0, 4));
  const priorYearVals = [...monthSpend.entries()]
    .filter(([k]) => k.slice(5, 7) === mm && parseInt(k.slice(0, 4)) < yy)
    .map(([, v]) => v);
  const priorYearAvg = priorYearVals.length ? priorYearVals.reduce((a, b) => a + b, 0) / priorYearVals.length : null;

  // Cumulative spending by day-of-month: current month vs prior month.
  const cumByDay = (monthKey: string): number[] => {
    const daily = new Array(32).fill(0);
    for (const t of all) {
      if (t.date.slice(0, 7) !== monthKey || t.category === 'Income' || t.category === 'Transfers' || t.category === 'Mortgage') continue;
      const spend = Math.max(0, -t.amount);
      if (spend) daily[parseInt(t.date.slice(8, 10))] += spend;
    }
    const cum = new Array(32).fill(0);
    let run = 0;
    for (let d = 1; d <= 31; d++) { run += daily[d]; cum[d] = run; }
    return cum;
  };
  const curCum = cumByDay(target);
  const priorCum = cumByDay(addMonths(target, -1));
  const todayDay = target === new Date().toISOString().slice(0, 7) ? new Date().getUTCDate() : 31;
  const md = daysInMonth(target);
  const dailyCumulative = [];
  for (let d = 1; d <= md; d++) {
    dailyCumulative.push({ day: d, current: d <= todayDay ? curCum[d] : null, prior: priorCum[d] || null });
  }

  const importedCount = (db.prepare('SELECT COUNT(*) AS n FROM imported_txns').get() as { n: number }).n;

  return { months, month: target, transactions: txns, byCategory, needsReview, income, spending, mortgage, totalBudget, comparison: { priorMonth, priorYearAvg }, dailyCumulative, importedCount };
}

export interface SpendingProjection {
  months: { month: string; spending: number; income: number }[]; // complete months, chronological
  monthsAnalyzed: number;          // # of complete months used for the averages (≤ 12)
  avgMonthlySpending: number;      // trailing average over monthsAnalyzed
  avgMonthlyIncome: number;
  trendPctPerYear: number;         // annualized spending trend from a linear fit (e.g. 0.04 = +4%/yr)
  byCategory: { category: string; avgMonthly: number }[]; // trailing per-category averages, desc
}

// Project recurring expenses (and income) from actual transaction history.
// Uses complete months only — the current, partial month would understate the
// average — and weights the trailing 12 months for a stable, recent estimate.
export async function getSpendingProjection(): Promise<SpendingProjection> {
  const all = await getCategorizedTransactions();
  const thisMonth = new Date().toISOString().slice(0, 7);

  // Aggregate per complete month: total spending, income, and per-category spend.
  const spendByMonth = new Map<string, number>();
  const incomeByMonth = new Map<string, number>();
  const catByMonth = new Map<string, Map<string, number>>(); // month -> category -> spend
  for (const t of all) {
    const ym = t.date.slice(0, 7);
    if (ym >= thisMonth) continue; // skip the in-progress (and any future-dated) month
    if (t.category === 'Transfers' || t.category === 'Mortgage') continue;
    if (t.category === 'Income') { incomeByMonth.set(ym, (incomeByMonth.get(ym) ?? 0) + t.amount); continue; }
    const spend = Math.max(0, -t.amount);
    if (!spend) continue;
    spendByMonth.set(ym, (spendByMonth.get(ym) ?? 0) + spend);
    const cm = catByMonth.get(ym) ?? new Map<string, number>();
    cm.set(t.category, (cm.get(t.category) ?? 0) + spend);
    catByMonth.set(ym, cm);
  }

  const allMonths = [...new Set([...spendByMonth.keys(), ...incomeByMonth.keys()])].sort();
  const months = allMonths.map(m => ({
    month: m,
    spending: Math.round(spendByMonth.get(m) ?? 0),
    income: Math.round(incomeByMonth.get(m) ?? 0),
  }));

  // Trailing window (up to 12 complete months) for the averages.
  const window = allMonths.slice(-12);
  const monthsAnalyzed = window.length;
  const avg = (vals: number[]) => (vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0);
  const avgMonthlySpending = avg(window.map(m => spendByMonth.get(m) ?? 0));
  const avgMonthlyIncome = avg(window.map(m => incomeByMonth.get(m) ?? 0));

  // Annualized spending trend via least-squares fit over the window (x in months).
  let trendPctPerYear = 0;
  if (monthsAnalyzed >= 3 && avgMonthlySpending > 0) {
    const ys = window.map(m => spendByMonth.get(m) ?? 0);
    const n = ys.length;
    const xMean = (n - 1) / 2;
    const yMean = avg(ys);
    let num = 0, den = 0;
    ys.forEach((y, x) => { num += (x - xMean) * (y - yMean); den += (x - xMean) ** 2; });
    const slopePerMonth = den ? num / den : 0; // $/month change
    trendPctPerYear = (slopePerMonth * 12) / avgMonthlySpending;
  }

  // Per-category trailing average (spend only in window months it appeared).
  const catTotals = new Map<string, number>();
  for (const m of window) for (const [cat, v] of catByMonth.get(m) ?? []) catTotals.set(cat, (catTotals.get(cat) ?? 0) + v);
  const byCategory = [...catTotals.entries()]
    .map(([category, total]) => ({ category, avgMonthly: Math.round(total / Math.max(1, monthsAnalyzed)) }))
    .filter(c => c.avgMonthly > 0)
    .sort((a, b) => b.avgMonthly - a.avgMonthly);

  return {
    months,
    monthsAnalyzed,
    avgMonthlySpending: Math.round(avgMonthlySpending),
    avgMonthlyIncome: Math.round(avgMonthlyIncome),
    trendPctPerYear: Math.round(trendPctPerYear * 1000) / 1000,
    byCategory,
  };
}

export function setMerchantRule(merchant: string, category: string) {
  ensureTables();
  const cat = (CATEGORIES as readonly string[]).includes(category) ? category : 'Other';
  getDb().prepare('INSERT OR REPLACE INTO txn_rules (merchant, category) VALUES (?, ?)').run(merchant.trim().toLowerCase().slice(0, 40), cat);
}
