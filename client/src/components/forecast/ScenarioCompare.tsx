import { useEffect, useRef, useState } from 'react';
import type { ScenarioRow } from '../../lib/forecastSolve.ts';
import { FitTip as Tip } from './FitTip.tsx';
import { ScenarioNameForm } from './ScenarioSwitcher.tsx';
import { CURRENT, type ScenariosApi } from './useScenarios.ts';

// The scenario comparison on the Forecast's main chart: a chip per ticked
// scenario in the chart's toolbar (each switches its line on and off; the name
// is on the chip and in the tooltip, so colour is never the only cue), the
// side-by-side figures under the chart while a comparison is on, and What if's
// "Save as scenario". The lines themselves are drawn by the page's chart from
// useScenarios' slots.

const SR_ONLY: React.CSSProperties = { position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0 };

export function ScenarioChips({ scn, onChart }: { scn: ScenariosApi; onChart: boolean }) {
  if (!scn.ticked) return null;
  return (
    <div className="fc-scn-chips" role="group" aria-label="Scenarios compared on the chart">
      <span className="fc-scn-chip static" title="The page’s own median line (the current inputs)">
        <span className="fc-scn-swatch" aria-hidden="true" style={{ background: 'var(--accent)', borderColor: 'var(--accent)' }} />{scn.currentName}
      </span>
      {scn.slots.map(s => (
        <button key={s.id} type="button" className={'fc-scn-chip' + (s.shown ? ' on' : '')} aria-pressed={s.shown}
          title={s.shown ? `Hide ${s.name}’s line` : `Show ${s.name}’s line`} onClick={() => scn.toggleShown(s.id)}>
          <span className="fc-scn-swatch" aria-hidden="true" style={s.shown ? { background: s.color, borderColor: s.color } : { borderColor: s.color }} />
          {s.name}
          {s.shown && !s.bands && <span className="fc-scn-wait" aria-label="working out">…</span>}
        </button>
      ))}
      <button type="button" className="btn-ghost btn-sm fc-scn-stop" onClick={scn.stopCompare} aria-label="Stop comparing scenarios">✕ Stop comparing</button>
      {!onChart && <span className="fc-scn-note">Scenario lines show on the Net worth chart.</span>}
    </div>
  );
}

// The figures the old side-by-side comparison showed, for the current inputs and
// each shown scenario. Worked out in the background; the last table stays
// (dimmed) while a newer one is worked out.
export function ScenarioTable({ scn, money }: { scn: ScenariosApi; money: (n: number) => string }) {
  const t = scn.table;
  if (!scn.slots.length || t.status === 'idle') return null;
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const cols = t.status === 'done' ? t.cols : t.status === 'running' ? t.prev : null;
  const stale = t.status === 'running';
  const nameOf = (id: string) => (id === CURRENT ? scn.currentName : scn.list.find(s => s.id === id)?.name ?? '');
  const colorOf = (id: string) => (id === CURRENT ? 'var(--accent)' : scn.slots.find(s => s.id === id)?.color ?? 'var(--muted)');
  const spendText = (r: ScenarioRow) => (r.safeSpending.status === 'ok' ? `${money(r.safeSpending.amount)}/yr${r.rule === 'guardrails' ? ' to start' : ''}`
    : r.safeSpending.status === 'unbounded' ? 'No limit found'
    : r.safeSpending.status === 'notApplicable' ? 'Doesn’t apply' : 'None');
  const anyRule = !!cols?.some(c => c.row.rule !== 'fixed');
  const target = pct(scn.targets.target);
  return (
    <div className="fc-scn-table">
      <p className="fc-scn-status" role="status" aria-live="polite">
        {t.status === 'running' ? `Working out the comparison: ${Math.min(t.done + 1, t.total)} of ${t.total}…`
          : t.status === 'error' ? 'The comparison could not be worked out for these inputs.' : ''}
      </p>
      {cols && cols.length > 0 && (
        <div style={{ overflowX: 'auto', opacity: stale ? 0.55 : 1 }}>
          <table>
            <caption>Scenarios side by side, today’s dollars, at {target} confidence</caption>
            <thead>
              <tr>
                <th scope="col"><span style={SR_ONLY}>Measure</span></th>
                {cols.map(c => (
                  <th key={c.id} scope="col" className="fc-scn-col">
                    <span className="fc-scn-swatch" aria-hidden="true" style={{ background: colorOf(c.id), borderColor: colorOf(c.id) }} />{nameOf(c.id)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>Safe yearly spending
                    <Tip label="About safe yearly spending" text={`The most everyday spending (in $500 steps) that keeps at least ${target} of simulated futures from running out.${anyRule ? ' With a guardrails spending rule it is a starting amount the rule cuts in bad years; with a share-of-savings rule it doesn’t apply, because savings never run out on everyday spending.' : ''}`} />
                  </span>
                </th>
                {cols.map(c => <td key={c.id}>{spendText(c.row)}</td>)}
              </tr>
              <tr><th scope="row">Retires at</th>{cols.map(c => <td key={c.id}>{c.row.retireAge}</td>)}</tr>
              <tr><th scope="row">Chance money lasts</th>{cols.map(c => <td key={c.id}>{pct(c.row.successRate)}</td>)}</tr>
              <tr>
                <th scope="row">Median net worth at the end</th>
                {cols.map(c => <td key={c.id}>{money(c.row.medianEndReal)}<span className="fc-scn-age"> · age {c.endAge}</span></td>)}
              </tr>
            </tbody>
          </table>
        </div>
      )}
      <p className="fc-foot" style={{ marginTop: 8 }}>Worked out the way “What your plan supports” is, so a figure can differ slightly from the headline. Estimates for planning, not advice.</p>
    </div>
  );
}

// What if's "Save as scenario": the tried changes (with the rest of the page's
// inputs) saved under a name. The plan itself doesn't change.
export function SaveAsScenarioButton({ scn, disabled }: { scn: ScenariosApi; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('pointerdown', down);
    return () => window.removeEventListener('pointerdown', down);
  }, [open]);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(null), 5000);
    return () => clearTimeout(t);
  }, [done]);
  const close = () => { setOpen(false); btnRef.current?.focus(); };
  const err = open && scn.msg?.error ? scn.msg.text : null;
  return (
    <div ref={ref} className="db-menu-wrap">
      <button ref={btnRef} type="button" className="btn-ghost btn-sm" disabled={disabled || !scn.ready} aria-haspopup="dialog" aria-expanded={open}
        onClick={() => { scn.setMsg(null); setDone(null); setOpen(o => !o); }}
        title="Save these what-if changes, with the rest of this page’s inputs, as a named scenario. Your plan stays as it is.">
        Save as scenario
      </button>
      <span style={SR_ONLY} role="status" aria-live="polite">{done ?? ''}</span>
      {done && !open && <span className="fc-scn-done" aria-hidden="true">Saved as a scenario</span>}
      {open && (
        <div className="db-menu fc-scn-pop" role="dialog" aria-label="Save as scenario"
          onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); close(); } }}>
          <p className="fc-scn-info" style={{ border: 0, margin: 0, padding: '2px 4px 8px' }}>The what-if changes and the rest of this page’s inputs. Your plan stays as it is.</p>
          <ScenarioNameForm submitLabel="Save" onCancel={close}
            onSubmit={n => { const ok = scn.saveAs(n); if (ok) { setDone(`Saved “${n.replace(/\s+/g, ' ').trim()}” as a scenario.`); close(); } return ok; }} />
          {err && <p className="fc-scn-msg error" role="alert">{err}</p>}
        </div>
      )}
    </div>
  );
}
