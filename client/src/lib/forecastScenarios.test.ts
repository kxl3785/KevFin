import { describe, it, expect } from 'vitest';
import { DEFAULT_ASSUMPTIONS, DEFAULT_EARNERS } from './forecastConfig.ts';
import { DEFAULT_TAX_PLAN } from './taxPlan.ts';
import { DEFAULT_BACKTEST_SETTINGS } from './backtest.ts';
import { DEFAULT_WITHDRAWAL_RULE } from './withdrawalRules.ts';
import type { Pools, SimInput } from './forecastSim.ts';
import {
  normalizeScenarios, normalizeSettings, saveScenario, renameScenario, deleteScenario, scenarioSimInput, byteSize, cleanName,
  findByName, withTodaysAges, planFingerprint, scenarioState, scenarioLabel, withScenarioLines, scenarioKey,
  MAX_SCENARIOS, MAX_SCENARIO_BYTES, type ScenarioSettings, type SavedScenario,
} from './forecastScenarios.ts';

const settings = (over: Partial<ScenarioSettings> = {}): ScenarioSettings => ({
  assumptions: { ...DEFAULT_ASSUMPTIONS },
  earners: DEFAULT_EARNERS.map(e => ({ ...e })),
  events: [{ type: 'oneTime', age: 44, amount: 150000 }],
  kidAges: [3],
  collegeOn: true, gradOn: false, hsaLast: true, glidePath: false,
  spendingAdjust: 1,
  levers: { retireAge: null, extraSave: 0, investReturn: null },
  accountContribs: { a1: 20000, a2: 6000 },
  taxPlan: { ...DEFAULT_TAX_PLAN },
  returnModel: { ...DEFAULT_BACKTEST_SETTINGS },
  spendingRule: { ...DEFAULT_WITHDRAWAL_RULE },
  ...over,
});
// Account a1 is pre-tax, a2 Roth (the page owns this mapping; here a stand-in).
const contribFor = (c: Record<string, number>): Pools => ({ taxable: 0, pretax: c.a1 ?? 0, roth: c.a2 ?? 0, hsa: 0, college: 0 });

// The page's plan input for `s` with today's balances, built the way Forecast.tsx
// builds planInput (flat tax, defaults → no extra keys).
function pageInput(s: ScenarioSettings): SimInput {
  const A = { ...DEFAULT_ASSUMPTIONS, ...s.assumptions };
  return {
    A, currentAge0: s.earners[0].currentAge, infl: A.inflation, costPerKid: A.costPerKid, kidIndependentAge: A.kidIndependentAge,
    kidAges: s.kidAges, events: s.events, earners: s.earners,
    pools0: { taxable: 100000, pretax: 200000, roth: 0, hsa: 0, college: 0 },
    contribByBucket: contribFor(s.accountContribs), baseRE: 250000,
    hsaLast: s.hsaLast, collegeOn: s.collegeOn, gradOn: s.gradOn, spendingAdjust: 1, glidePath: s.glidePath,
    realEstate: undefined, manualAssets: [], runs: 400,
  };
}

