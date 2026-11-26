// Composable rule conditions — merchant, exact amount, description text — shared by
// the "Apply to similar transactions?" popup (RuleSuggestModal) and Quick review's
// rule chips (ReviewWizard). A transaction must match ALL ticked conditions (AND),
// so combining them narrows the rule instead of the over-broad behaviour of
// separate (OR) rules. The server proposes the conditions (/rule/suggest), counts a
// combination live (/rule/count) and stores the rule (/rule/smart, /review/apply).

export interface RuleSpec { base?: string; contains?: string; amount?: number }
export interface RuleCondition { key: string; kind: 'merchant' | 'amount' | 'text'; label: string; spec: RuleSpec; count: number }
// What the conditions are suggested from. `category` is optional: the card asks
// before one is picked.
export interface RuleSubject { merchant: string; payee: string; description?: string; amount: number; category?: string }

// Merge the specs of the selected conditions into one (each kind owns a distinct
// field, and only one text condition can be active at a time).
export function combinedSpec(conds: readonly RuleCondition[], sel: ReadonlySet<string>): RuleSpec {
  const spec: RuleSpec = {};
  for (const c of conds) if (sel.has(c.key)) Object.assign(spec, c.spec);
  return spec;
}

export const isEmptySpec = (spec: RuleSpec) => !('base' in spec) && !('contains' in spec) && !('amount' in spec);

// The merchant condition starts ticked: today's default rule ("this payee, and
// future ones"). Amount and text are opt-in narrowing/widening.
export function defaultSelection(conds: readonly RuleCondition[]): Set<string> {
  return new Set(conds.filter(c => c.kind === 'merchant').map(c => c.key));
}

// Tick or untick one condition. Ticking a text condition unticks any other text
// condition (one text match per rule).
export function toggleCondition(conds: readonly RuleCondition[], sel: ReadonlySet<string>, key: string): Set<string> {
  const n = new Set(sel);
  if (n.has(key)) { n.delete(key); return n; }
  const c = conds.find(x => x.key === key);
  if (!c) return n;
  if (c.kind === 'text') for (const o of conds) if (o.kind === 'text') n.delete(o.key);
  n.add(key);
  return n;
}

// Whether a rule could usefully carry forward, so the popup is worth showing: a
// merchant condition matches this payee now AND every future transaction from it,
// so it qualifies even at count 1. Text conditions qualify once they reach beyond
// this single transaction. Amount alone is too broad to interrupt on.
export function worthOffering(conds: readonly RuleCondition[]): boolean {
  return conds.some(c => c.kind === 'merchant' || (c.kind === 'text' && c.count >= 2));
}

// Privacy mode masks the amounts in condition labels ("Amount is exactly $92.03"),
// like every other figure.
export function maskAmounts(label: string, privacy: boolean): string {
  return privacy ? label.replace(/[−-]?\$\s?[\d,]+(\.\d+)?/g, '••••••') : label;
}

// A shorter label for a chip on the card: the popup's sentence without the verb.
export function chipLabel(c: RuleCondition): string {
  return c.label
    .replace(/^Merchant is /, 'Payee ')
    .replace(/^Amount is exactly /, 'Amount ')
    .replace(/^Text contains /, 'Contains ');
}
