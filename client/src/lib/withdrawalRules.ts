// Retirement spending rules for the Forecast. Pure and dependency-free: the
// simulation calls stepWithdrawalRule once per retired year, in both the Monte
// Carlo and the historical-backtest return models.
//
// Only the FLEXIBLE part of spending moves: the plan's everyday annual spending
// (less the cost of kids who are dependent today, which is not cut). Mortgage and
// home costs, kids, college and life events always stay as planned. A rule turns
// that year's planned flexible amount (already grown with inflation) into what is
// actually spent:
//   - fixed: spend the plan every year (inflation-adjusted). The original model.
//   - guardrails (Guyton–Klinger style): the "spending rate" is this year's
//     flexible spending ÷ the savings balance. Its value in the first retired
//     year is the starting rate. Each later year, if the rate has climbed more
//     than `upper` above the starting rate (e.g. 20% → a 5% start becomes 6%),
//     spending is trimmed by `cut`; if it has fallen more than `lower` below it,
//     spending is raised by `raise`. Trims and raises stick: next year's plan
//     carries them forward (still inflation-adjusted).
//   - percentOfPortfolio: spend `rate` × the savings balance each year, kept
//     between optional `floor` and `ceiling` multiples of the planned amount.
// These are estimates for planning, not advice.

export type WithdrawalRuleKind = 'fixed' | 'guardrails' | 'percentOfPortfolio';

export interface GuardrailSettings {
  upper: number; // trim when the rate is this fraction ABOVE the starting rate (0.2 = 20%)
  lower: number; // raise when the rate is this fraction BELOW the starting rate
  cut: number;   // trim size (0.1 = 10%)
  raise: number; // raise size
}
export interface PercentSettings {
  rate: number;           // share of savings spent each year (0.04 = 4%)
  floor: number | null;   // never below this multiple of the planned amount (0.8 = 80%); null = no floor
  ceiling: number | null; // never above this multiple; null = no ceiling
}
export interface WithdrawalRule {
  kind: WithdrawalRuleKind;
  guardrails: GuardrailSettings;
  percent: PercentSettings;
}

export const DEFAULT_GUARDRAILS: GuardrailSettings = { upper: 0.2, lower: 0.2, cut: 0.1, raise: 0.1 };
export const DEFAULT_PERCENT: PercentSettings = { rate: 0.04, floor: null, ceiling: null };
export const DEFAULT_WITHDRAWAL_RULE: WithdrawalRule = { kind: 'fixed', guardrails: DEFAULT_GUARDRAILS, percent: DEFAULT_PERCENT };

// Allowed ranges (the UI uses the same bounds).
export const RULE_LIMITS = {
  band: [0.05, 0.5] as const,        // guardrail upper / lower
  step: [0.01, 0.5] as const,        // trim / raise size
  rate: [0.01, 0.15] as const,       // percent-of-savings rate
  floor: [0.1, 1] as const,          // floor, × planned
  ceiling: [1, 3] as const,          // ceiling, × planned
};

const num = (v: unknown, [lo, hi]: readonly [number, number], dflt: number) =>
  (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt);
const optNum = (v: unknown, range: readonly [number, number], dflt: number | null) =>
  (v === null ? null : typeof v === 'number' && Number.isFinite(v) ? Math.min(range[1], Math.max(range[0], v)) : dflt);

// Repair a stored rule field by field (older saves, hand edits, junk) — anything
// missing or out of range falls back to the defaults, so a broken save can never
// reach the simulation.
export function normalizeWithdrawalRule(raw: unknown): WithdrawalRule {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const g = (r.guardrails && typeof r.guardrails === 'object' ? r.guardrails : {}) as Record<string, unknown>;
  const p = (r.percent && typeof r.percent === 'object' ? r.percent : {}) as Record<string, unknown>;
  const kind: WithdrawalRuleKind = r.kind === 'guardrails' || r.kind === 'percentOfPortfolio' ? r.kind : 'fixed';
  const floor = optNum(p.floor, RULE_LIMITS.floor, DEFAULT_PERCENT.floor);
  let ceiling = optNum(p.ceiling, RULE_LIMITS.ceiling, DEFAULT_PERCENT.ceiling);
  if (floor != null && ceiling != null && ceiling < floor) ceiling = floor;
  return {
    kind,
    guardrails: {
      upper: num(g.upper, RULE_LIMITS.band, DEFAULT_GUARDRAILS.upper),
      lower: num(g.lower, RULE_LIMITS.band, DEFAULT_GUARDRAILS.lower),
      cut: num(g.cut, RULE_LIMITS.step, DEFAULT_GUARDRAILS.cut),
      raise: num(g.raise, RULE_LIMITS.step, DEFAULT_GUARDRAILS.raise),
    },
    percent: { rate: num(p.rate, RULE_LIMITS.rate, DEFAULT_PERCENT.rate), floor, ceiling },
  };
}

