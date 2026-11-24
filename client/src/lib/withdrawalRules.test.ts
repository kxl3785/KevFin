import { describe, it, expect } from 'vitest';
import {
  stepWithdrawalRule, initialRuleState, normalizeWithdrawalRule, describeRule, resolvePctInput, RULE_LIMITS,
  DEFAULT_WITHDRAWAL_RULE, DEFAULT_GUARDRAILS, DEFAULT_PERCENT, type WithdrawalRule,
} from './withdrawalRules.ts';

const guard = (over: Partial<WithdrawalRule['guardrails']> = {}): WithdrawalRule =>
  ({ ...DEFAULT_WITHDRAWAL_RULE, kind: 'guardrails', guardrails: { ...DEFAULT_GUARDRAILS, ...over } });
const pctRule = (over: Partial<WithdrawalRule['percent']> = {}): WithdrawalRule =>
  ({ ...DEFAULT_WITHDRAWAL_RULE, kind: 'percentOfPortfolio', percent: { ...DEFAULT_PERCENT, ...over } });

describe('fixed rule', () => {
  it('always spends the plan and keeps its state', () => {
    const s = initialRuleState();
    const r = stepWithdrawalRule(DEFAULT_WITHDRAWAL_RULE, s, 40000, 10);
    expect(r.spend).toBe(40000);
    expect(r.state).toBe(s);
  });
  it('never returns a negative or NaN amount', () => {
    expect(stepWithdrawalRule(DEFAULT_WITHDRAWAL_RULE, initialRuleState(), -5, 100).spend).toBe(0);
    expect(stepWithdrawalRule(DEFAULT_WITHDRAWAL_RULE, initialRuleState(), NaN, 100).spend).toBe(0);
  });
});

describe('guardrails rule', () => {
  it('anchors the starting rate in the first retired year and spends the plan', () => {
    const r = stepWithdrawalRule(guard(), initialRuleState(), 40000, 1_000_000);
    expect(r.spend).toBe(40000);
    expect(r.state.startRate).toBeCloseTo(0.04, 12);
    expect(r.state.factor).toBe(1);
  });

  it('trims 10% when the rate is more than 20% above the start', () => {
    // Start 4%. Savings fall to 800k → 40k / 800k = 5% > 4.8% upper rail → 36k.
    const s1 = stepWithdrawalRule(guard(), initialRuleState(), 40000, 1_000_000).state;
    const r = stepWithdrawalRule(guard(), s1, 40000, 800_000);
    expect(r.spend).toBeCloseTo(36000, 9);
    expect(r.state.factor).toBeCloseTo(0.9, 12);
    // The trim sticks: next year (inflation lifted the plan to 41,200) at a calm rate.
    const r2 = stepWithdrawalRule(guard(), r.state, 41200, 900_000); // 37,080 / 900k = 4.12%: inside the rails
    expect(r2.spend).toBeCloseTo(41200 * 0.9, 9);
  });

  it('raises 10% when the rate is more than 20% below the start', () => {
    const s1 = stepWithdrawalRule(guard(), initialRuleState(), 40000, 1_000_000).state;
    const r = stepWithdrawalRule(guard(), s1, 40000, 1_300_000); // 3.08% < 3.2%
    expect(r.spend).toBeCloseTo(44000, 9);
  });

  it('does nothing exactly at a rail (strict comparisons)', () => {
    const s1 = { startRate: 0.04, factor: 1 };
    // A rate sitting on a rail (start 4% → rails at 4.8% and 3.2%) does not move spending.
    expect(stepWithdrawalRule(guard(), s1, 48, 1000).spend).toBe(48);       // 4.8% = 4% × 1.2
    expect(stepWithdrawalRule(guard(), s1, 32, 1000).spend).toBe(32);       // 3.2% = 4% × 0.8
  });

  it('uses the edited rails and step sizes', () => {
    const rule = guard({ upper: 0.1, cut: 0.25 });
    const s1 = { startRate: 0.04, factor: 1 };
    expect(stepWithdrawalRule(rule, s1, 45, 1000).spend).toBeCloseTo(33.75, 9); // 4.5% > 4.4% → −25%
  });

  it('waits for savings before anchoring, and trims once savings are gone', () => {
    const r0 = stepWithdrawalRule(guard(), initialRuleState(), 30000, 0);
    expect(r0.spend).toBe(30000);
    expect(r0.state.startRate).toBeNull();
    const r = stepWithdrawalRule(guard(), { startRate: 0.04, factor: 1 }, 30000, 0);
    expect(r.spend).toBeCloseTo(27000, 9);
    expect(Number.isFinite(r.spend)).toBe(true);
  });

  it('spends nothing extra when there is nothing flexible', () => {
    const r = stepWithdrawalRule(guard(), initialRuleState(), 0, 500000);
    expect(r.spend).toBe(0);
  });
});

