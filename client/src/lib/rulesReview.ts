// Types for GET /api/budget/rules plus the pure helpers RulesManager uses to
// classify, filter and mask rules. Kept separate from the component so they are
// unit-testable.

export interface RuleSample { date: string; payee: string; amount: number; account: string }
export interface RuleReview {
  id: number; kind: 'merchant' | 'base' | 'smart';
  description: string; category: string;
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

const norm = (s: string) => s.trim().toLowerCase();

// Search matches the rule's description or its category; `category` is an exact
// display-label filter ('' = all).
export function filterRules(rules: RuleReview[], query: string, category: string): RuleReview[] {
  const q = norm(query);
  return rules.filter(r =>
    (!category || r.category === category) &&
    (!q || norm(r.description).includes(q) || norm(r.category).includes(q)));
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
