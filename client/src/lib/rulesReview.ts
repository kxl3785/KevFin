// Types for GET /api/budget/rules plus the pure helpers RulesManager uses to
// classify, filter and mask rules. Kept separate from the component so they are
// unit-testable.

export interface RuleSample { date: string; payee: string; amount: number; account: string }
// One condition of a rule; `value` is already human-readable. A rule applies only
// when ALL of its conditions hold.
export interface RuleCondition { field: 'merchant' | 'merchant_like' | 'text' | 'amount'; value: string }
export interface RuleReview {
  id: number; kind: 'merchant' | 'base' | 'smart';
  conditions: RuleCondition[];
  description: string; category: string; // description: plain text for aria labels

  matched: number; shadowed: number; total: number;
  lastMatched: string | null; samples: RuleSample[]; createdAt: string;
}
export interface AutoMerchant { merchant: string; payee: string; category: string; count: number; total: number; lastDate: string }
export interface SignRuleReview { id: number; kind: 'sign' | 'sign_base'; description: string }
export interface RulesReviewData { precedence: string[]; rules: RuleReview[]; auto: AutoMerchant[]; signRules: SignRuleReview[] }

export type RuleStatus = 'active' | 'shadowed' | 'unused';

// shadowed = matches transactions but a higher-priority rule always decides them;
// unused = matches nothing at all; active = decides at least one transaction.
export function ruleStatus(r: Pick<RuleReview, 'matched' | 'shadowed'>): RuleStatus {
  if (r.matched > 0) return 'active';
  return r.shadowed > 0 ? 'shadowed' : 'unused';
}

export const SHADOWED_TEXT = 'Never applies — a higher-priority rule always wins';

export const PRECEDENCE_LINE =
  'When several rules match: exact merchant → condition rules (most specific first) → similar merchants → built-in guess';

// Muted label shown before a condition's value.
export const CONDITION_LABEL: Record<RuleCondition['field'], string> = {
  merchant: 'Merchant', merchant_like: 'Merchant', text: 'Text contains', amount: 'Amount',
};

// Small tag naming what kind of rule this is. A single-condition smart rule is "If".
export function ruleTypeTag(r: Pick<RuleReview, 'kind' | 'conditions'>): string {
  if (r.kind === 'merchant') return 'Exact merchant';
  if (r.kind === 'base') return 'Similar merchants';
  return r.conditions.length >= 2 ? 'All of' : 'If';
}

const norm = (s: string) => s.trim().toLowerCase();

// Search matches the rule's description, condition values or category; `category` is an exact
// display-label filter ('' = all).
export function filterRules(rules: RuleReview[], query: string, category: string): RuleReview[] {
  const q = norm(query);
  return rules.filter(r =>
    (!category || r.category === category) &&
    (!q || norm(r.description).includes(q) || norm(r.category).includes(q) ||
      (r.conditions ?? []).some(c => norm(c.value).includes(q))));
}

export function filterAuto(auto: AutoMerchant[], query: string, category: string): AutoMerchant[] {
  const q = norm(query);
  return auto.filter(a =>
    (!category || a.category === category) &&
    (!q || norm(a.payee).includes(q) || norm(a.merchant).includes(q) || norm(a.category).includes(q)));
}

// Distinct category labels across rules and auto merchants, for the filter menu.
export function categoryOptions(data: Pick<RulesReviewData, 'rules' | 'auto'>): string[] {
  return [...new Set([...data.rules.map(r => r.category), ...data.auto.map(a => a.category)])]
    .sort((a, b) => a.localeCompare(b));
}

export const MASK = '••••';
// Money for display; `privacy` hides the figure.
export function maskMoney(n: number, privacy: boolean, fmt: (n: number) => string): string {
  return privacy ? MASK : fmt(n);
}

export const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

// ---- Organizing the list (Rules tab) -----------------------------------------

