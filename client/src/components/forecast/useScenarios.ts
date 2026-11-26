import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { runForecastSim, type Pools, type SimInput } from '../../lib/forecastSim.ts';
import {
  SCENARIOS_KEY, MAX_COMPARE, SCENARIO_COLORS, normalizeScenarios, saveScenario, renameScenario, deleteScenario,
  scenarioSimInput, scenarioState, scenarioLabel, scenarioKey, findByName, cleanName,
  type SavedScenario, type ScenarioSettings, type ScenarioState,
} from '../../lib/forecastScenarios.ts';
import { hashInputs, AnswerCache, SOLVER_RUNS, DEFAULT_TARGETS, normalizeTargets, type ScenarioRow, type SolveTargets } from '../../lib/forecastSolve.ts';
import { runSolveJob } from '../../lib/solveDriver.ts';
import { usePersistentState } from '../../hooks/usePersistentState.ts';

// Saved scenarios for the whole Forecast page: the switcher beside the title
// (ScenarioSwitcher.tsx), "Save as scenario" under What if, and the comparison on
// the main chart (ScenarioCompare.tsx) all read and change this one state.
//
// Stored: the list under `mon.fcScenarios` (unchanged shape, never sent to the AI
// assistant) and the id last loaded or saved under `mon.fcScenarioFrom`, so the
// switcher can say "Unsaved changes" after an edit. Which scenario is current is
// worked out from the inputs themselves (scenarioState in forecastScenarios.ts).
//
// Comparing costs nothing until a scenario is ticked. Then each shown scenario's
// median line is one ordinary page simulation (same runs and seeds as the page's
// own, so an unchanged scenario draws exactly on the median), run a moment after
// the inputs settle, one per task. The side-by-side figures (safe spending and
// the rest) are worked out on a background thread (lib/solveDriver.ts), as the
// old Scenarios card did, and remembered per set of inputs.

export const CURRENT = '__current__';
const rowCache = new AnswerCache<ScenarioRow>(32);
const lineCache = new AnswerCache<{ age: number; p50: number }[]>(16);
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

export type Msg = { text: string; error: boolean } | null;
export type CompareTable =
  | { status: 'idle' }
  | { status: 'running'; done: number; total: number; keys: string[]; prev: CompareCols | null }
  | { status: 'done'; keys: string[]; cols: CompareCols }
  | { status: 'error' };
export type CompareCols = { id: string; row: ScenarioRow; endAge: number }[];

// One compared scenario: its slot (colour), whether its line is shown, and the
// line's median bands once worked out.
export interface CompareSlot { id: string; slot: number; key: string; name: string; color: string; shown: boolean; bands: { age: number; p50: number }[] | null }

export interface ScenariosApi {
  ready: boolean;                     // the page's inputs have loaded
  list: SavedScenario[];
  state: ScenarioState;
  label: string;                      // the switcher's text
  msg: Msg;
  setMsg: (m: Msg) => void;
  saveAs: (name: string) => boolean;  // the current inputs under a name (asks before replacing)
  saveChanges: () => void;            // the current inputs over the scenario they came from
  rename: (id: string, name: string) => boolean;
  remove: (s: SavedScenario) => void;
  load: (s: SavedScenario) => boolean;
  compareIds: string[];
  toggleCompare: (id: string) => void;
  stopCompare: () => void;
  toggleShown: (id: string) => void;
  slots: CompareSlot[];
  table: CompareTable;
  targets: SolveTargets;
  currentName: string;                // the "current inputs" column's name
}

