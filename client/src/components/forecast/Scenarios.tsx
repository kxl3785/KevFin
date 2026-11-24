import { useEffect, useMemo, useRef, useState } from 'react';
import type { Pools, SimInput } from '../../lib/forecastSim.ts';
import {
  SCENARIOS_KEY, MAX_COMPARE, MAX_NAME_LENGTH, normalizeScenarios, saveScenario, renameScenario, deleteScenario, scenarioSimInput,
  findByName, cleanName, type SavedScenario, type ScenarioSettings,
} from '../../lib/forecastScenarios.ts';
import { hashInputs, AnswerCache, SOLVER_RUNS, DEFAULT_TARGETS, normalizeTargets, type ScenarioRow, type SolveTargets } from '../../lib/forecastSolve.ts';
import { runSolveJob } from '../../lib/solveDriver.ts';
import { usePersistentState } from '../../hooks/usePersistentState.ts';
import { fmtDate } from '../../lib/format.ts';
import { FitTip as Tip } from './FitTip.tsx';
import { CardHead, CardMeta } from './ui.tsx';

// Named scenarios: save the Forecast's full set of inputs under a name, then load,
// rename, delete, or compare up to four side by side. Saved under their own prefs
// key (never sent to the AI assistant). Comparisons are computed only when asked,
// on a background thread (lib/solveDriver.ts), and remembered per set of inputs.
// Its own card on the Forecast page; the confidence it compares at is the one
// chosen on "What your plan supports" (read here from the same pref, not written).

const CURRENT = '__current__';
const rowCache = new AnswerCache<ScenarioRow>(32);
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

type Compare =
  | { status: 'idle' }
  | { status: 'running'; done: number; total: number; keys: string[] }
  | { status: 'done'; keys: string[]; targets: SolveTargets; cols: { id: string; name: string; row: ScenarioRow; endAge: number }[] };