describe('scenarioSimInput', () => {
  it('rebuilds exactly the page input for the settings it was saved from', () => {
    const s = settings();
    const base = pageInput(s);
    expect(scenarioSimInput(base, s, contribFor)).toEqual(base);
  });

  it('swaps in another scenario\'s plan but keeps today\'s balances', () => {
    const base = pageInput(settings());
    const other = settings({
      assumptions: { ...DEFAULT_ASSUMPTIONS, annualSpending: 90000, inflation: 0.025 },
      earners: [{ ...DEFAULT_EARNERS[0], currentAge: 45, retireAge: 60 }, { ...DEFAULT_EARNERS[1], enabled: true }],
      accountContribs: { a1: 10000 },
      kidAges: [], collegeOn: false,
    });
    const x = scenarioSimInput(base, other, contribFor);
    expect(x.A.annualSpending).toBe(90000);
    expect(x.infl).toBe(0.025);
    // Today's ages stay (the scenario's 45 and no kids were as saved); its
    // planned retirement age comes along.
    expect(x.currentAge0).toBe(40);
    expect(x.earners[0].currentAge).toBe(40);
    expect(x.earners[0].retireAge).toBe(60);
    expect(x.kidAges).toEqual([3]);
    expect(x.earners[1].enabled).toBe(true);
    expect(x.contribByBucket).toEqual({ taxable: 0, pretax: 10000, roth: 0, hsa: 0, college: 0 });
    expect(x.pools0).toBe(base.pools0);
    expect(x.baseRE).toBe(250000);
    expect(x.collegeOn).toBe(false);
  });

  it('applies the what-if levers the way the page does', () => {
    const s = settings({ spendingAdjust: 0.9, levers: { retireAge: 60, extraSave: 5000, investReturn: 0.06 } });
    const x = scenarioSimInput(pageInput(settings()), s, contribFor);
    expect(x.spendingAdjust).toBe(0.9);
    expect(x.earners[0].retireAge).toBe(60);
    expect(x.earners[1].retireAge).toBe(DEFAULT_EARNERS[1].retireAge);
    expect(x.A.investReturn).toBe(0.06);
    // Extra saving is spending that much less each working year (withLevers in
    // Forecast.tsx), not an extra contribution.
    expect(x.contribByBucket).toEqual(contribFor(s.accountContribs));
    expect(x.events).toEqual([...s.events, { type: 'recurring', age: 40, untilAge: 59, amount: -5000 }]);
  });

  it('rebuilds exactly the page input with the levers moved (withLevers)', () => {
    const s = settings({ spendingAdjust: 0.8, levers: { retireAge: 58, extraSave: 7000, investReturn: 0.05 } });
    const plan = pageInput(s);
    // Forecast.tsx's withLevers(levers, spendAdj) on the plan input.
    const cut = Math.min(7000, plan.A.annualSpending * 0.8);
    const page: SimInput = {
      ...plan, spendingAdjust: 0.8,
      A: { ...plan.A, investReturn: 0.05 },
      earners: plan.earners.map((e, i) => (i === 0 ? { ...e, retireAge: 58 } : e)),
      events: [...plan.events, { type: 'recurring', age: plan.currentAge0, untilAge: 57, amount: -cut }],
    };
    expect(scenarioSimInput(plan, s, contribFor)).toEqual(page);
    // More saving than spending: capped at what is spent.
    const big = settings({ assumptions: { ...DEFAULT_ASSUMPTIONS, annualSpending: 3000 }, levers: { retireAge: null, extraSave: 9000, investReturn: null } });
    expect(scenarioSimInput(pageInput(big), big, contribFor).events.at(-1)).toMatchObject({ amount: -3000, untilAge: 64 });
  });

  it('carries the bracket-tax, historical and spending-rule settings — and drops them when off', () => {
    const on = settings({
      taxPlan: { ...DEFAULT_TAX_PLAN, mode: 'brackets', convOn: true, stateRate: 0.05 },
      returnModel: { returnModel: 'historical', stockShare: 0.6 },
      spendingRule: { ...DEFAULT_WITHDRAWAL_RULE, kind: 'guardrails' },
    });
    const x = scenarioSimInput(pageInput(settings()), on, contribFor);
    expect(x.tax).toEqual({ mode: 'brackets', filing: 'single', stateRate: 0.05, conversions: { startAge: null, endAge: 72, bracketRate: 0.22, irmaaCap: true } });
    expect(x.returnModel).toBe('historical');
    expect(x.historicalStockShare).toBe(0.6);
    expect(x.withdrawal?.kind).toBe('guardrails');
    // Back to a default scenario from a base that had them on: all removed.
    const back = scenarioSimInput(x, settings(), contribFor);
    for (const k of ['tax', 'returnModel', 'historicalStockShare', 'withdrawal'] as const) expect(k in back).toBe(false);
  });

  it('updates the property cost growth rates from the scenario', () => {
    const base = { ...pageInput(settings()), realEstate: { properties: [], propertyTaxAnnual: 1, insuranceAnnual: 1, hoaAnnual: 0, rentalIncomeAnnual: 0, taxGrowth: 0.02, insuranceGrowth: 0.04, hoaGrowth: 0.03, rentalGrowth: 0.03 } };
    const x = scenarioSimInput(base, settings({ assumptions: { ...DEFAULT_ASSUMPTIONS, propertyTaxGrowth: 0.05 } }), contribFor);
    expect(x.realEstate?.taxGrowth).toBe(0.05);
    expect(x.realEstate?.insuranceGrowth).toBe(0.04);
  });
});