export function useScenarios({ current, baseInput, contribFor, onLoad }: {
  current: ScenarioSettings | null;   // the page's inputs right now (null until data loads)
  baseInput: SimInput | null;         // the page's plan input (today's balances)
  contribFor: (c: Record<string, number>) => Pools;
  onLoad: (s: ScenarioSettings) => void;
}): ScenariosApi {
  const [raw, setRaw] = usePersistentState<SavedScenario[]>(SCENARIOS_KEY, []);
  const list = useMemo(() => normalizeScenarios(raw), [raw]);
  const [fromRaw, setFrom] = usePersistentState<string | null>('mon.fcScenarioFrom', null);
  const fromId = typeof fromRaw === 'string' && list.some(s => s.id === fromRaw) ? fromRaw : null;
  const [msg, setMsg] = useState<Msg>(null);
  const state = useMemo(() => scenarioState(list, current, fromId), [list, current, fromId]);
  const label = scenarioLabel(state);
  // Inputs that are a saved scenario came from it: an edit after this reads as
  // "Unsaved changes" to that one (and deleting it leaves "Current inputs").
  useEffect(() => {
    if (state.kind === 'saved' && state.id !== fromRaw) setFrom(state.id);
  }, [state, fromRaw, setFrom]);
  const [targetsRaw] = usePersistentState<SolveTargets>('mon.fcSolveTargets', DEFAULT_TARGETS);
  const targets = useMemo(() => normalizeTargets(targetsRaw), [targetsRaw]);

  const saveAs = useCallback((name: string) => {
    if (!current) return false;
    // Names match as saveScenario matches them (spaces collapsed, any case), so a
    // name that would replace a saved scenario always asks first.
    const n = cleanName(name);
    const existing = findByName(list, n);
    if (existing && !confirm(`Replace the saved scenario “${existing.name}” with the current inputs?`)) return false;
    const r = saveScenario(list, n, current, { now: Date.now(), id: newId() });
    if (!r.ok) { setMsg({ text: r.error, error: true }); return false; }
    setRaw(r.list);
    setFrom(r.list.find(s => s.name === n)?.id ?? null);
    setMsg({ text: existing ? `Replaced “${n}”.` : `Saved “${n}”.`, error: false });
    return true;
  }, [current, list, setRaw, setFrom]);

  const saveChanges = useCallback(() => {
    if (state.kind !== 'edited') return;
    saveAs(state.name);
  }, [state, saveAs]);

  const rename = useCallback((id: string, name: string) => {
    const r = renameScenario(list, id, name);
    if (!r.ok) { setMsg({ text: r.error, error: true }); return false; }
    setRaw(r.list);
    setMsg(null);
    return true;
  }, [list, setRaw]);

  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [hidden, setHidden] = useState<string[]>([]);

  const remove = useCallback((s: SavedScenario) => {
    if (!confirm(`Delete the scenario “${s.name}”? This can’t be undone.`)) return;
    setRaw(deleteScenario(list, s.id));
    if (fromId === s.id) setFrom(null);
    setCompareIds(p => p.filter(id => id !== s.id));
    setMsg({ text: `Deleted “${s.name}”.`, error: false });
  }, [list, fromId, setRaw, setFrom]);

  // Loading replaces the page's inputs. When they are already saved as a
  // scenario nothing can be lost, so it doesn't ask; otherwise it asks, as the
  // Scenarios card always did.
  const load = useCallback((s: SavedScenario) => {
    if (state.kind !== 'saved' && !confirm(`Load “${s.name}”? It replaces the Forecast’s current inputs (your accounts, balances and today’s ages stay as they are). Save the current inputs first if you want to keep them.`)) return false;
    onLoad(s.settings);
    setFrom(s.id);
    setMsg({ text: `Loaded “${s.name}”.`, error: false });
    return true;
  }, [state.kind, onLoad, setFrom]);

  const toggleCompare = useCallback((id: string) => {
    setCompareIds(p => (p.includes(id) ? p.filter(x => x !== id) : p.length >= MAX_COMPARE ? p : [...p, id]));
    setHidden(h => h.filter(x => x !== id));
  }, []);
  const stopCompare = useCallback(() => { setCompareIds([]); setHidden([]); }, []);
  const toggleShown = useCallback((id: string) => setHidden(h => (h.includes(id) ? h.filter(x => x !== id) : [...h, id])), []);

  // Ticked scenarios that still exist, in tick order (the order sets the colour).
  const validIds = compareIds.filter(id => list.some(s => s.id === id));
  const jobs = useMemo(() => {
    if (!baseInput) return [];
    return validIds.map((id, slot) => {
      const s = list.find(x => x.id === id) as SavedScenario;
      const input = scenarioSimInput(baseInput, s.settings, contribFor);
      return { id, slot, input, hash: hashInputs(input), shown: !hidden.includes(id) };
    });
  }, [baseInput, validIds.join('|'), hidden.join('|'), list, contribFor]); // eslint-disable-line react-hooks/exhaustive-deps

  // Median lines: shown scenarios only, a moment after the inputs settle, one
  // simulation per task so typing and dragging stay smooth. The last line for a
  // scenario stays drawn until its new one is ready.
  const [lines, setLines] = useState<Record<string, { hash: string; bands: { age: number; p50: number }[] }>>({});
  useEffect(() => {
    const todo = jobs.filter(j => j.shown && lines[j.id]?.hash !== j.hash);
    if (!todo.length) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const step = (i: number) => {
      if (cancelled || i >= todo.length) return;
      const j = todo[i];
      let bands = lineCache.get(j.hash);
      if (!bands) {
        bands = runForecastSim(j.input).bands.map(b => ({ age: b.age, p50: b.p50 }));
        lineCache.set(j.hash, bands);
      }
      const b = bands;
      setLines(prev => ({ ...prev, [j.id]: { hash: j.hash, bands: b } }));
      timer = setTimeout(() => step(i + 1), 0);
    };
    timer = setTimeout(() => step(0), todo.every(j => lineCache.get(j.hash)) ? 0 : 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [jobs]); // eslint-disable-line react-hooks/exhaustive-deps

  const slots = useMemo<CompareSlot[]>(() => jobs.map(j => ({
    id: j.id, slot: j.slot, key: scenarioKey(j.slot), color: SCENARIO_COLORS[j.slot % SCENARIO_COLORS.length],
    name: list.find(s => s.id === j.id)?.name ?? '', shown: j.shown, bands: lines[j.id]?.bands ?? null,
  })), [jobs, lines, list]);

  // The side-by-side figures: the current inputs and each shown scenario.
  const currentName = state.kind === 'saved' ? state.name : 'Current inputs';
  const cols = useMemo(() => {
    if (!baseInput || !current || !jobs.length) return [];
    const cur = scenarioSimInput(baseInput, current, contribFor);
    return [{ id: CURRENT, input: cur }, ...jobs.filter(j => j.shown).map(j => ({ id: j.id, input: j.input }))]
      .map(c => ({ ...c, key: hashInputs({ input: c.input, targets, runs: SOLVER_RUNS }) }));
  }, [baseInput, current, contribFor, jobs, targets]);
  const colKeys = cols.map(c => c.key).join('|');
  const [table, setTable] = useState<CompareTable>({ status: 'idle' });
  const lastDone = useRef<CompareCols | null>(null);
  useEffect(() => {
    if (!cols.length) { setTable({ status: 'idle' }); return; }
    const keys = cols.map(c => c.key);
    const hits = cols.map(c => rowCache.get(c.key) ?? null);
    const todo = cols.map((c, i) => (hits[i] ? -1 : i)).filter(i => i >= 0);
    const finish = (solved: ScenarioRow[]) => {
      const rows = hits.slice();
      todo.forEach((ci, j) => { rows[ci] = solved[j]; rowCache.set(cols[ci].key, solved[j]); });
      const done = cols.map((c, i) => ({ id: c.id, row: rows[i] as ScenarioRow, endAge: c.input.A.endAge }));
      lastDone.current = done;
      setTable({ status: 'done', keys, cols: done });
    };
    if (!todo.length) { finish([]); return; }
    const cached = cols.length - todo.length;
    setTable({ status: 'running', done: cached, total: cols.length, keys, prev: lastDone.current });
    let cancel = () => {};
    const t = setTimeout(() => {
      cancel = runSolveJob({ kind: 'rows', inputs: todo.map(i => cols[i].input), targets }, {
        onProgress: n => setTable({ status: 'running', done: cached + n, total: cols.length, keys, prev: lastDone.current }),
        onDone: finish,
        onError: () => setTable({ status: 'error' }),
      });
    }, 600);
    return () => { clearTimeout(t); cancel(); };
  }, [colKeys]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    ready: !!current, list, state, label, msg, setMsg, saveAs, saveChanges, rename, remove, load,
    compareIds: validIds, toggleCompare, stopCompare, toggleShown, slots, table, targets, currentName,
  };
}
