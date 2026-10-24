import { getDb } from '../db/schema.js';
import { getCategorizedWithRuleMatches, type BudgetTxn, type RuleSource } from './budget.js';
import { getCategoryLabeler, getActiveCategories, type CategoryLabeler } from './categories.js';

// "Rules" review: shows the user every categorization rule, how many transactions
// each one actually DECIDES, which rules are dead weight (always out-ranked by a
// higher-priority rule, or matching nothing), and which merchants are only being
// categorized by the built-in guess — so they can confirm or correct them.
//
// Precedence (mirrors getCategorizedTransactions): exact merchant rule → first
// matching smart rule (most conditions first, ties by id) → similar-merchants
// ("base") rule → built-in guess. Imported rows may instead take the CSV's category.

export interface RuleSample { date: string; payee: string; amount: number; account: string }
export interface RuleReview {
  id: number; kind: 'merchant' | 'base' | 'smart';
  description: string; category: string;
  matched: number;       // transactions this rule DECIDED
  shadowed: number;      // transactions it matches but a higher-precedence rule decided
  total: number;         // sum of |amount| over the transactions it decided
  lastMatched: string | null;
  samples: RuleSample[]; // up to 5, most recent first
  createdAt: string;
}
export interface AutoMerchant { merchant: string; payee: string; category: string; count: number; total: number; lastDate: string }
export interface SignRuleReview { id: number; kind: 'sign' | 'sign_base'; description: string }
export interface RulesReview {
  precedence: string[];
  rules: RuleReview[];
  auto: AutoMerchant[];
  signRules: SignRuleReview[];
}

export const PRECEDENCE = [
  'Exact merchant rule',
  'Condition rules (merchant / text / amount), most specific first',
  'Similar-merchants rule',
  'Built-in guess',
];

/** The slice of a categorized transaction this module reads. */
export type RuleReviewTxn = Pick<BudgetTxn, 'id' | 'date' | 'amount' | 'payee' | 'description' | 'account' | 'merchant' | 'category' | 'ruleId' | 'ruleSource'>;

export interface RuleRow {
  id: number; kind: string; merchant: string | null; base: string | null;
  contains: string | null; amount: number | null; category: string | null; created_at: string;
}
export type { RuleSource };

const money = (n: number) => '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cents = (n: number) => Math.round(n * 100) / 100;

/** Plain-English description of a rule row. */
export function describeRule(r: Pick<RuleRow, 'kind' | 'merchant' | 'base' | 'contains' | 'amount'>): string {
  switch (r.kind) {
    case 'merchant': return `Merchant is “${r.merchant ?? ''}”`;
    case 'base': return `Merchants like “${r.base ?? ''}”`;
    case 'sign': return `Reverse the sign of “${r.merchant ?? ''}”`;
    case 'sign_base': return `Reverse the sign of merchants like “${r.base ?? ''}”`;
    case 'smart': {
      const parts: string[] = [];
      if (r.base != null) parts.push(`Merchant like “${r.base}”`);
      if (r.contains) parts.push(`${parts.length ? 't' : 'T'}ext contains “${r.contains}”`);
      if (r.amount != null) parts.push(`${parts.length ? 'a' : 'A'}mount ${money(r.amount)}`);
      return parts.join(' · ') || 'Any transaction';
    }
    default: return r.kind;
  }
}

interface Stat { matched: number; shadowed: number; total: number; last: string | null; samples: RuleReviewTxn[] }

/**
 * Pure core: tally per-rule stats from each transaction's recorded decision
 * (`ruleId` / `ruleSource`) and the full list of rules matching it (`matches`,
 * from the categorizer itself, so the two can never disagree).
 */
