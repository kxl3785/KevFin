import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MAX_COMPARE, MAX_NAME_LENGTH, SCENARIO_COLORS } from '../../lib/forecastScenarios.ts';
import { fmtDate } from '../../lib/format.ts';
import type { ScenariosApi } from './useScenarios.ts';

// The scenario switcher beside the Forecast's title: a button naming the
// scenario the page's inputs are (or "Current inputs" / "Unsaved changes"), and
// a menu to load a saved scenario, tick up to four to compare on the chart,
// rename or delete one, and save the current inputs under a name. It replaces
// the old Scenarios card; menu styles are the Dashboard's .db-menu, as the
// chart's Baseline menu (BaselineMenu.tsx) uses.
//
// Keyboard: the arrow keys (and Home / End) move between the menu's items,
// Escape closes it (or first cancels a name being typed) and hands focus back
// to the button.

const ITEMS = '[role="menuitem"]:not([disabled]), [role="menuitemradio"]:not([disabled]), [role="menuitemcheckbox"]:not([aria-disabled="true"])';

// The name box shared by "Save as…", rename and What if's "Save as scenario".
export function ScenarioNameForm({ initial = '', submitLabel, onSubmit, onCancel, label = 'Scenario name' }: {
  initial?: string; submitLabel: string; label?: string;
  onSubmit: (name: string) => boolean;   // false keeps the form open (an error, or the user said no)
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  return (
    <form className="fc-scn-form" onSubmit={e => { e.preventDefault(); onSubmit(name); }}>
      <input ref={ref} type="text" value={name} maxLength={MAX_NAME_LENGTH} aria-label={label} placeholder="e.g. Retire at 60"
        onChange={e => setName(e.target.value)}
        onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); } }} />
      <button type="submit" className="btn-primary btn-sm" disabled={!name.trim()}>{submitLabel}</button>
      <button type="button" className="btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
    </form>
  );
}