describe('the stored list', () => {
  const list = (n: number): SavedScenario[] => Array.from({ length: n }, (_, i) => ({ id: `id${i}`, name: `Plan ${i}`, savedAt: i, settings: settings() }));

  it('repairs junk: bad entries dropped, missing fields defaulted, ids unique, capped', () => {
    const raw = [
      null, 5, { name: 'No settings' },
      { id: 'x', name: '  Early   retirement ', savedAt: 1, settings: { assumptions: { annualSpending: 50000 }, earners: [] } },
      { id: 'x', name: 'Twin id', settings: settings() },
      { id: 'y', name: '', settings: settings() },
    ];
    const out = normalizeScenarios(raw);
    expect(out.map(s => s.name)).toEqual(['Early retirement', 'Twin id']);
    expect(new Set(out.map(s => s.id)).size).toBe(2);
    const s0 = out[0].settings;
    expect(s0.assumptions.annualSpending).toBe(50000);
    expect(s0.assumptions.endAge).toBe(DEFAULT_ASSUMPTIONS.endAge);
    expect(s0.earners.length).toBe(DEFAULT_EARNERS.length);
    expect(s0.levers).toEqual({ retireAge: null, extraSave: 0, investReturn: null });
    expect(s0.taxPlan).toEqual(DEFAULT_TAX_PLAN);
    expect(s0.spendingRule).toEqual(DEFAULT_WITHDRAWAL_RULE);
    expect(normalizeScenarios({})).toEqual([]);
    expect(normalizeScenarios(list(30)).length).toBe(MAX_SCENARIOS);
    expect(normalizeSettings({ assumptions: {} })).toBeNull();
  });

  it('round-trips a saved list through JSON unchanged', () => {
    const l = list(3);
    expect(normalizeScenarios(JSON.parse(JSON.stringify(l)))).toEqual(l);
  });

  it('saves, replaces by name, and refuses when empty, full or too large', () => {
    let r = saveScenario([], '  Base  ', settings(), { now: 1, id: 'a' });
    expect(r.ok && r.list).toEqual([{ id: 'a', name: 'Base', savedAt: 1, settings: settings() }]);
    r = saveScenario(r.ok ? r.list : [], 'base', settings({ spendingAdjust: 0.8 }), { now: 2, id: 'b' });
    expect(r.ok && r.list.length).toBe(1);
    expect(r.ok && r.list[0]).toMatchObject({ id: 'a', name: 'base', savedAt: 2 });
    expect(saveScenario([], '   ', settings(), { now: 1, id: 'a' }).ok).toBe(false);
    expect(saveScenario(list(MAX_SCENARIOS), 'One more', settings(), { now: 1, id: 'z' }).ok).toBe(false);
    const huge = settings({ events: Array.from({ length: 6000 }, (_, i) => ({ type: 'oneTime', age: 50, amount: i, label: 'x'.repeat(40) })) });
    const big = saveScenario([], 'Huge', huge, { now: 1, id: 'h' });
    expect(big.ok).toBe(false);
  });

  it('twenty realistic scenarios stay well inside the size cap', () => {
    expect(byteSize(list(MAX_SCENARIOS))).toBeLessThan(MAX_SCENARIO_BYTES / 4);
  });

  it('renames (unique, non-empty) and deletes', () => {
    const l = list(2);
    const r = renameScenario(l, 'id0', 'Downsize at 70');
    expect(r.ok && r.list.map(s => s.name)).toEqual(['Downsize at 70', 'Plan 1']);
    expect(renameScenario(l, 'id0', 'plan 1').ok).toBe(false);
    expect(renameScenario(l, 'id0', '  ').ok).toBe(false);
    expect(renameScenario(l, 'nope', 'X').ok).toBe(false);
    expect(renameScenario(l, 'id0', 'Plan 0').ok).toBe(true); // its own name is fine
    expect(deleteScenario(l, 'id1').map(s => s.id)).toEqual(['id0']);
  });

  it('cleans names', () => {
    expect(cleanName('  a\n b  ')).toBe('a b');
    expect(cleanName('x'.repeat(100)).length).toBe(60);
    expect(cleanName(42)).toBe('');
  });
});


