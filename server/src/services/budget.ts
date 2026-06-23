import { getDb } from '../db/schema.js';
import { getAllTransactions } from './simplefin.js';

export type Category = string;
export interface CatDef { name: string; emoji: string }
export interface CatGroup { name: string; color: string; categories: CatDef[] }

// Single source of truth for the category taxonomy (Monarch-style: groups →
// subcategories), shared by the picker, the budget breakdown and the cash-flow
// Sankey. A curated subset tuned to typical household spending.
export const TAXONOMY: CatGroup[] = [
  { name: 'Income', color: '#22b8cf', categories: [
    { name: 'Paychecks', emoji: '💵' }, { name: 'Other Income', emoji: '💰' }, { name: 'Dividends & Capital Gains', emoji: '📈' },
  ] },
  { name: 'Housing', color: '#6c8fff', categories: [
    { name: 'Mortgage', emoji: '🏦' }, { name: 'Rent', emoji: '🏠' }, { name: 'Home Improvement', emoji: '🛠️' }, { name: 'Home Services', emoji: '🧹' },
  ] },
  { name: 'Auto & Transport', color: '#a78bfa', categories: [
    { name: 'Auto Payment', emoji: '🚗' }, { name: 'Gas', emoji: '⛽' }, { name: 'Parking & Tolls', emoji: '🅿️' }, { name: 'Taxi & Ride Shares', emoji: '🚕' },
  ] },
  { name: 'Food & Dining', color: '#f472b6', categories: [
    { name: 'Groceries', emoji: '🛒' }, { name: 'Restaurants & Bars', emoji: '🍽️' }, { name: 'Coffee Shops', emoji: '☕' },
  ] },
  { name: 'Shopping', color: '#f87171', categories: [
    { name: 'Shopping', emoji: '🛍️' }, { name: 'Clothing', emoji: '👕' }, { name: 'Electronics', emoji: '💻' },
  ] },
  { name: 'Children', color: '#fb923c', categories: [
    { name: 'Child Care', emoji: '🧸' }, { name: 'Child Activities', emoji: '🎨' },
  ] },
  { name: 'Travel & Lifestyle', color: '#38bdf8', categories: [
    { name: 'Travel & Vacation', emoji: '✈️' }, { name: 'Entertainment & Recreation', emoji: '🎬' }, { name: 'Personal', emoji: '💅' },
  ] },
  { name: 'Health & Wellness', color: '#34d399', categories: [
    { name: 'Medical', emoji: '🏥' }, { name: 'Fitness', emoji: '🏋️' },
  ] },
  { name: 'Bills & Utilities', color: '#fbbf24', categories: [
    { name: 'Gas & Electric', emoji: '⚡' }, { name: 'Water', emoji: '💧' }, { name: 'Internet & Phone', emoji: '📶' }, { name: 'Subscriptions', emoji: '🔁' },
  ] },
  { name: 'Financial', color: '#2dd4bf', categories: [
    { name: 'Taxes', emoji: '🏛️' }, { name: 'Insurance', emoji: '🛡️' }, { name: 'Financial Fees', emoji: '🧾' },
  ] },
  { name: 'Gifts & Donations', color: '#c084fc', categories: [
    { name: 'Charity', emoji: '🎗️' }, { name: 'Gifts', emoji: '🎁' },
  ] },
  { name: 'Other', color: '#94a3b8', categories: [
    { name: 'Transfers', emoji: '🔄' }, { name: 'Miscellaneous', emoji: '🏷️' },
  ] },
];

export const CATEGORIES: string[] = TAXONOMY.flatMap(g => g.categories.map(c => c.name));
const INCOME_SET = new Set(TAXONOMY.find(g => g.name === 'Income')!.categories.map(c => c.name));
const CATEGORY_GROUP: Record<string, string> = Object.fromEntries(TAXONOMY.flatMap(g => g.categories.map(c => [c.name, g.name])));
const GROUP_COLOR: Record<string, string> = Object.fromEntries(TAXONOMY.map(g => [g.name, g.color]));

