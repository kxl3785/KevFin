import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { planVsActual, trackStatus, trackTileText, type PinnedBaseline } from '../../lib/planTrack.ts';
import { fmtDate } from '../../lib/format.ts';
import PlanVsActual, { trackTone } from './PlanVsActual.tsx';

// The "Today against your plan" headline tile: today's net worth, then how far
// ahead of or behind the pinned plan (📌 Baseline) it is and when that plan was
// pinned. It is a button: it opens a panel with the tracking detail (the
// recorded-against-plan chart and its sentence), the pin / pin again / clear
// actions, and the breakdown of today's figure. With no pin, the tile says so and
// the panel offers to pin one. Replaces the old "Are you on track?" card.
//
// The panel is a non-modal popover: focus moves into it on open; Escape, the ✕
// or a press outside closes it, and focus goes back to the tile.

// "Mar 3" (with the year only when it isn't this year), to keep the tile short.
const day = (t: number) => { const d = new Date(t); return fmtDate(d, { year: d.getFullYear() !== new Date().getFullYear() }); };

export default function TodayTile({ value, asOf, baseline, history, money, privacy, breakdown, onPin, onRepin, onClear }: {
  value: string;                        // today's net worth, formatted (masked in privacy mode)
  asOf: string | null;                  // "Nov 26, 2026"
  baseline: PinnedBaseline | null;
  history: { date: string; net_worth: number }[] | null;
  money: (n: number) => string;
  privacy: boolean;
  breakdown: ReactNode;                 // what today's figure is made of
  onPin: () => void;
  onRepin: () => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const data = useMemo(() => planVsActual(baseline, history), [baseline, history]);
  const status = useMemo(() => trackStatus(data, baseline, money, day), [data, baseline, money]);
  const tile = trackTileText(status, day);

  const close = () => { setOpen(false); btnRef.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus({ preventScroll: true });
    const down = (e: PointerEvent) => { if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('pointerdown', down);
    return () => window.removeEventListener('pointerdown', down);
  }, [open]);
  // Each action closes the panel (a confirm may come first, from the page).
  const act = (fn: () => void) => () => { fn(); close(); };

  return (
    <div ref={wrapRef} className="fc-kpi fc-kpi-track">
      <button ref={btnRef} type="button" className="fc-kpi-hit" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
        onClick={() => setOpen(o => !o)}>
        <span className="fc-kpi-label"><span>Today against your plan</span></span>
        <span className="fc-kpi-value">{value}</span>
        <span className="fc-kpi-sub fc-track-tile-head" style={{ color: trackTone(status) }}>{tile.head}</span>
        <span className="fc-kpi-sub">{tile.detail} <span aria-hidden="true">▸</span></span>
      </button>
      {open && (
        <div ref={panelRef} id={id} className="fc-track-pop" role="dialog" aria-labelledby={id + '-t'} tabIndex={-1}
          onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } }}>
          <div className="fc-track-top">
            <h3 id={id + '-t'}>Today against your plan</h3>
            <button type="button" className="btn-ghost btn-sm fc-track-x" aria-label="Close" onClick={close}>✕</button>
          </div>
          <PlanVsActual data={data} status={status} money={money} privacy={privacy} />
          <div className="fc-track-actions">
            {baseline ? (<>
              <button type="button" className="btn-ghost btn-sm" onClick={act(onRepin)} title="Replaces the plan; tracking restarts from today">Pin the current projection instead</button>
              <button type="button" className="btn-ghost btn-sm" onClick={act(onClear)} title="Removes the baseline line and ends plan tracking">Clear the pin</button>
            </>) : (
              <button type="button" className="btn-primary btn-sm" onClick={act(onPin)}>📌 Pin the current projection as your plan</button>
            )}
          </div>
          <div className="fc-track-today">
            <p className="fc-track-sub">Today’s net worth{asOf ? `, as of ${asOf}` : ''}</p>
            {breakdown}
          </div>
        </div>
      )}
    </div>
  );
}