export default function Scenarios({ current, baseInput, contribFor, onLoad, money, onWide }: {
  current: ScenarioSettings | null;     // the Forecast's inputs right now
  baseInput: SimInput | null;           // the page's plan input (today's balances), null until data loads
  contribFor: (c: Record<string, number>) => Pools;
  onLoad: (s: ScenarioSettings) => void;
  money: (n: number) => string;         // the page's formatter (masks in privacy mode)
  onWide?: (wide: boolean) => void;     // layout hint: a 3–4 column comparison wants the full page width
}) {
  const [targetsRaw] = usePersistentState<SolveTargets>('mon.fcSolveTargets', DEFAULT_TARGETS);
  const targets = useMemo(() => normalizeTargets(targetsRaw), [targetsRaw]);
  const [open, setOpen] = useState(true);
  const [raw, setRaw] = usePersistentState<SavedScenario[]>(SCENARIOS_KEY, []);
  const list = useMemo(() => normalizeScenarios(raw), [raw]);
  const [name, setName] = useState('');
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [picked, setPicked] = useState<string[]>([CURRENT]);
  const [cmp, setCmp] = useState<Compare>({ status: 'idle' });
  const cancelRef = useRef<() => void>(() => {});
  useEffect(() => () => cancelRef.current(), []);

  const muted: React.CSSProperties = { fontSize: 12, color: 'var(--muted)', margin: '6px 0 0', lineHeight: 1.5 };
  // Tell the page when the comparison table needs the full width.
  const wide = open && cmp.status === 'done' && cmp.cols.length >= 3;
  useEffect(() => { onWide?.(wide); }, [wide, onWide]);
  const pct = (v: number) => `${Math.round(v * 100)}%`;

  // Drop picks of scenarios that were deleted.
  const validPicked = picked.filter(id => id === CURRENT || list.some(s => s.id === id));

  const save = () => {
    if (!current) return;
    // Match names exactly as saveScenario does (spaces collapsed, any case), so a
    // name that would replace a saved scenario always asks first.
    const n = cleanName(name);
    const existing = findByName(list, n);
    if (existing && !confirm(`Replace the saved scenario “${existing.name}” with the current inputs?`)) return;
    const r = saveScenario(list, n, current, { now: Date.now(), id: newId() });
    if (!r.ok) { setMsg({ text: r.error, error: true }); return; }
    setRaw(r.list);
    setName('');
    setMsg({ text: existing ? `Replaced “${n}”.` : `Saved “${n}”.`, error: false });
  };
  const commitRename = () => {
    if (!editing) return;
    const r = renameScenario(list, editing.id, editing.name);
    if (!r.ok) { setMsg({ text: r.error, error: true }); return; }
    setRaw(r.list);
    setEditing(null);
    setMsg(null);
  };
  const remove = (s: SavedScenario) => {
    if (!confirm(`Delete the scenario “${s.name}”? This can’t be undone.`)) return;
    setRaw(deleteScenario(list, s.id));
    setPicked(p => p.filter(id => id !== s.id));
    setMsg({ text: `Deleted “${s.name}”.`, error: false });
  };
  const load = (s: SavedScenario) => {
    if (!confirm(`Load “${s.name}”? It replaces the Forecast’s current inputs (your accounts, balances and today’s ages stay as they are). Save the current inputs first if you want to keep them.`)) return;
    onLoad(s.settings);
    setMsg({ text: `Loaded “${s.name}”.`, error: false });
  };
  const togglePick = (id: string) => setPicked(p => (p.includes(id) ? p.filter(x => x !== id) : p.length >= MAX_COMPARE ? p : [...p, id]));

  // The inputs to compare, with a key per column (scenario + targets) for the cache.
  const columns = useMemo(() => {
    if (!baseInput) return [];
    return validPicked.map(id => {
      const settings = id === CURRENT ? current : list.find(s => s.id === id)?.settings ?? null;
      if (!settings) return null;
      const input = scenarioSimInput(baseInput, settings, contribFor);
      return { id, name: id === CURRENT ? 'Current inputs' : list.find(s => s.id === id)?.name ?? '', input, key: hashInputs({ input, targets, runs: SOLVER_RUNS }) };
    }).filter((c): c is NonNullable<typeof c> => !!c);
  }, [baseInput, validPicked.join('|'), current, list, contribFor, targets]); // eslint-disable-line react-hooks/exhaustive-deps
  const colKeys = columns.map(c => c.key);
  const stale = cmp.status === 'done' && cmp.keys.join('|') !== colKeys.join('|');

  const compare = () => {
    if (!columns.length) return;
    cancelRef.current();
    const cols = columns;
    const keys = cols.map(c => c.key);
    const tg = targets;
    // Rows already worked out come from the cache; only the rest are solved.
    const hits = cols.map(c => rowCache.get(c.key) ?? null);
    const todo = cols.map((c, i) => (hits[i] ? -1 : i)).filter(i => i >= 0);
    const finish = (solved: ScenarioRow[]) => {
      const rows = hits.slice();
      todo.forEach((ci, j) => { rows[ci] = solved[j]; rowCache.set(cols[ci].key, solved[j]); });
      setCmp({ status: 'done', keys, targets: tg, cols: cols.map((c, i) => ({ id: c.id, name: c.name, row: rows[i] as ScenarioRow, endAge: c.input.A.endAge })) });
    };
    if (!todo.length) { finish([]); return; }
    const cached = cols.length - todo.length;
    setCmp({ status: 'running', done: cached, total: cols.length, keys });
    cancelRef.current = runSolveJob({ kind: 'rows', inputs: todo.map(i => cols[i].input), targets: tg }, {
      onProgress: n => setCmp({ status: 'running', done: cached + n, total: cols.length, keys }),
      onDone: finish,
      onError: () => { setCmp({ status: 'idle' }); setMsg({ text: 'The comparison could not be worked out for these inputs.', error: true }); },
    });
  };

  const cell: React.CSSProperties = { padding: '7px 10px', borderBottom: '1px solid var(--border)', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
  const head: React.CSSProperties = { ...cell, textAlign: 'left', color: 'var(--muted)', fontWeight: 400, whiteSpace: 'normal' };
  // Under a guardrails rule safe spending is a starting amount; under share of
  // savings it doesn't apply (savings never run out on everyday spending).
  const spendText = (r: ScenarioRow) => (r.safeSpending.status === 'ok' ? `${money(r.safeSpending.amount)}/yr${r.rule === 'guardrails' ? ' to start' : ''}`
    : r.safeSpending.status === 'unbounded' ? 'No limit found'
    : r.safeSpending.status === 'notApplicable' ? 'Doesn’t apply' : 'None');
  // Header names come from the list as it is now, so a rename shows at once.
  const colName = (c: { id: string; name: string }) => (c.id === CURRENT ? 'Current inputs' : list.find(s => s.id === c.id)?.name ?? c.name);
  const anyRule = cmp.status === 'done' && cmp.cols.some(c => c.row.rule !== 'fixed');

  const header = <CardHead title="Scenarios" open={open} onToggle={() => setOpen(o => !o)} />;
  if (!open) return <div className="fc-card fc-closed">{header}</div>;

  return (
    <div className="fc-card">
      {header}
      <CardMeta tipLabel="What a scenario saves"
        tip="A scenario holds everything you’ve set on this page — assumptions, earners, life events, contributions, the what-if levers and the tax, market and spending-rule settings. Your accounts, balances, today’s ages and which accounts are left out are not part of a scenario.">
        Save this page’s inputs under a name, then compare up to {MAX_COMPARE} side by side.
      </CardMeta>

      <form onSubmit={e => { e.preventDefault(); save(); }} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 14 }}>
        <label htmlFor="fc-scn-name" style={{ fontSize: 13, color: 'var(--muted)' }}>Name</label>
        <input id="fc-scn-name" type="text" value={name} maxLength={MAX_NAME_LENGTH} placeholder="e.g. Retire at 60"
          onChange={e => setName(e.target.value)} style={{ flex: '1 1 160px', minWidth: 0, maxWidth: 280, fontSize: 13, padding: '6px 10px' }} />
        <button type="submit" className="btn-primary btn-sm" disabled={!current || !name.trim()}>Save current inputs</button>
      </form>
      <p style={{ ...muted, minHeight: 18, color: msg?.error ? 'var(--red)' : 'var(--muted)' }} role={msg?.error ? 'alert' : 'status'} aria-live="polite">
        {msg?.text ?? ''}
      </p>

      <div role="group" aria-label={`Scenarios to compare (up to ${MAX_COMPARE})`} style={{ marginTop: 2, borderTop: '1px solid var(--border)' }}>
        {[{ id: CURRENT, name: 'Current inputs', savedAt: null as number | null }, ...list.map(s => ({ id: s.id, name: s.name, savedAt: s.savedAt as number | null }))].map(s => {
          const saved = list.find(x => x.id === s.id) ?? null;
          const on = validPicked.includes(s.id);
          const isEditing = editing?.id === s.id;
          return (
            <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', minHeight: 44, padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
              <input type="checkbox" id={`fc-scn-pick-${s.id}`} checked={on} style={{ width: 'auto' }}
                disabled={!on && validPicked.length >= MAX_COMPARE} onChange={() => togglePick(s.id)} />
              {isEditing ? (
                <input type="text" aria-label={`New name for ${s.name}`} value={editing!.name} maxLength={MAX_NAME_LENGTH} autoFocus
                  onChange={e => setEditing({ id: s.id, name: e.target.value })}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commitRename(); } else if (e.key === 'Escape') setEditing(null); }}
                  style={{ flex: '1 1 140px', minWidth: 0, fontSize: 13 }} />
              ) : (
                <label htmlFor={`fc-scn-pick-${s.id}`} style={{ flex: '1 1 140px', minWidth: 0, fontSize: 13, cursor: 'pointer', overflowWrap: 'anywhere' }}>
                  {s.name}
                  {s.savedAt ? <span style={{ color: 'var(--muted)', fontSize: 12 }}> · saved {fmtDate(new Date(s.savedAt))}</span> : null}
                </label>
              )}
              {saved && (
                <div style={{ display: 'flex', gap: 6 }}>
                  {isEditing ? (<>
                    <button type="button" className="btn-primary btn-sm" onClick={commitRename}>Save name</button>
                    <button type="button" className="btn-ghost btn-sm" onClick={() => setEditing(null)}>Cancel</button>
                  </>) : (<>
                    <button type="button" className="btn-ghost btn-sm" onClick={() => load(saved)} aria-label={`Load ${s.name}`}>Load</button>
                    <button type="button" className="btn-ghost btn-sm" onClick={() => setEditing({ id: s.id, name: s.name })} aria-label={`Rename ${s.name}`}>Rename</button>
                    <button type="button" className="btn-ghost btn-sm" onClick={() => remove(saved)} aria-label={`Delete ${s.name}`}>Delete</button>
                  </>)}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {list.length === 0 && <p style={muted}>No saved scenarios yet.</p>}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 14 }}>
        <button type="button" className="btn-primary btn-sm" disabled={!columns.length || cmp.status === 'running'} onClick={compare}>
          {cmp.status === 'done' ? 'Compare again' : 'Compare'}
        </button>
        <span style={{ fontSize: 12, color: 'var(--muted)' }} role="status" aria-live="polite">
          {cmp.status === 'running' ? `Working out ${Math.min(cmp.done + 1, cmp.total)} of ${cmp.total}…`
            : stale ? 'The picks or inputs have changed since this comparison.'
            : `Tick up to ${MAX_COMPARE} to compare.`}
        </span>
        {cmp.status === 'running' && (
          <div role="progressbar" aria-label="Comparison progress" aria-valuemin={0} aria-valuemax={cmp.total} aria-valuenow={cmp.done}
            style={{ flex: '0 1 160px', height: 6, borderRadius: 3, background: 'var(--border)', overflow: 'hidden' }}>
            <div style={{ width: `${(cmp.done / Math.max(1, cmp.total)) * 100}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.2s' }} />
          </div>
        )}
      </div>

      {cmp.status === 'done' && (
        <div style={{ overflowX: 'auto', marginTop: 14, opacity: stale ? 0.55 : 1 }}>
          {/* Capped width, so on a wide card a measure stays near its figures. */}
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 120 + cmp.cols.length * 120, maxWidth: 240 + cmp.cols.length * 200 }}>
            <caption style={{ textAlign: 'left', fontSize: 12, color: 'var(--muted)', paddingBottom: 8 }}>
              Scenarios side by side, today’s dollars, at {pct(cmp.targets.target)} confidence
            </caption>
            <thead>
              <tr>
                <th scope="col" style={head}><span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>Measure</span></th>
                {cmp.cols.map(c => <th key={c.id} scope="col" style={{ ...cell, color: 'var(--text)', fontWeight: 600, whiteSpace: 'normal' }}>{colName(c)}</th>)}
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row" style={head}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>Safe yearly spending
                    <Tip label="About safe yearly spending" text={`The most everyday spending (in $500 steps) that keeps at least ${pct(cmp.targets.target)} of simulated futures from running out.${anyRule ? ' With a guardrails spending rule it is a starting amount the rule cuts in bad years; with a share-of-savings rule it doesn’t apply, because savings never run out on everyday spending.' : ''}`} />
                  </span>
                </th>
                {cmp.cols.map(c => <td key={c.id} style={cell}>{spendText(c.row)}</td>)}
              </tr>
              <tr>
                <th scope="row" style={head}>Retires at</th>
                {cmp.cols.map(c => <td key={c.id} style={cell}>{c.row.retireAge}</td>)}
              </tr>
              <tr>
                <th scope="row" style={head}>Chance money lasts</th>
                {cmp.cols.map(c => <td key={c.id} style={cell}>{pct(c.row.successRate)}</td>)}
              </tr>
              <tr>
                <th scope="row" style={head}>Median net worth at the end</th>
                {cmp.cols.map(c => <td key={c.id} style={cell}>{money(c.row.medianEndReal)}<span style={{ color: 'var(--muted)', fontSize: 12 }}> · age {c.endAge}</span></td>)}
              </tr>
            </tbody>
          </table>
          <p className="fc-foot" style={{ marginTop: 10 }}>Estimates for planning, not advice.</p>
        </div>
      )}
    </div>
  );
}