// Which kind of rule to show. 'smart' rules are shown as "Conditions".
export type RuleKindFilter = 'all' | RuleReview['kind'];
export const KIND_FILTERS: { key: RuleKindFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'merchant', label: 'Exact merchant' },
  { key: 'base', label: 'Similar merchants' },
  { key: 'smart', label: 'Conditions' },
];
export function filterByKind(rules: RuleReview[], kind: RuleKindFilter): RuleReview[] {
  return kind === 'all' ? rules : rules.filter(r => r.kind === kind);
}

export type RuleSort = 'used' | 'recent' | 'newest' | 'az';
export const SORT_OPTIONS: { key: RuleSort; label: string }[] = [
  { key: 'used', label: 'Most used' },
  { key: 'recent', label: 'Recently matched' },
  { key: 'newest', label: 'Newest' },
  { key: 'az', label: 'A–Z' },
];

// What an A–Z sort reads: the rule's first condition (the merchant or text it
// looks for), falling back to its description.
const azKey = (r: Pick<RuleReview, 'conditions' | 'description'>) => (r.conditions[0]?.value ?? r.description).toLowerCase();

// A sorted copy; ties fall back to the rule id so the order never jumps around.
// "Recently matched" puts rules that never matched last.
export function sortRules(rules: RuleReview[], sort: RuleSort): RuleReview[] {
  const byId = (a: RuleReview, b: RuleReview) => a.id - b.id;
  const cmp: Record<RuleSort, (a: RuleReview, b: RuleReview) => number> = {
    used: (a, b) => b.matched - a.matched || b.total - a.total || byId(a, b),
    recent: (a, b) => (b.lastMatched ?? '').localeCompare(a.lastMatched ?? '') || b.matched - a.matched || byId(a, b),
    newest: (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id,
    az: (a, b) => azKey(a).localeCompare(azKey(b), undefined, { sensitivity: 'base', numeric: true }) || byId(a, b),
  };
  return [...rules].sort(cmp[sort]);
}

// Rules worth a look: they decide no transaction at all, either because a
// higher-priority rule always wins (shadowed) or because nothing matches (unused).
export function needsAttention(rules: RuleReview[]): { shadowed: RuleReview[]; unused: RuleReview[] } {
  return {
    shadowed: rules.filter(r => ruleStatus(r) === 'shadowed'),
    unused: rules.filter(r => ruleStatus(r) === 'unused'),
  };
}
export const isAttention = (r: Pick<RuleReview, 'matched' | 'shadowed'>) => ruleStatus(r) !== 'active';

// Rules grouped under their category, categories A–Z, each group keeping the
// order the rules arrive in (so the chosen sort applies within every group).
export interface RuleGroup { category: string; rules: RuleReview[]; matched: number; total: number }
export function groupByCategory(rules: RuleReview[]): RuleGroup[] {
  const groups = new Map<string, RuleGroup>();
  for (const r of rules) {
    const g = groups.get(r.category) ?? { category: r.category, rules: [], matched: 0, total: 0 };
    g.rules.push(r); g.matched += r.matched; g.total += r.total;
    groups.set(r.category, g);
  }
  return [...groups.values()].sort((a, b) => a.category.localeCompare(b.category, undefined, { sensitivity: 'base' }));
}

// The saved list view (sort + grouping); anything unrecognised falls back to
// the defaults.
export interface RulesView { sort: RuleSort; grouped: boolean }
export const DEFAULT_RULES_VIEW: RulesView = { sort: 'used', grouped: true };
export function normalizeRulesView(raw: unknown): RulesView {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof RulesView, unknown>>;
  return {
    sort: SORT_OPTIONS.some(o => o.key === v.sort) ? (v.sort as RuleSort) : DEFAULT_RULES_VIEW.sort,
    grouped: typeof v.grouped === 'boolean' ? v.grouped : DEFAULT_RULES_VIEW.grouped,
  };
}