export function buildRulesReview(
  txns: RuleReviewTxn[], rows: RuleRow[], lab: CategoryLabeler, matches: Map<string, number[]>,
): RulesReview {
  const signRules: SignRuleReview[] = [];
  for (const r of [...rows].sort((a, b) => a.id - b.id)) {
    if (r.kind === 'sign' || r.kind === 'sign_base') signRules.push({ id: r.id, kind: r.kind, description: describeRule(r) });
  }

  const stats = new Map<number, Stat>();
  const statOf = (id: number) => stats.get(id) ?? stats.set(id, { matched: 0, shadowed: 0, total: 0, last: null, samples: [] }).get(id)!;
  const autoByMerchant = new Map<string, { latest: RuleReviewTxn; count: number; total: number; byCat: Map<string, number> }>();

  for (const t of txns) {
    if (t.ruleSource === 'auto') {
      const e = autoByMerchant.get(t.merchant) ?? autoByMerchant.set(t.merchant, { latest: t, count: 0, total: 0, byCat: new Map() }).get(t.merchant)!;
      e.count++; e.total += Math.abs(t.amount);
      e.byCat.set(t.category, (e.byCat.get(t.category) ?? 0) + 1);
      if (t.date >= e.latest.date) e.latest = t;
    }
    if (t.ruleId != null) {
      const s = statOf(t.ruleId);
      s.matched++; s.total += Math.abs(t.amount);
      if (!s.last || t.date > s.last) s.last = t.date;
      s.samples.push(t);
    }
    // Rules that match but lost to the one that decided it.
    for (const id of matches.get(t.id) ?? []) if (id !== t.ruleId && t.ruleId != null) statOf(id).shadowed++;
  }

  const kindOrder: Record<string, number> = { merchant: 0, smart: 1, base: 2 };
  const rules: RuleReview[] = [];
  for (const r of rows) {
    if (r.kind !== 'merchant' && r.kind !== 'base' && r.kind !== 'smart') continue;
    const s = stats.get(r.id) ?? { matched: 0, shadowed: 0, total: 0, last: null, samples: [] };
    rules.push({
      id: r.id, kind: r.kind, description: describeRule(r),
      category: lab.label(r.category ?? 'Miscellaneous'),
      matched: s.matched, shadowed: s.shadowed, total: cents(s.total), lastMatched: s.last,
      samples: [...s.samples].sort((a, c) => c.date.localeCompare(a.date)).slice(0, 5)
        .map(x => ({ date: x.date, payee: x.payee, amount: x.amount, account: x.account })),
      createdAt: r.created_at,
    });
  }
  rules.sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || b.matched - a.matched || a.id - b.id);

  const auto: AutoMerchant[] = [...autoByMerchant.entries()].map(([merchant, e]) => {
    const cat = [...e.byCat.entries()].sort((a, b) => b[1] - a[1] || (a[0] === e.latest.category ? -1 : 1))[0][0];
    return { merchant, payee: e.latest.payee, category: lab.label(cat), count: e.count, total: cents(e.total), lastDate: e.latest.date };
  }).sort((a, b) => b.count - a.count || b.total - a.total || a.merchant.localeCompare(b.merchant)).slice(0, 200);

  signRules.sort((a, b) => a.id - b.id);
  return { precedence: PRECEDENCE, rules, auto, signRules };
}

export async function getRulesReview(): Promise<RulesReview> {
  const db = getDb();
  const rows = db.prepare(`SELECT id, kind, merchant, base, contains, amount, category, created_at FROM rules`).all() as RuleRow[];
  const { txns, matches } = await getCategorizedWithRuleMatches();
  return buildRulesReview(txns, rows, getCategoryLabeler(), matches);
}

export type RuleMutation = { ok: true } | { ok: false; status: 400 | 404; error: string };

/** Change the category of a merchant / base / smart rule. */
export function updateRuleCategory(id: number, category: string): RuleMutation {
  const db = getDb();
  const row = db.prepare('SELECT kind FROM rules WHERE id = ?').get(id) as { kind: string } | undefined;
  if (!row) return { ok: false, status: 404, error: 'rule not found' };
  if (row.kind !== 'merchant' && row.kind !== 'base' && row.kind !== 'smart') return { ok: false, status: 400, error: 'only category rules can be changed' };
  const canon = getCategoryLabeler().canon(category.trim());
  if (!getActiveCategories().includes(canon)) return { ok: false, status: 400, error: 'unknown or inactive category' };
  db.prepare('UPDATE rules SET category = ? WHERE id = ?').run(canon, id);
  return { ok: true };
}

/** Delete any rule (category or sign). */
export function deleteRule(id: number): RuleMutation {
  const info = getDb().prepare('DELETE FROM rules WHERE id = ?').run(id);
  return info.changes ? { ok: true } : { ok: false, status: 404, error: 'rule not found' };
}