export default function ScenarioSwitcher({ scn }: { scn: ScenariosApi }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<null | { kind: 'save' } | { kind: 'rename'; id: string; name: string }>(null);
  const [shift, setShift] = useState(0);
  // A menu item to focus once the menu has re-rendered (after a rename, a save or
  // a delete), by CSS selector.
  const [focusNext, setFocusNext] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { list, state, label, msg } = scn;

  const close = (focusButton = true) => {
    setOpen(false); setForm(null);
    if (focusButton) btnRef.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => { if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) { setOpen(false); setForm(null); } };
    window.addEventListener('pointerdown', down);
    return () => window.removeEventListener('pointerdown', down);
  }, [open]);
  // Opening: clear an old message, move focus to the current scenario (or the
  // first item), and keep the menu inside the window on a narrow screen.
  useLayoutEffect(() => {
    if (!open) { setShift(0); return; }
    const m = menuRef.current, w = wrapRef.current;
    if (!m || !w) return;
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const left = w.getBoundingClientRect().left, width = m.offsetWidth;
    setShift(Math.min(0, vw - 16 - width - left));
  }, [open]);
  useEffect(() => {
    if (!open || form) return;
    const m = menuRef.current;
    const target = m?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]') ?? m?.querySelector<HTMLElement>(ITEMS);
    target?.focus();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!focusNext) return;
    const m = menuRef.current;
    (m?.querySelector<HTMLElement>(focusNext) ?? m?.querySelector<HTMLElement>(ITEMS))?.focus();
    setFocusNext(null);
  }, [focusNext]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])];
    if (!items.length) return;
    e.preventDefault();
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1
      : e.key === 'ArrowDown' || e.key === 'ArrowRight' ? (i + 1) % items.length
      : (i <= 0 ? items.length - 1 : i - 1);
    items[next].focus();
  };

  const openMenu = () => { scn.setMsg(null); setForm(null); setOpen(o => !o); };
  const full = scn.compareIds.length >= MAX_COMPARE;
  const status = state.kind === 'edited' ? `Edited since you loaded or saved “${state.name}”` : state.kind === 'saved' ? `These inputs are saved as “${state.name}”` : 'These inputs aren’t saved as a scenario';

  return (
    <div ref={wrapRef} className="db-menu-wrap fc-scn" onKeyDown={open ? onKeyDown : undefined}>
      <button ref={btnRef} type="button" className={'btn-ghost btn-sm fc-scn-btn' + (state.kind === 'edited' ? ' edited' : '')}
        aria-haspopup="menu" aria-expanded={open} aria-label={`Scenario: ${label}`} title={status}
        disabled={!scn.ready} onClick={openMenu}>
        {state.kind === 'edited' && <span className="fc-scn-dot" aria-hidden="true" />}
        <span className="fc-scn-name">{label}</span>
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div ref={menuRef} className="db-menu fc-scn-menu" role="menu" aria-label="Scenarios" style={{ left: shift }}>
          <div className="fc-scn-info">
            {status}.
            {' '}A scenario keeps everything you’ve set on this page — not your accounts, balances or today’s ages.
          </div>
          {list.length === 0 && <p className="fc-scn-empty">No saved scenarios yet.</p>}
          {list.map(s => {
            const onIt = state.kind === 'saved' && state.id === s.id;
            const slot = scn.compareIds.indexOf(s.id);
            const compared = slot >= 0;
            if (form?.kind === 'rename' && form.id === s.id) {
              return (
                <div key={s.id} className="fc-scn-row editing" role="group" aria-label={`Rename ${s.name}`}>
                  <ScenarioNameForm initial={s.name} submitLabel="Save name" label={`New name for ${s.name}`}
                    onSubmit={n => { const ok = scn.rename(s.id, n); if (ok) { setForm(null); setFocusNext(`[data-scn="${s.id}"]`); } return ok; }}
                    onCancel={() => { setForm(null); setFocusNext(`[data-scn="${s.id}"]`); }} />
                </div>
              );
            }
            return (
              <div key={s.id} className="fc-scn-row" role="none">
                <button type="button" role="menuitemradio" aria-checked={onIt} data-scn={s.id} className="fc-scn-load"
                  onClick={() => { if (onIt) { close(); return; } if (scn.load(s)) close(); }}>
                  <span className="fc-scn-check" aria-hidden="true">{onIt ? '✓' : ''}</span>
                  <span className="fc-scn-text">
                    <span className="fc-scn-title">{s.name}</span>
                    <small>{onIt ? 'On this page' : 'Load'}{s.savedAt ? ` · saved ${fmtDate(new Date(s.savedAt))}` : ''}</small>
                  </span>
                </button>
                <button type="button" role="menuitemcheckbox" aria-checked={compared} className={'fc-scn-cmp' + (compared ? ' on' : '')}
                  aria-disabled={!compared && full ? 'true' : undefined}
                  aria-label={`Compare ${s.name} on the chart`} title={!compared && full ? `Compare up to ${MAX_COMPARE} at a time` : compared ? 'Stop comparing this one' : 'Draw it on the chart'}
                  onClick={() => { if (!compared && full) return; scn.toggleCompare(s.id); }}>
                  <span className="fc-scn-swatch" aria-hidden="true" style={compared ? { background: SCENARIO_COLORS[slot], borderColor: SCENARIO_COLORS[slot] } : undefined} />
                  Compare
                </button>
                <button type="button" role="menuitem" className="fc-scn-icon" aria-label={`Rename ${s.name}`} title="Rename"
                  onClick={() => { scn.setMsg(null); setForm({ kind: 'rename', id: s.id, name: s.name }); }}>✎</button>
                <button type="button" role="menuitem" className="fc-scn-icon" aria-label={`Delete ${s.name}`} title="Delete"
                  onClick={() => { scn.remove(s); setFocusNext(ITEMS); }}>🗑</button>
              </div>
            );
          })}
          <div className="fc-scn-sep" role="separator" />
          {form?.kind === 'save' ? (
            <div role="group" aria-label="Save the current inputs as a scenario" className="fc-scn-row editing">
              <ScenarioNameForm submitLabel="Save"
                onSubmit={n => { const ok = scn.saveAs(n); if (ok) { setForm(null); setFocusNext('[role="menuitemradio"][aria-checked="true"]'); } return ok; }}
                onCancel={() => { setForm(null); setFocusNext('[data-scn-save]'); }} />
            </div>
          ) : (
            <button type="button" role="menuitem" data-scn-save onClick={() => { scn.setMsg(null); setForm({ kind: 'save' }); }}>
              Save current inputs as…
              <small>A new scenario; or type a saved name to replace it</small>
            </button>
          )}
          {state.kind === 'edited' && (
            <button type="button" role="menuitem" onClick={() => { scn.saveChanges(); }}>
              Save changes to “{state.name}”
              <small>Replaces the saved scenario with the current inputs</small>
            </button>
          )}
          {scn.compareIds.length > 0 && (
            <button type="button" role="menuitem" onClick={() => { scn.stopCompare(); close(); }}>
              Stop comparing
              <small>Removes the scenario lines from the chart</small>
            </button>
          )}
          <p className={'fc-scn-msg' + (msg?.error ? ' error' : '')} role={msg?.error ? 'alert' : 'status'} aria-live="polite">{msg?.text ?? ''}</p>
        </div>
      )}
    </div>
  );
}
