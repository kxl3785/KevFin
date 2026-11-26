import { DEFAULT_ASSUMPTIONS, padEarners, type Assumptions, type Earner } from './forecastConfig.ts';
import type { Pools, SimEvent, SimInput } from './forecastSim.ts';
import { normalizeTaxPlan, simTaxFor, type TaxPlan } from './taxPlan.ts';
import { normalizeBacktestSettings, simExtrasFor, type BacktestSettings } from './backtest.ts';
import { normalizeWithdrawalRule, type WithdrawalRule } from './withdrawalRules.ts';

// Named Forecast scenarios: the full set of plan inputs saved under a name, to load
// back later (the switcher beside the page title) or compare on the main chart.
// Stored as one list under the prefs key
// `mon.fcScenarios` (its own key — never inside `mon.fcAssumptions`, so it is not
// shipped to the AI assistant). The server caps one preference at 512 KB; the list
// is kept well under that by capping both its length and its size.
//
// What a scenario holds: everything on the Forecast that describes the PLAN —
// assumptions, earners, life events, kids, college/grad toggles, account
// contributions, the what-if levers, and the tax, return-model and spending-rule
// settings. What it does not: today's balances and holdings (they come from the
// accounts), and the account-level choices (tax-bucket overrides, accounts or
// properties left out, which properties may be sold). Those stay as they are now
// when a scenario is loaded or compared.
//
// Ages. Today's ages (each earner's current age and the kids' ages) are facts
// about today, like balances, not plan choices: a scenario saved last year still
// holds last year's ages, so loading or comparing it keeps the page's ages and
// takes only the plan from the scenario (retirement ages, Social Security claim
// ages, event ages and the plan's end age are plan choices and do come along).

export const SCENARIOS_KEY = 'mon.fcScenarios';
export const MAX_SCENARIOS = 20;
export const MAX_SCENARIO_BYTES = 256 * 1024; // half the server's per-preference cap
export const MAX_NAME_LENGTH = 60;
export const MAX_COMPARE = 4;

export interface ScenarioLevers { retireAge: number | null; extraSave: number; investReturn: number | null }
export interface ScenarioSettings<E extends SimEvent = SimEvent> {
  assumptions: Assumptions;
  earners: Earner[];
  events: E[];
  kidAges: number[];
  collegeOn: boolean;
  gradOn: boolean;
  hsaLast: boolean;
  glidePath: boolean;
  spendingAdjust: number;
  levers: ScenarioLevers;
  accountContribs: Record<string, number>;
  taxPlan: TaxPlan;
  returnModel: BacktestSettings;
  spendingRule: WithdrawalRule;
}
export interface SavedScenario<E extends SimEvent = SimEvent> { id: string; name: string; savedAt: number; settings: ScenarioSettings<E> }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function byteSize(value: unknown): number {
  let s: string;
  try { s = JSON.stringify(value) ?? ''; } catch { return Infinity; }
  return new TextEncoder().encode(s).length;
}

