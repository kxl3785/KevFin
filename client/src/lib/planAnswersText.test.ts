import { describe, it, expect } from 'vitest';
import type { SimInput } from './forecastSim.ts';
import { solvePlan, runToEnd, DEFAULT_TARGETS, type PlanAnswersResult } from './forecastSolve.ts';
import { DEFAULT_WITHDRAWAL_RULE } from './withdrawalRules.ts';
import { answerTiles, guardrailLines, answersNote, sourceNote, wordsText } from './planAnswersText.ts';

const RUNS = 150;
const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const plan = (over: Partial<SimInput> = {}): SimInput => ({
  A: {
    endAge: 90, annualSpending: 70000, eduInflation: 0.05,
    collegeStartAge: 18, collegeYears: 4, collegeCostPerYear: 0,
    gradStartAge: 22, gradYears: 2, gradCostPerYear: 0, gradCoverage: 0,
    effTaxRate: 0.24, investReturn: 0.07, volatility: 0.15, realEstateGrowth: 0.04, retireTaxRate: 0.15,
  },
  currentAge0: 40, infl: 0.03, costPerKid: 0, kidIndependentAge: 22, kidAges: [], events: [],
  earners: [{ currentAge: 40, income: 180000, retireAge: 65, raisePct: 0.02, ssEnabled: true, ssClaimAge: 67, ssAnnual: 36000, employerMatch: 12000, enabled: true }],
  pools0: { taxable: 150000, pretax: 300000, roth: 50000, hsa: 0, college: 0 },
  contribByBucket: { taxable: 0, pretax: 23000, roth: 0, hsa: 0, college: 0 },
  baseRE: 0, hsaLast: true, collegeOn: false, gradOn: false, spendingAdjust: 1, yearNow: 2026, runs: RUNS,
  ...over,
});
const tilesOf = (r: PlanAnswersResult, labels: Record<number, string> = {}) =>
  Object.fromEntries(answerTiles(r, { money, endAge: 95, earnerLabel: i => labels[i] }).map(t => [t.key, t]));

describe('retirement tiles when earner 0 is retired and the partner works (AM-2 / AU-2)', () => {
  // The bug-hunt household: earner 0 is 62 and retired at 60; the partner is 55
  // and plans 65. Whatever age the solver finds is the PARTNER's.
  const x = plan({
    A: { ...plan().A, endAge: 95, annualSpending: 110000 },
    currentAge0: 62,
    earners: [
      { currentAge: 62, income: 0, retireAge: 60, raisePct: 0.02, ssEnabled: true, ssClaimAge: 67, ssAnnual: 30000, employerMatch: 0, enabled: true },
      { currentAge: 55, income: 160000, retireAge: 65, raisePct: 0.02, ssEnabled: true, ssClaimAge: 67, ssAnnual: 30000, employerMatch: 0, enabled: true },
    ],
    pools0: { taxable: 680000, pretax: 1_020_000, roth: 0, hsa: 0, college: 0 },
  });
  const r = runToEnd(solvePlan(x, DEFAULT_TARGETS, RUNS));

  it('names the partner, never "Now" while they must keep working, and reads against their planned 65', () => {
    const er = r.earliestRetirement;
    if (er.status !== 'ok') throw new Error('expected an age');
    const t = tilesOf(r, { 1: 'Sam' }).retire;
    if (er.age > 55) {
      expect(t.value).toBe(`Sam: age ${er.age}`);
      expect(t.value).not.toMatch(/now/i);
    } else expect(t.value).toBe('Sam: now');
    expect(t.sub).not.toContain('planned 60');
    if (er.shift !== 0) expect(t.sub).toBe(`${Math.abs(er.shift)} year${Math.abs(er.shift) === 1 ? '' : 's'} ${er.shift < 0 ? 'before' : 'after'} Sam’s planned 65`);
  });

  it('the coast tile names the partner\'s planned age, not earner 0\'s past one', () => {
    const t = tilesOf(r).coast;
    expect(t.sub).not.toContain(' 60');
    if (r.coast.status === 'ok' && r.coast.coasting) expect(t.sub).toBe('reached · Partner retiring at 65 needs no new saving');
  });

  it('a hand-built result: the tile reads the lead\'s own ages', () => {
    const base = runToEnd(solvePlan(plan(), DEFAULT_TARGETS, 30));
    const fake: PlanAnswersResult = {
      ...base, lead: { index: 1, currentAge: 55, retireAge: 65 },
      earliestRetirement: { status: 'ok', age: 62, shift: -3, partnerAge: null },
      coast: { status: 'ok', amount: 500000, coasting: true },
    };
    const t = tilesOf(fake);
    expect(t.retire.value).toBe('Partner: age 62');
    expect(t.retire.sub).toBe('3 years before Partner’s planned 65');
    expect(t.coast.sub).toBe('reached · Partner retiring at 65 needs no new saving');
  });

  it('earner 0 working: the familiar wording is unchanged', () => {
    const base = runToEnd(solvePlan(plan(), DEFAULT_TARGETS, 30));
    const fake: PlanAnswersResult = { ...base, lead: { index: 0, currentAge: 40, retireAge: 65 }, earliestRetirement: { status: 'ok', age: 60, shift: -5, partnerAge: 58 } };
    const t = tilesOf(fake).retire;
    expect(t.value).toBe('Age 60');
    expect(t.sub).toBe('5 years before your planned 65 · partner at 58');
    const now = tilesOf({ ...fake, earliestRetirement: { status: 'ok', age: 40, shift: -25, partnerAge: null } }).retire;
    expect(now.value).toBe('Now');
  });
});