describe('share-of-savings rule', () => {
  it('spends the set share of savings', () => {
    expect(stepWithdrawalRule(pctRule({ rate: 0.04 }), initialRuleState(), 50000, 1_000_000).spend).toBeCloseTo(40000, 9);
  });
  it('respects the floor and ceiling relative to the plan', () => {
    const r = pctRule({ rate: 0.04, floor: 0.9, ceiling: 1.2 });
    expect(stepWithdrawalRule(r, initialRuleState(), 50000, 1_000_000).spend).toBeCloseTo(45000, 9); // 40k → floor 45k
    expect(stepWithdrawalRule(r, initialRuleState(), 50000, 2_000_000).spend).toBeCloseTo(60000, 9); // 80k → ceiling 60k
    expect(stepWithdrawalRule(r, initialRuleState(), 50000, 1_250_000).spend).toBeCloseTo(50000, 9); // in between
  });
  it('falls to the floor (or zero) with no savings', () => {
    expect(stepWithdrawalRule(pctRule({ floor: 0.5 }), initialRuleState(), 50000, 0).spend).toBe(25000);
    expect(stepWithdrawalRule(pctRule(), initialRuleState(), 50000, -100).spend).toBe(0);
  });
  it('adds no spending when the plan has none', () => {
    expect(stepWithdrawalRule(pctRule(), initialRuleState(), 0, 1_000_000).spend).toBe(0);
  });
});

describe('normalizeWithdrawalRule', () => {
  it('returns the defaults for junk', () => {
    expect(normalizeWithdrawalRule(null)).toEqual(DEFAULT_WITHDRAWAL_RULE);
    expect(normalizeWithdrawalRule('x')).toEqual(DEFAULT_WITHDRAWAL_RULE);
    expect(normalizeWithdrawalRule({ kind: 'bogus' }).kind).toBe('fixed');
  });
  it('clamps out-of-range numbers and keeps null bounds', () => {
    const r = normalizeWithdrawalRule({ kind: 'percentOfPortfolio', guardrails: { upper: 9, cut: -1 }, percent: { rate: 0.5, floor: null, ceiling: 0.5 } });
    expect(r.guardrails.upper).toBe(0.5);
    expect(r.guardrails.cut).toBe(0.01);
    expect(r.guardrails.lower).toBe(0.2);
    expect(r.percent.rate).toBe(0.15);
    expect(r.percent.floor).toBeNull();
    expect(r.percent.ceiling).toBe(1);
  });
  it('lifts a ceiling below the floor up to the floor', () => {
    const r = normalizeWithdrawalRule({ percent: { rate: 0.04, floor: 1, ceiling: 1 } });
    expect(r.percent.ceiling).toBeGreaterThanOrEqual(r.percent.floor as number);
  });
});

describe('describeRule', () => {
  it('gives one plain sentence per rule with the current numbers', () => {
    expect(describeRule(DEFAULT_WITHDRAWAL_RULE)).toMatch(/same amount every year/);
    expect(describeRule(guard())).toMatch(/20% above.*10% less/);
    expect(describeRule(pctRule({ rate: 0.035, floor: 0.8, ceiling: null }))).toBe('Each year, spend 3.5% of what your savings are worth, never below 80% of your plan.');
  });
});

describe('resolvePctInput (the picker\'s percent fields)', () => {
  const [rlo, rhi] = RULE_LIMITS.rate, [blo, bhi] = RULE_LIMITS.band;
  it('shows the clamped value even when it equals the saved one (nothing new to commit)', () => {
    // Rate already at the 15% maximum; typing 30 keeps 15% and must show "15", not "30".
    expect(resolvePctInput('30', 0.15, rlo, rhi, false)).toEqual({ text: '15', commit: false, value: 0.15 });
    // Guardrail band at its 50% maximum; typing 80 shows "50".
    expect(resolvePctInput('80', 0.5, blo, bhi, false)).toEqual({ text: '50', commit: false, value: 0.5 });
  });
  it('commits a real change, clamped', () => {
    expect(resolvePctInput('30', 0.04, rlo, rhi, false)).toEqual({ text: '15', commit: true, value: 0.15 });
    expect(resolvePctInput(' 3.5 ', 0.04, rlo, rhi, false)).toEqual({ text: '3.5', commit: true, value: 0.035 });
  });
  it('commits nothing when the field is left as it was', () => {
    expect(resolvePctInput('20', 0.2, blo, bhi, false).commit).toBe(false);
    expect(resolvePctInput('', null, 0.1, 1, true).commit).toBe(false);
  });
  it('restores the saved value for unparseable or empty required input', () => {
    expect(resolvePctInput('abc', 0.2, blo, bhi, false)).toEqual({ text: '20', commit: false, value: 0.2 });
    expect(resolvePctInput('', 0.2, blo, bhi, false)).toEqual({ text: '20', commit: false, value: 0.2 });
  });
  it('clears an optional field to none', () => {
    expect(resolvePctInput('  ', 0.8, 0.1, 1, true)).toEqual({ text: '', commit: true, value: null });
  });
});