export function cleanName(name: unknown): string {
  return (typeof name === 'string' ? name : '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
}

// Repair one stored scenario's settings, field by field. Nested settings go
// through their own normalizers; anything else missing falls back to a default.
export function normalizeSettings(raw: unknown): ScenarioSettings | null {
  if (!isObj(raw) || !isObj(raw.assumptions) || !Array.isArray(raw.earners)) return null;
  const lv = isObj(raw.levers) ? raw.levers : {};
  const contribs: Record<string, number> = {};
  if (isObj(raw.accountContribs)) for (const [k, v] of Object.entries(raw.accountContribs)) if (fin(v)) contribs[k] = v;
  return {
    assumptions: { ...DEFAULT_ASSUMPTIONS, ...(raw.assumptions as Partial<Assumptions>) },
    earners: padEarners(raw.earners as Earner[]),
    events: Array.isArray(raw.events) ? (raw.events as unknown[]).filter((e): e is SimEvent => isObj(e) && typeof e.type === 'string' && fin(e.age) && fin(e.amount)) : [],
    kidAges: Array.isArray(raw.kidAges) ? (raw.kidAges as unknown[]).filter(fin) : [],
    collegeOn: typeof raw.collegeOn === 'boolean' ? raw.collegeOn : true,
    gradOn: typeof raw.gradOn === 'boolean' ? raw.gradOn : false,
    hsaLast: typeof raw.hsaLast === 'boolean' ? raw.hsaLast : true,
    glidePath: typeof raw.glidePath === 'boolean' ? raw.glidePath : false,
    spendingAdjust: fin(raw.spendingAdjust) && raw.spendingAdjust > 0 ? raw.spendingAdjust : 1,
    levers: {
      retireAge: fin(lv.retireAge) ? lv.retireAge : null,
      extraSave: fin(lv.extraSave) && lv.extraSave > 0 ? lv.extraSave : 0,
      investReturn: fin(lv.investReturn) ? lv.investReturn : null,
    },
    accountContribs: contribs,
    taxPlan: normalizeTaxPlan(raw.taxPlan),
    returnModel: normalizeBacktestSettings(raw.returnModel),
    spendingRule: normalizeWithdrawalRule(raw.spendingRule),
  };
}

// The stored list, repaired: junk entries dropped, ids made unique, capped.
export function normalizeScenarios(raw: unknown): SavedScenario[] {
  if (!Array.isArray(raw)) return [];
  const out: SavedScenario[] = [];
  const ids = new Set<string>();
  for (const r of raw) {
    if (!isObj(r)) continue;
    const settings = normalizeSettings(r.settings);
    const name = cleanName(r.name);
    if (!settings || !name) continue;
    let id = typeof r.id === 'string' && r.id ? r.id : `s${out.length}`;
    while (ids.has(id)) id += '_';
    ids.add(id);
    out.push({ id, name, savedAt: fin(r.savedAt) ? r.savedAt : 0, settings });
    if (out.length >= MAX_SCENARIOS) break;
  }
  return out;
}

export type ListResult<T> = { ok: true; list: T[] } | { ok: false; error: string };

// The saved scenario a name would replace (names match with spaces collapsed and
// in any case), or null. The page asks before replacing with the same rule.
export function findByName<E extends SimEvent>(list: SavedScenario<E>[], name: string): SavedScenario<E> | null {
  const n = cleanName(name).toLowerCase();
  if (!n) return null;
  return list.find(s => s.name.toLowerCase() === n) ?? null;
}

// Add (or, when the name is taken, replace) a scenario. Refuses rather than
// silently dropping data when the list is full or would be too large to store.
export function saveScenario<E extends SimEvent>(list: SavedScenario<E>[], name: string, settings: ScenarioSettings<E>, opts: { now: number; id: string }): ListResult<SavedScenario<E>> {
  const n = cleanName(name);
  if (!n) return { ok: false, error: 'Give the scenario a name.' };
  const match = findByName(list, n);
  const existing = match ? list.indexOf(match) : -1;
  const entry: SavedScenario<E> = { id: existing >= 0 ? list[existing].id : opts.id, name: n, savedAt: opts.now, settings };
  const next = existing >= 0 ? list.map((s, i) => (i === existing ? entry : s)) : [...list, entry];
  if (next.length > MAX_SCENARIOS) return { ok: false, error: `You can keep up to ${MAX_SCENARIOS} scenarios. Delete one first.` };
  if (byteSize(next) > MAX_SCENARIO_BYTES) return { ok: false, error: 'Saved scenarios are too large to store. Delete one first.' };
  return { ok: true, list: next };
}

export function renameScenario<E extends SimEvent>(list: SavedScenario<E>[], id: string, name: string): ListResult<SavedScenario<E>> {
  const n = cleanName(name);
  if (!n) return { ok: false, error: 'A name can’t be empty.' };
  if (list.some(s => s.id !== id && s.name.toLowerCase() === n.toLowerCase())) return { ok: false, error: 'Another scenario already has that name.' };
  if (!list.some(s => s.id === id)) return { ok: false, error: 'That scenario no longer exists.' };
  return { ok: true, list: list.map(s => (s.id === id ? { ...s, name: n } : s)) };
}

export function deleteScenario<E extends SimEvent>(list: SavedScenario<E>[], id: string): SavedScenario<E>[] {
  return list.filter(s => s.id !== id);
}

// The simulation input for a scenario: today's balances, holdings and property
// model from `base` (the page's current plan input), with every plan setting taken
// from the scenario. `contribFor` turns the scenario's per-account contributions
// into per-bucket amounts using today's accounts (the page owns that mapping).
// The what-if levers are applied the same way the page applies them.
export function scenarioSimInput(base: SimInput, s: ScenarioSettings, contribFor: (c: Record<string, number>) => Pools): SimInput {
  // Today's ages from the page (see "Ages" above).
  const A = { ...DEFAULT_ASSUMPTIONS, ...s.assumptions, currentAge: base.currentAge0 };
  const earners = padEarners(s.earners).map((e, i) => (base.earners[i] && Number.isFinite(base.earners[i].currentAge) ? { ...e, currentAge: base.earners[i].currentAge } : e));
  const tax = simTaxFor(normalizeTaxPlan(s.taxPlan), { twoEarners: !!earners[1]?.enabled });
  const extras = simExtrasFor(normalizeBacktestSettings(s.returnModel), normalizeWithdrawalRule(s.spendingRule));
  const contrib = contribFor(s.accountContribs ?? {});
  const lv = s.levers ?? { retireAge: null, extraSave: 0, investReturn: null };
  const spendAdj = fin(s.spendingAdjust) && s.spendingAdjust > 0 ? s.spendingAdjust : 1;
  const realEstate = base.realEstate
    ? { ...base.realEstate, taxGrowth: A.propertyTaxGrowth, insuranceGrowth: A.insuranceGrowth, hoaGrowth: A.hoaGrowth, rentalGrowth: A.rentalGrowth }
    : undefined;
  // Extra saving as the page's lever models it (withLevers in Forecast.tsx):
  // spending that much less each working year, never more than is spent.
  const retireAt = lv.retireAge ?? earners[0]?.retireAge ?? 65;
  const cut = Math.min(lv.extraSave, A.annualSpending * spendAdj);
  const x: SimInput = {
    ...base,
    A: lv.investReturn != null ? { ...A, investReturn: lv.investReturn } : A,
    currentAge0: base.currentAge0,
    infl: A.inflation, costPerKid: A.costPerKid, kidIndependentAge: A.kidIndependentAge,
    kidAges: base.kidAges,
    events: cut > 0 && retireAt > base.currentAge0
      ? [...s.events, { type: 'recurring', age: base.currentAge0, untilAge: retireAt - 1, amount: -cut }]
      : s.events,
    earners: lv.retireAge != null ? earners.map((e, i) => (i === 0 ? { ...e, retireAge: lv.retireAge as number } : e)) : earners,
    contribByBucket: contrib,
    hsaLast: s.hsaLast, collegeOn: s.collegeOn, gradOn: s.gradOn, glidePath: s.glidePath,
    spendingAdjust: spendAdj,
    realEstate,
  };
  // Settings the scenario leaves at their defaults must be ABSENT, as on the page.
  delete x.tax; delete x.returnModel; delete x.historicalStockShare; delete x.withdrawal;
  return { ...x, ...(tax ? { tax } : {}), ...extras };
}

// --- Which scenario the page is on ---------------------------------------------
// Nothing records "the scenario you are on", so the page works it out: the saved
// scenario whose plan matches the page's inputs exactly. Today's ages (and the
// kids' ages) are facts about today, not plan choices (see "Ages" above), so they
// are left out of the comparison: a scenario saved last year still matches once
// loaded. `fromId` is the scenario last loaded or saved; when the inputs no longer
// match any scenario but started from that one, the page has unsaved changes.

// JSON with object keys sorted, so two equal settings always give the same text.
function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, val) => (isObj(val)
    ? Object.fromEntries(Object.keys(val).sort().map(k => [k, val[k]]))
    : val));
}