describe('regressions from the answers fix pass', () => {
  it('a name that differs only in spacing or case finds the scenario it would replace (AM-4 / AU-3)', () => {
    const list: SavedScenario[] = [{ id: 'keep', name: 'Retire at 60', savedAt: 1, settings: settings() }];
    for (const typed of ['Retire  at 60', ' retire at 60 ', 'Retire at 60', 'RETIRE\tat 60']) {
      expect(findByName(list, typed)?.id).toBe('keep');
      // …and that is exactly the entry saveScenario replaces.
      const r = saveScenario(list, typed, settings({ spendingAdjust: 0.5 }), { now: 2, id: 'new' });
      expect(r.ok && r.list.map(x => [x.id, x.settings.spendingAdjust])).toEqual([['keep', 0.5]]);
    }
    expect(findByName(list, 'Retire at 61')).toBeNull();
    expect(findByName(list, '   ')).toBeNull();
  });

  it('comparing an older scenario keeps today\'s ages and kids, and takes its plan (AU-4 / AM-7)', () => {
    // Saved when earner 0 was 40 (partner 38, one kid of 3); today they are 41/39 with kids 4 and 1.
    const saved = settings({ earners: [{ ...DEFAULT_EARNERS[0], currentAge: 40, retireAge: 60 }, { ...DEFAULT_EARNERS[1], currentAge: 38, retireAge: 62, enabled: true }] });
    const today = settings({
      assumptions: { ...DEFAULT_ASSUMPTIONS, currentAge: 41 },
      earners: [{ ...DEFAULT_EARNERS[0], currentAge: 41 }, { ...DEFAULT_EARNERS[1], currentAge: 39 }],
      kidAges: [4, 1],
    });
    const x = scenarioSimInput(pageInput(today), saved, contribFor);
    expect(x.currentAge0).toBe(41);
    expect(x.A.currentAge).toBe(41);
    expect(x.earners.map(e => [e.currentAge, e.retireAge, e.enabled])).toEqual([[41, 60, true], [39, 62, true]]);
    expect(x.kidAges).toEqual([4, 1]);
    expect(x.events).toEqual(saved.events);
  });

  it('loading puts today\'s ages back and leaves the rest of the scenario as saved', () => {
    const saved = settings({ earners: [{ ...DEFAULT_EARNERS[0], currentAge: 40, retireAge: 60 }, { ...DEFAULT_EARNERS[1], currentAge: 38 }], kidAges: [3] });
    const s = withTodaysAges(saved, { currentAge: 42, earners: [{ currentAge: 42 }, { currentAge: 40 }], kidAges: [5] });
    expect(s.assumptions.currentAge).toBe(42);
    expect(s.earners.map(e => [e.currentAge, e.retireAge])).toEqual([[42, 60], [40, DEFAULT_EARNERS[1].retireAge]]);
    expect(s.kidAges).toEqual([5]);
    expect({ ...s, assumptions: saved.assumptions, earners: saved.earners, kidAges: saved.kidAges }).toEqual(saved);
  });
});