// The rule's memory between years of one simulated path.
export interface RuleState {
  startRate: number | null; // guardrails: flexible spending ÷ savings in the first retired year
  factor: number;           // guardrails: accumulated trims/raises (1 = as planned)
}
export const initialRuleState = (): RuleState => ({ startRate: null, factor: 1 });

// One retired year. `planned` is this year's planned flexible spending (nominal,
// ≥ 0) and `savings` the spendable savings balance at the time it is drawn.
// Returns what is actually spent (never negative, never NaN) and the new state.
export function stepWithdrawalRule(rule: WithdrawalRule, state: RuleState, planned: number, savings: number): { spend: number; state: RuleState } {
  const plan = Number.isFinite(planned) ? Math.max(0, planned) : 0;
  const bal = Number.isFinite(savings) ? savings : 0;
  if (rule.kind === 'fixed' || plan <= 0) return { spend: plan, state };

  if (rule.kind === 'percentOfPortfolio') {
    const { rate, floor, ceiling } = rule.percent;
    let spend = rate * Math.max(0, bal);
    if (floor != null) spend = Math.max(spend, floor * plan);
    if (ceiling != null) spend = Math.min(spend, ceiling * plan);
    return { spend: Math.max(0, spend), state };
  }

  // Guardrails.
  const { upper, lower, cut, raise } = rule.guardrails;
  if (state.startRate == null) {
    // First retired year: spend the plan and remember the starting rate. With no
    // savings there is no rate to anchor to yet, so wait for a year that has one.
    if (bal <= 0) return { spend: plan * state.factor, state };
    return { spend: plan * state.factor, state: { startRate: (plan * state.factor) / bal, factor: state.factor } };
  }
  let factor = state.factor;
  // Savings gone: the rate is unbounded, so trim (strictly above the upper rail).
  const rate = bal > 0 ? (plan * factor) / bal : Infinity;
  if (rate > state.startRate * (1 + upper)) factor *= 1 - cut;
  else if (rate < state.startRate * (1 - lower)) factor *= 1 + raise;
  return { spend: plan * factor, state: { startRate: state.startRate, factor } };
}

// --- Percent fields in the picker ----------------------------------------------
// The text a rule field shows for a fraction (0.123 → "12.3").
export const pctText = (x: number) => String(Math.round(x * 1000) / 10);

// What a percent field does when the user leaves it: the text to show afterwards
// (always the value kept, so a number clamped back to the saved value is not left
// on screen) and whether to commit `value`. Nothing is committed when the shown
// value doesn't change, so tabbing through a field re-runs nothing. Unparseable
// text restores the saved value; an empty optional field means "none" (null).
export function resolvePctInput(text: string, saved: number | null, lo: number, hi: number, optional: boolean):
  { text: string; commit: boolean; value: number | null } {
  const t = text.trim();
  if (t === '' && optional) return { text: '', commit: saved != null, value: null };
  const n = Number(t);
  if (t === '' || !Number.isFinite(n)) return { text: saved == null ? '' : pctText(saved), commit: false, value: saved };
  const v = Math.min(hi, Math.max(lo, n / 100));
  return { text: pctText(v), commit: saved == null || pctText(v) !== pctText(saved), value: v };
}

// One plain sentence per rule, for the picker.
export function describeRule(rule: WithdrawalRule): string {
  const p = (x: number) => `${Math.round(x * 100)}%`;
  switch (rule.kind) {
    case 'guardrails': {
      const g = rule.guardrails;
      return `Start with your planned spending. If a bad stretch pushes the share of savings you spend ${p(g.upper)} above where it started, spend ${p(g.cut)} less; if a good stretch drops it ${p(g.lower)} below, spend ${p(g.raise)} more.`;
    }
    case 'percentOfPortfolio': {
      const q = rule.percent;
      const bounds = q.floor != null && q.ceiling != null ? `, kept between ${p(q.floor)} and ${p(q.ceiling)} of your plan`
        : q.floor != null ? `, never below ${p(q.floor)} of your plan`
        : q.ceiling != null ? `, never above ${p(q.ceiling)} of your plan` : '';
      return `Each year, spend ${(Math.round(q.rate * 1000) / 10)}% of what your savings are worth${bounds}.`;
    }
    default:
      return 'Spend the same amount every year, raised with inflation, whatever the markets do.';
  }
}

export const RULE_LABELS: Record<WithdrawalRuleKind, string> = {
  fixed: 'Steady',
  guardrails: 'Guardrails',
  percentOfPortfolio: 'Share of savings',
};