// A scenario's plan as comparable text (null for settings that can't be read).
export function planFingerprint(settings: unknown): string | null {
  const n = normalizeSettings(settings);
  if (!n) return null;
  const { currentAge: _age, ...assumptions } = n.assumptions;
  return stableJson({
    ...n, assumptions, kidAges: null,
    earners: n.earners.map(e => { const { currentAge: _a, ...rest } = e; return rest; }),
  });
}

export type ScenarioState =
  | { kind: 'saved'; id: string; name: string }    // the inputs are this saved scenario
  | { kind: 'edited'; id: string; name: string }   // changed since loading or saving `id`
  | { kind: 'none' };                              // never saved

export function scenarioState(list: SavedScenario[], current: ScenarioSettings | null, fromId: string | null): ScenarioState {
  const fp = current ? planFingerprint(current) : null;
  if (fp) {
    const matches = list.filter(s => planFingerprint(s.settings) === fp);
    const m = matches.find(s => s.id === fromId) ?? matches[0];
    if (m) return { kind: 'saved', id: m.id, name: m.name };
  }
  const from = fromId ? list.find(s => s.id === fromId) : undefined;
  return from ? { kind: 'edited', id: from.id, name: from.name } : { kind: 'none' };
}

// What the switcher button says.
export function scenarioLabel(st: ScenarioState): string {
  return st.kind === 'saved' ? st.name : st.kind === 'edited' ? 'Unsaved changes' : 'Current inputs';
}

// --- Comparison on the chart -------------------------------------------------------
// Each compared scenario's median net worth joins the chart's rows by age under
// its own key ("scn0"…), coloured by its slot. Rows the scenario has no band for
// (the modeled past) are left without it, so its line starts at today.
export const SCENARIO_COLORS = ['var(--scn-1)', 'var(--scn-2)', 'var(--scn-3)', 'var(--scn-4)'];
export const scenarioKey = (slot: number) => `scn${slot}`;
export interface ScenarioLine { key: string; bands: { age: number; p50: number }[] }

export function withScenarioLines<R extends { age: number }>(rows: R[], lines: ScenarioLine[]): R[] {
  if (!lines.length) return rows;
  const maps = lines.map(l => ({ key: l.key, byAge: new Map(l.bands.map(b => [b.age, b.p50])) }));
  return rows.map(r => {
    let out: R | null = null;
    for (const m of maps) {
      const v = m.byAge.get(r.age);
      if (v == null || !Number.isFinite(v)) continue;
      out = out ?? { ...r };
      (out as Record<string, unknown>)[m.key] = v;
    }
    return out ?? r;
  });
}

// A scenario's settings with today's ages put back (the page's, see "Ages"
// above), for loading it onto the page.
export function withTodaysAges<E extends SimEvent>(s: ScenarioSettings<E>, today: { currentAge: number; earners: { currentAge: number }[]; kidAges: number[] }): ScenarioSettings<E> {
  return {
    ...s,
    assumptions: { ...s.assumptions, currentAge: today.currentAge },
    earners: s.earners.map((e, i) => (today.earners[i] && Number.isFinite(today.earners[i].currentAge) ? { ...e, currentAge: today.earners[i].currentAge } : e)),
    kidAges: today.kidAges.slice(),
  };
}