describe('which scenario the page is on', () => {
  const saved = (id: string, name: string, s: ScenarioSettings): SavedScenario => ({ id, name, savedAt: 1, settings: s });
  const base = settings();
  const early = settings({ levers: { retireAge: 58, extraSave: 0, investReturn: null } });
  const list = [saved('a', 'Base case', base), saved('b', 'Retire at 58', early)];

  it('matches the saved scenario whose plan equals the inputs, even through a JSON round trip', () => {
    const stored = normalizeScenarios(JSON.parse(JSON.stringify(list)));
    expect(scenarioState(stored, settings(), null)).toEqual({ kind: 'saved', id: 'a', name: 'Base case' });
    expect(scenarioState(stored, early, null)).toEqual({ kind: 'saved', id: 'b', name: 'Retire at 58' });
  });

  it('ignores today\'s ages (a scenario saved last year still matches) but not plan choices', () => {
    const older = settings({
      assumptions: { ...DEFAULT_ASSUMPTIONS, currentAge: 39 },
      earners: [{ ...DEFAULT_EARNERS[0], currentAge: 39 }, { ...DEFAULT_EARNERS[1], currentAge: 37 }],
      kidAges: [2],
    });
    expect(planFingerprint(older)).toBe(planFingerprint(base));
    expect(planFingerprint(settings({ earners: [{ ...DEFAULT_EARNERS[0], retireAge: 61 }, DEFAULT_EARNERS[1]] }))).not.toBe(planFingerprint(base));
    expect(planFingerprint(settings({ spendingAdjust: 0.95 }))).not.toBe(planFingerprint(base));
    expect(planFingerprint({ nope: 1 })).toBeNull();
  });

  it('key order and missing defaults don\'t matter', () => {
    const reordered = JSON.parse(JSON.stringify({ spendingRule: base.spendingRule, levers: base.levers, ...base }));
    expect(planFingerprint(reordered)).toBe(planFingerprint(base));
    const { gradOn: _g, ...noGrad } = base;   // missing → the default (false), as saved
    expect(planFingerprint(noGrad)).toBe(planFingerprint(base));
  });

  it('edited after loading → "Unsaved changes"; never saved → "Current inputs"', () => {
    const edited = settings({ spendingAdjust: 1.1 });
    const st = scenarioState(list, edited, 'b');
    expect(st).toEqual({ kind: 'edited', id: 'b', name: 'Retire at 58' });
    expect(scenarioLabel(st)).toBe('Unsaved changes');
    expect(scenarioState(list, edited, null)).toEqual({ kind: 'none' });
    expect(scenarioState(list, edited, 'gone')).toEqual({ kind: 'none' });
    expect(scenarioLabel({ kind: 'none' })).toBe('Current inputs');
    expect(scenarioLabel(scenarioState(list, base, null))).toBe('Base case');
    expect(scenarioState(list, null, 'a')).toEqual({ kind: 'edited', id: 'a', name: 'Base case' });
  });

  it('two scenarios with the same plan: the one last loaded wins', () => {
    const twins = [...list, saved('c', 'Copy of base', base)];
    expect(scenarioState(twins, base, 'c')).toMatchObject({ id: 'c' });
    expect(scenarioState(twins, base, 'b')).toMatchObject({ id: 'a' });
  });
});

describe('comparison lines on the chart (withScenarioLines)', () => {
  const rows = [{ age: 38, p50: 1 }, { age: 40, p50: 10 }, { age: 41, p50: 11 }];

  it('joins each scenario\'s median by age under its slot key; the past gets none', () => {
    const out = withScenarioLines(rows, [
      { key: scenarioKey(0), bands: [{ age: 40, p50: 20 }, { age: 41, p50: 21 }] },
      { key: scenarioKey(1), bands: [{ age: 41, p50: 31 }, { age: 99, p50: 1 }] },
    ]);
    expect(out).toEqual([{ age: 38, p50: 1 }, { age: 40, p50: 10, scn0: 20 }, { age: 41, p50: 11, scn0: 21, scn1: 31 }]);
    expect(out[0]).toBe(rows[0]);          // untouched rows are reused
    expect(rows[1]).toEqual({ age: 40, p50: 10 }); // inputs not mutated
  });

  it('no comparison: the same rows back, nothing added', () => {
    expect(withScenarioLines(rows, [])).toBe(rows);
  });

  it('skips values that are not finite', () => {
    expect(withScenarioLines(rows, [{ key: 'scn0', bands: [{ age: 40, p50: NaN }] }])[1]).toBe(rows[1]);
  });
});