describe('tiles under a spending rule (AM-3 / AU-1 / XR-5)', () => {
  it('share of savings: no tiles, no guardrails, and a note saying why', () => {
    const r = runToEnd(solvePlan(plan({ pools0: { taxable: 50000, pretax: 0, roth: 0, hsa: 0, college: 0 }, withdrawal: { ...DEFAULT_WITHDRAWAL_RULE, kind: 'percentOfPortfolio' } }), DEFAULT_TARGETS, RUNS));
    expect(answerTiles(r, { money, endAge: 90, earnerLabel: () => undefined })).toEqual([]);
    expect(guardrailLines(r, money)).toEqual([]);
    expect(answersNote(r)).toMatch(/never run out/);
    expect(answersNote(r)).toMatch(/aren’t shown/);
  });

  it('guardrails: "safe starting spending", cut in bad years; no card guardrails', () => {
    const r = runToEnd(solvePlan(plan({ withdrawal: { ...DEFAULT_WITHDRAWAL_RULE, kind: 'guardrails' } }), DEFAULT_TARGETS, RUNS));
    const t = tilesOf(r);
    expect(t.spend.label).toBe('Safe starting spending');
    expect(t.spend.sub).toContain('cut in bad years');
    expect(t.spend.tip).toContain('guardrails spending rule');
    expect(guardrailLines(r, money)).toEqual([]);
    expect(answersNote(r)).toMatch(/starting amount/);
  });

  it('steady spending: no note, the original labels and guardrail lines', () => {
    const r = runToEnd(solvePlan(plan(), DEFAULT_TARGETS, RUNS));
    expect(answersNote(r)).toBeNull();
    expect(tilesOf(r).spend.label).toBe('Safe yearly spending');
    expect(guardrailLines(r, money).map(l => l.glyph)).toEqual(['▼', '▲']);
  });
});

describe('text comes from the result, not the live settings (AU-7 / AU-10)', () => {
  it('confidence and balance in the words are the ones the result was worked out with', () => {
    const r = runToEnd(solvePlan(plan(), { target: 0.9, lower: 0.75, upper: 0.97 }, 60));
    const t = tilesOf(r);
    expect(t.spend.tip).toContain('at least 90%');
    expect(t.independence.tip).toContain('at least 90%');
    expect(guardrailLines(r, money).map(l => l.text).join(' ')).not.toContain('85%');
    // "(they already do)" compares with the result's own balance.
    const g: PlanAnswersResult = { ...r, guardrails: { lower: null, upper: { balance: r.current.investable, spending: 80000 } }, safeSpending: { status: 'ok', amount: 70000 } };
    expect(guardrailLines(g, money)[1].text).toContain('(they already do)');
    expect(guardrailLines({ ...g, current: { ...g.current, investable: r.current.investable - 1 } }, money)[1].text).not.toContain('(they already do)');
    // The compact callout carries the same words: amount, trigger and the rest.
    const up = guardrailLines(g, money)[1];
    expect(wordsText(up.act)).toBe(`Raise to ${money(80000)} a year`);
    expect(wordsText(up.when)).toBe(`If investments pass ${money(r.current.investable)} (they already do)`);
    expect(up.text).toContain(up.detail);
    expect(guardrailLines(g, money)[0].when).toEqual(['No lower guardrail']);
  });

  it('the source note follows what the solve actually used', () => {
    const r = runToEnd(solvePlan(plan(), DEFAULT_TARGETS, 40));
    expect(sourceNote(r)).toMatch(/^Worked out from 40 simulated futures/);
    expect(sourceNote({ ...r, historical: true })).toMatch(/past starting years/);
  });
});