export function getCategoryGroups(): CatGroup[] { return TAXONOMY; }

// Keyword rules mapping "payee + description" to a subcategory (first match wins).
const RULES: { re: RegExp; cat: Category }[] = [
  // Food & Dining
  { re: /grocery|whole foods|trader joe|safeway|kroger|costco|wal-?mart|aldi|publix|wegmans|h-?e-?b|sprouts|mitsuwa|good fortune|supermarket|food market/i, cat: 'Groceries' },
  { re: /coffee|starbucks|dunkin|peet|philz|\btea\b|boba|\bcafe\b/i, cat: 'Coffee Shops' },
  { re: /doordash|uber eats|grubhub|restaurant|mcdonald|chipotle|pizza|grill|kitchen|\bbar\b|taco|sushi|ramen|panera|chick-?fil|wendy|burger|\bdd \*|eatery|bistro|diner|\bbbq\b/i, cat: 'Restaurants & Bars' },
  // Auto & Transport
  { re: /shell|chevron|exxon|mobil|\bgas\b|fuel|quiktrip|\bqt\b|\bbp\b|\b76\b|arco|marathon|circle k|wawa|sheetz|valero|conoco/i, cat: 'Gas' },
  { re: /uber|lyft|\btaxi\b|ride ?share|metro|transit|amtrak|caltrain/i, cat: 'Taxi & Ride Shares' },
  { re: /parking|\btoll\b|garage/i, cat: 'Parking & Tolls' },
  { re: /auto ?pay|car payment|gm financial|toyota financial|honda financial|ford credit|carvana|auto loan|capital one auto/i, cat: 'Auto Payment' },
  // Housing
  { re: /home depot|lowe'?s|ace hardware|menards|hardware|\bpaint\b/i, cat: 'Home Improvement' },
  { re: /terminix|orkin|\bmaid\b|cleaning|\blawn\b|\bpest\b|plumb|\bhvac\b|roofing|landscap/i, cat: 'Home Services' },
  { re: /\brent\b|apartment|leasing|property mgmt/i, cat: 'Rent' },
  // Health & Wellness
  { re: /pharmacy|\bcvs\b|walgreens|doctor|dental|dentist|medical|clinic|hospital|\bhealth\b|optical|vision|radiology|mychart/i, cat: 'Medical' },
  { re: /\bgym\b|fitness|equinox|peloton|yoga|pilates|crossfit|lifetime/i, cat: 'Fitness' },
  // Shopping
  { re: /best buy|newegg|micro center|apple\.com|apple store|b&h photo|electronics/i, cat: 'Electronics' },
  { re: /nordstrom|macy|\bnike\b|\bgap\b|h&m|zara|uniqlo|clothing|apparel|lululemon|old navy/i, cat: 'Clothing' },
  { re: /amazon|amzn|target|ebay|etsy|\bshop\b|walmart\.com|wayfair|\bikea\b/i, cat: 'Shopping' },
  // Children
  { re: /child ?care|daycare|day care|preschool|nanny|babysit|kindercare|montessori/i, cat: 'Child Care' },
  { re: /\bkids?\b|youth|scouts|children/i, cat: 'Child Activities' },
  // Travel & Lifestyle
  { re: /airlines?|hotel|airbnb|expedia|booking\.com|marriott|hilton|\bdelta\b|united air|southwest|american airlines|car rental|hertz|enterprise rent|vacation|resort|vrbo/i, cat: 'Travel & Vacation' },
  { re: /cinema|movie|theater|amc |steam|playstation|xbox|nintendo|ticketmaster|concert|museum|\bgolf\b|recreation|spotify|netflix|hulu|disney\+?|hbo|entertainment/i, cat: 'Entertainment & Recreation' },
  { re: /salon|\bspa\b|barber|sport clips|\bhair\b|\bnail\b|beauty|cosmetic/i, cat: 'Personal' },
  // Bills & Utilities
  { re: /electric|\bpg&e\b|atmos|\bpower\b|energy company|\butility\b/i, cat: 'Gas & Electric' },
  { re: /water util|water dept|\bsewer\b|water company/i, cat: 'Water' },
  { re: /comcast|xfinity|at&t|verizon|t-mobile|internet|spectrum|\bfios\b|\bphone\b|wireless|google fiber/i, cat: 'Internet & Phone' },
  { re: /youtube ?(tv|premium)|prime video|patreon|icloud|google (storage|one)|paramount|adobe|membership|subscription|anthropic|openai|chatgpt|notion|dropbox/i, cat: 'Subscriptions' },
  // Financial
  { re: /\btax\b|\birs\b|franchise tax|treasury|h&r block|turbotax/i, cat: 'Taxes' },
  { re: /insurance|geico|state farm|allstate|progressive|\bpolicy\b|\bvault\b|metlife/i, cat: 'Insurance' },
  { re: /\bfee\b|interest charge|finance charge|service charge|overdraft|wire fee/i, cat: 'Financial Fees' },
  // Gifts & Donations
  { re: /charity|donation|red cross|goodwill|nonprofit|\bchurch\b|tithe|gofundme/i, cat: 'Charity' },
  { re: /\bgifts?\b|florist|flowers/i, cat: 'Gifts' },
];

// Income-source rules for positive amounts (first match wins; else Other Income).
const PAYCHECK_RE = /payroll|direct dep|paycheck|salary|wages|\bpay\b/i;
const DIVIDEND_RE = /dividend|capital gain|\binterest\b|\bdiv\b|reinvest/i;

const PROTECTED = new Set(['Paychecks', 'Other Income', 'Dividends & Capital Gains', 'Transfers', 'Mortgage', 'Miscellaneous']); // can't be removed

function ensureTables() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS txn_rules (merchant TEXT PRIMARY KEY, category TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS txn_base_rules (base TEXT PRIMARY KEY, category TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS budget_targets (category TEXT PRIMARY KEY, monthly_limit REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS budget_categories (name TEXT PRIMARY KEY, sort INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS imported_txns (
      id TEXT PRIMARY KEY, date TEXT NOT NULL, amount REAL NOT NULL,
      payee TEXT NOT NULL, merchant TEXT NOT NULL, account TEXT NOT NULL, category TEXT
    );
  `);
  migrateTaxonomy(db);
}

// Old (flat) category → new (Monarch-style) subcategory. Runs once to remap an
// existing install's rules, targets and active category list to the new scheme.
const TAXONOMY_MIGRATION: Record<string, string> = {
  Income: 'Other Income', Dining: 'Restaurants & Bars', Transport: 'Gas',
  'Bills & Utilities': 'Gas & Electric', Entertainment: 'Entertainment & Recreation',
  Health: 'Medical', Travel: 'Travel & Vacation', Fees: 'Financial Fees',
  Other: 'Miscellaneous', Home: 'Home Improvement',
  // Groceries, Shopping, Subscriptions, Transfers, Mortgage keep their names.
};

function migrateTaxonomy(db: ReturnType<typeof getDb>) {
  const existing = (db.prepare('SELECT name FROM budget_categories').all() as { name: string }[]).map(r => r.name);
  const done = db.prepare(`SELECT value FROM meta WHERE key = 'cat_taxonomy_v2'`).get();
  if (done) return;

  // Remap stored rules and targets from old category names to new ones.
  for (const [oldC, newC] of Object.entries(TAXONOMY_MIGRATION)) {
    db.prepare('UPDATE OR REPLACE txn_rules SET category = ? WHERE category = ?').run(newC, oldC);
    db.prepare('UPDATE OR REPLACE txn_base_rules SET category = ? WHERE category = ?').run(newC, oldC);
    db.prepare('UPDATE OR REPLACE budget_targets SET category = ? WHERE category = ?').run(newC, oldC);
  }

  // Rebuild the active category list to the new taxonomy, preserving any
  // user-added custom categories that aren't part of either scheme.
  const oldScheme = new Set([...Object.keys(TAXONOMY_MIGRATION), 'Groceries', 'Shopping', 'Subscriptions', 'Transfers', 'Mortgage']);
  const newSet = new Set(CATEGORIES);
  const customs = existing.filter(n => !oldScheme.has(n) && !newSet.has(n));
  db.prepare('DELETE FROM budget_categories').run();
  const ins = db.prepare('INSERT OR IGNORE INTO budget_categories (name, sort) VALUES (?, ?)');
  CATEGORIES.forEach((c, i) => ins.run(c, i));
  customs.forEach((c, i) => ins.run(c, CATEGORIES.length + i));

  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('cat_taxonomy_v2', '1')`).run();
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
  db.prepare('DELETE FROM txn_base_rules WHERE category = ?').run(name);
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

// A normalised "base" for a merchant: strips store numbers, reference ids,
// punctuation and boilerplate words so variants of the same merchant collapse
// together (e.g. "SHELL OIL #1234" and "Shell Oil 56" → "shell oil"). Used to
// propagate a manual category to other transactions from a similar merchant.
const BASE_NOISE = /\b(the|a|an|llc|inc|co|corp|ltd|store|shop|pos|debit|credit|card|purchase|payment|us|usa|com|online|intl)\b/g;
function merchantBase(merchant: string): string {
  return merchant
    .toLowerCase()
    .replace(/[*#].*$/, ' ')   // drop ref/id tail after * or #
    .replace(/\d+/g, ' ')      // drop digit runs (store numbers, dates)
    .replace(BASE_NOISE, ' ')
    .replace(/[^a-z ]+/g, ' ') // strip remaining non-letters
    .replace(/\s+/g, ' ')
    .trim();
}
// Only treat a base as specific enough to sweep similar merchants when it still
// carries real signal after normalisation (avoids over-matching on a stub).
function usableBase(base: string): boolean {
  return base.length >= 3;
}

const TRANSFER_RE = /payment thank you|autopay|online payment|\btransfer\b|zelle|venmo|cash app|moneyline|brokerage services|fid bkg|robinhood money|money payment|bilt card|card pmt|card payment|^\s*to (brokerage|chase|personal|savings|checking|bilt|wells|bank)/i;

const MORTGAGE_RE = /\bmortgage\b|home loan|\bheloc\b|property payment|home equity|loancare|mr\.?\s*cooper|pennymac|quicken loan|rocket mortgage|newrez|nationstar|shellpoint|phh mortgage|sps servicing|carrington mortgage/i;

// Liability accounts — credit cards, loans, mortgages, lines of credit. A
// POSITIVE amount here is a payment/credit (money coming IN to settle the
// balance), never real income, so it must not inflate income.
const LIABILITY_ACCT_RE = /mortgage|home ?loan|\bheloc\b|line of credit|\bloan\b|credit card|\bvisa\b|mastercard|\bamex\b|discover|sapphire|freedom|venture|palladium|signature|\bcard\b/i;

export function autoCategory(payee: string, description: string, amount: number): Category {
  const text = `${payee} ${description}`;
  if (TRANSFER_RE.test(text)) return 'Transfers';
  if (MORTGAGE_RE.test(text)) return 'Mortgage';
  if (amount > 0) {
    if (PAYCHECK_RE.test(text)) return 'Paychecks';
    if (DIVIDEND_RE.test(text)) return 'Dividends & Capital Gains';
    return 'Other Income';
  }
  for (const r of RULES) if (r.re.test(text)) return r.cat;
  return 'Miscellaneous';
}

export interface BudgetTxn {
  id: string; date: string; amount: number; description: string; payee: string;
  account: string; merchant: string; category: Category; suggested: Category;
}

// Auto-detect internal transfers / debt payments the keyword rules miss: an
// ambiguous (or keyword-flagged) expense matched by an equal, opposite credit in
// a *different* account within a few days is almost certainly money moving
// between accounts — not spending or income. Flags BOTH legs as Transfers so
// neither inflates spending nor income. User-categorized txns are left alone.
function detectTransferPairs(all: BudgetTxn[], ruledIds: Set<string>): number {
  const WINDOW_MS = 4 * 86400_000;
  const day = (d: string) => Date.parse(d + 'T00:00:00Z');
  const byMag = new Map<string, BudgetTxn[]>();
  for (const t of all) {
    const k = Math.abs(t.amount).toFixed(2);
    (byMag.get(k) ?? byMag.set(k, []).get(k)!).push(t);
  }
  const consumed = new Set<string>();
  // An expense leg: an outflow that's either already keyword-flagged Transfers or
  // simply uncategorized. A credit leg: an inflow that's a transfer or unlabeled.
  const isExpenseLeg = (t: BudgetTxn) => !ruledIds.has(t.id) && t.amount < 0 && (t.category === 'Transfers' || t.category === 'Miscellaneous');
  const isCreditLeg = (t: BudgetTxn) => !ruledIds.has(t.id) && t.amount > 0 && (t.category === 'Transfers' || t.category === 'Other Income');
  let flagged = 0;
  for (const t of all) {
    if (consumed.has(t.id) || !isExpenseLeg(t) || Math.abs(t.amount) < 1) continue;
    const cands = byMag.get(Math.abs(t.amount).toFixed(2)) ?? [];
    const td = day(t.date);
    const match = cands.find(o => o.id !== t.id && !consumed.has(o.id) && o.account !== t.account && isCreditLeg(o) && Math.abs(day(o.date) - td) <= WINDOW_MS);
    if (match) {
      if (t.category !== 'Transfers') flagged++;
      if (match.category !== 'Transfers') flagged++;
      t.category = 'Transfers';
      match.category = 'Transfers';
      consumed.add(t.id);
      consumed.add(match.id);
    }
  }
  return flagged;
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
  // Base rules categorize "similar" merchants (same normalised base) — applied
  // when there's no exact merchant rule. See merchantBase / applyCategoryRule.
  const baseRules = new Map(
    (db.prepare('SELECT base, category FROM txn_base_rules').all() as { base: string; category: string }[])
      .map(r => [r.base, r.category as Category])
  );

  // Budgeting is about cash flow — exclude brokerage trades (buys/sells aren't spending).
  const acctCat = new Map(
    (db.prepare('SELECT id, category FROM accounts').all() as { id: string; category: string }[])
      .map(a => [a.id, a.category])
  );
  const activeSet = new Set(getActiveCategories());
  const ruledIds = new Set<string>(); // txns whose category the user set explicitly
  const sfRaw = (await getAllTransactions()).filter(t => acctCat.get(t.accountId) !== 'brokerage');
  const sfAll: BudgetTxn[] = sfRaw.map(t => {
    const m = merchantKey(t.payee, t.description);
    const date = new Date(t.posted * 1000).toISOString().slice(0, 10);
    const suggested = autoCategory(t.payee, t.description, t.amount); // rule-based guess, pre-override
    const ruled = overrides.get(m) ?? baseRules.get(merchantBase(m));
    if (ruled != null) ruledIds.add(t.id);
    let category = ruled ?? suggested;
    // Positive amounts in a liability account are payments, not income.
    if (ruled == null && t.amount > 0 && INCOME_SET.has(category) &&
        (acctCat.get(t.accountId) === 'credit' || LIABILITY_ACCT_RE.test(t.accountName))) {
      category = 'Transfers';
    }
    if (!activeSet.has(category)) category = 'Miscellaneous';
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
    const ruled = overrides.get(r.merchant) ?? baseRules.get(merchantBase(r.merchant));
    if (ruled != null) ruledIds.add(r.id);
    let cat = ruled as string | undefined;
    if (!cat && r.category) cat = [...activeSet].find(a => a.toLowerCase() === r.category!.toLowerCase());
    if (!cat) cat = suggested;
    // Positive amounts in a liability account are payments, not income.
    if (ruled == null && r.amount > 0 && INCOME_SET.has(cat) && LIABILITY_ACCT_RE.test(r.account)) cat = 'Transfers';
    if (!activeSet.has(cat)) cat = 'Miscellaneous';
    importedAll.push({ id: r.id, date: r.date, amount: r.amount, description: r.payee, payee: r.payee, account: r.account, merchant: r.merchant, category: cat as Category, suggested });
  }
  const all = [...sfAll, ...importedAll];
  detectTransferPairs(all, ruledIds); // flag matched cross-account transfer legs
  return all;
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
    if (INCOME_SET.has(t.category) || t.category === 'Transfers' || t.category === 'Mortgage') continue;
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
    if (INCOME_SET.has(t.category)) { income += t.amount; continue; }
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

  const needsReview = txns.filter(t => t.category === 'Miscellaneous' && t.amount < 0);
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
      if (t.date.slice(0, 7) !== monthKey || INCOME_SET.has(t.category) || t.category === 'Transfers' || t.category === 'Mortgage') continue;
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
    if (INCOME_SET.has(t.category)) { incomeByMonth.set(ym, (incomeByMonth.get(ym) ?? 0) + t.amount); continue; }
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

/**
 * Categorize a merchant. `scope: 'one'` sets only the exact-merchant rule (every
 * transaction from that merchant); `scope: 'all'` additionally writes a base rule
 * that propagates to "similar" merchants (same normalised base — e.g. different
 * store numbers/punctuation of the same brand), existing and future. The
 * exact-merchant rule always wins over the base rule. Either way returns how many
 * OTHER transactions a base rule would cover, so the UI can offer/estimate the
 * "apply to all" action. Validates against the active category set.
 */
export async function applyCategoryRule(
  merchant: string,
  category: string,
  scope: 'one' | 'all' = 'all',
): Promise<{ similarTxns: number; similarMerchants: number; base: string }> {
  ensureTables();
  const db = getDb();
  const cat = new Set(getActiveCategories()).has(category) ? category : 'Miscellaneous';
  const key = merchant.trim().toLowerCase().slice(0, 40);

  db.prepare('INSERT OR REPLACE INTO txn_rules (merchant, category) VALUES (?, ?)').run(key, cat);

  const base = merchantBase(key);
  if (!usableBase(base)) return { similarTxns: 0, similarMerchants: 0, base: '' };
  if (scope === 'all') {
    db.prepare('INSERT OR REPLACE INTO txn_base_rules (base, category) VALUES (?, ?)').run(base, cat);
  }

  // Count the other current transactions a base rule covers (excluding merchants
  // that carry their own explicit exact rule, and the merchant we just set).
  const ruled = new Set(
    (db.prepare('SELECT merchant FROM txn_rules').all() as { merchant: string }[]).map(r => r.merchant)
  );
  const txns = await getCategorizedTransactions();
  const merchants = new Set<string>();
  let similarTxns = 0;
  for (const t of txns) {
    if (t.merchant === key || ruled.has(t.merchant)) continue;
    if (merchantBase(t.merchant) !== base) continue;
    merchants.add(t.merchant);
    similarTxns++;
  }
  return { similarTxns, similarMerchants: merchants.size, base };
}

// --- Cash-flow Sankey -------------------------------------------------------
// A 4-tier money-flow graph: income sources → Income → spending groups + Savings
// → categories. Groups reuse the same taxonomy as the category picker. Transfers
// (internal moves) are excluded; Mortgage IS included since it's real cash out.

export type NodeFilter =
  | { type: 'income' }
  | { type: 'source'; value: string }   // income source payee, or '__other'
  | { type: 'group'; value: string }
  | { type: 'category'; value: string }
  | { type: 'savings' };
export interface SankeyNode { name: string; color: string; col: number; kind: 'source' | 'hub' | 'savings' | 'group' | 'category'; filter: NodeFilter }
export interface SankeyLink { source: number; target: number; value: number }
export interface CashFlow {
  range: string; label: string;
  income: number; spending: number; savings: number;
  nodes: SankeyNode[]; links: SankeyLink[];
}
export interface CashTxn { id: string; date: string; payee: string; merchant: string; account: string; category: string; amount: number }

const INCOME_COLOR = GROUP_COLOR['Income'] ?? '#22b8cf';
const SAVINGS_COLOR = '#4ade80';
// Expense category → display group + group colors are derived from TAXONOMY
// (CATEGORY_GROUP / GROUP_COLOR, defined at the top). Unmapped categories fall
// into the "Other" group.

function rangeBounds(range: string): { start: string | null; label: string } {
  const now = new Date();
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  const iso = (dt: Date) => dt.toISOString().slice(0, 10);
  switch (range) {
    case '1m': return { start: iso(new Date(Date.UTC(y, m, 1))), label: 'This month' };
    case '3m': return { start: iso(new Date(Date.UTC(y, m - 2, 1))), label: 'Last 3 months' };
    case '6m': return { start: iso(new Date(Date.UTC(y, m - 5, 1))), label: 'Last 6 months' };
    case 'ytd': return { start: iso(new Date(Date.UTC(y, 0, 1))), label: 'Year to date' };
    case '12m': return { start: iso(new Date(Date.UTC(y, m - 11, 1))), label: 'Last 12 months' };
    default: return { start: null, label: 'All time' };
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function getCashFlow(range = '12m'): Promise<CashFlow> {
  ensureTables();
  const { start, label } = rangeBounds(range);
  const all = await getCategorizedTransactions();
  const txns = all.filter(t => !start || t.date >= start);

  // Income grouped by merchant (displayed via payee); expenses netted per category.
  const incomeByMerchant = new Map<string, { amount: number; payee: string }>();
  const catSpend = new Map<string, number>();
  let income = 0;
  for (const t of txns) {
    if (t.category === 'Transfers') continue;            // internal moves
    if (INCOME_SET.has(t.category)) {
      if (t.amount > 0) {
        income += t.amount;
        const e = incomeByMerchant.get(t.merchant) ?? { amount: 0, payee: t.payee || t.merchant };
        e.amount += t.amount;
        incomeByMerchant.set(t.merchant, e);
      }
      continue;
    }
    const spend = Math.max(0, -t.amount);               // refunds net down the category
    if (spend) catSpend.set(t.category, (catSpend.get(t.category) ?? 0) + spend);
  }
  const spending = [...catSpend.values()].reduce((a, b) => a + b, 0);
  const savings = income - spending;

  const nodes: SankeyNode[] = [];
  const idx = new Map<string, number>();
  const links: SankeyLink[] = [];
  const add = (key: string, name: string, color: string, col: number, kind: SankeyNode['kind'], filter: NodeFilter) => {
    const existing = idx.get(key);
    if (existing != null) return existing;
    const i = nodes.length;
    nodes.push({ name, color, col, kind, filter });
    idx.set(key, i);
    return i;
  };

  const incomeIdx = add('hub', 'Income', INCOME_COLOR, 1, 'hub', { type: 'income' });

  // Tier 0: income sources — top 6 merchants, remainder pooled into "Other income".
  const sources = [...incomeByMerchant.values()].sort((a, b) => b.amount - a.amount);
  const TOP = 6;
  for (const s of sources.slice(0, TOP)) {
    const si = add('src:' + s.payee, s.payee, INCOME_COLOR, 0, 'source', { type: 'source', value: s.payee });
    links.push({ source: si, target: incomeIdx, value: round2(s.amount) });
  }
  const restAmt = sources.slice(TOP).reduce((s, x) => s + x.amount, 0);
  if (restAmt > 0) {
    const si = add('src:__other', 'Other income', INCOME_COLOR, 0, 'source', { type: 'source', value: '__other' });
    links.push({ source: si, target: incomeIdx, value: round2(restAmt) });
  }

  // Savings (only when income exceeds spending). Col 2 — a sibling of the
  // spending groups, fed straight from Income, so it flows out in a single hop
  // rather than jumping across the leaf column.
  if (savings > 0) {
    const sv = add('savings', 'Savings', SAVINGS_COLOR, 2, 'savings', { type: 'savings' });
    links.push({ source: incomeIdx, target: sv, value: round2(savings) });
  }

  // Tier 2 → Tier 3: spending groups → their categories, largest first.
  const groupCats = new Map<string, Map<string, number>>();
  for (const [c, v] of catSpend) {
    if (v <= 0) continue;
    const g = CATEGORY_GROUP[c] ?? 'Other';
    const inner = groupCats.get(g) ?? new Map<string, number>();
    inner.set(c, v);
    groupCats.set(g, inner);
  }
  const groupsOrdered = [...groupCats.entries()]
    .map(([g, inner]) => ({ g, inner, total: [...inner.values()].reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.total - a.total);
  for (const { g, inner, total } of groupsOrdered) {
    const color = GROUP_COLOR[g] ?? '#94a3b8';
    const gi = add('grp:' + g, g, color, 2, 'group', { type: 'group', value: g });
    links.push({ source: incomeIdx, target: gi, value: round2(total) });
    for (const [c, v] of [...inner.entries()].sort((a, b) => b[1] - a[1])) {
      const ci = add('cat:' + c, c, color, 3, 'category', { type: 'category', value: c });
      links.push({ source: gi, target: ci, value: round2(v) });
    }
  }

  return { range, label, income: round2(income), spending: round2(spending), savings: round2(savings), nodes, links };
}

// Transactions behind a clicked Sankey node/band, for the drill-down table.
export async function getCashFlowTransactions(range: string, type: string, value?: string): Promise<{ label: string; total: number; txns: CashTxn[] }> {
  ensureTables();
  const { start } = rangeBounds(range);
  const all = await getCategorizedTransactions();
  const inRange = all.filter(t => (!start || t.date >= start) && t.category !== 'Transfers');
  const incomeTx = inRange.filter(t => INCOME_SET.has(t.category) && t.amount > 0);

  let txns = inRange;
  let label = '';
  if (type === 'savings') {
    return { label: 'Savings', total: 0, txns: [] }; // savings is income − spending, not a txn set
  } else if (type === 'income') {
    txns = incomeTx; label = 'Income';
  } else if (type === 'source') {
    if (value === '__other') {
      const byMerchant = new Map<string, { amount: number; payee: string }>();
      for (const t of incomeTx) {
        const e = byMerchant.get(t.merchant) ?? { amount: 0, payee: t.payee || t.merchant };
        e.amount += t.amount; byMerchant.set(t.merchant, e);
      }
      const top = new Set([...byMerchant.values()].sort((a, b) => b.amount - a.amount).slice(0, 6).map(x => x.payee));
      txns = incomeTx.filter(t => !top.has(t.payee || t.merchant)); label = 'Other income';
    } else {
      txns = incomeTx.filter(t => (t.payee || t.merchant) === value); label = value ?? 'Income source';
    }
  } else if (type === 'group') {
    txns = inRange.filter(t => !INCOME_SET.has(t.category) && (CATEGORY_GROUP[t.category] ?? 'Other') === value); label = value ?? 'Group';
  } else if (type === 'category') {
    txns = inRange.filter(t => t.category === value); label = value ?? 'Category';
  } else {
    txns = [];
  }

  txns = txns.slice().sort((a, b) => b.date.localeCompare(a.date));
  const total = round2(txns.reduce((s, t) => s + Math.abs(t.amount), 0));
  return {
    label, total,
    txns: txns.map(t => ({ id: t.id, date: t.date, payee: t.payee, merchant: t.merchant, account: t.account, category: t.category, amount: t.amount })),
  };
}
