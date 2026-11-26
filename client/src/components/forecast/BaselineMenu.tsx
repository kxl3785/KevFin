import { useEffect, useRef, useState, type ReactNode } from 'react';

// The chart's one Baseline control: a 📌 button with a small menu to pin the
// current projection (drawn as a dashed line to compare edits against, and the
// plan "Are you on track?" follows), pin again, or clear it — showing when it was
// pinned and how the forecast differs from it now. Replaces the loose hints that
// used to sit around the chart. Menu styles are the Dashboard's .db-menu.

export default function BaselineMenu({ pinned, pinnedShort, pinnedWhen, deltas, onPin, onRepin, onClear }: {
  pinned: boolean;
  pinnedShort: string;    // "Nov 24" for the button
  pinnedWhen: string;     // "Nov 24, 10:50 AM" for the menu
  deltas: ReactNode;      // the difference from the baseline (or null when none)
  onPin: () => void;
  onRepin: () => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    // Back to the button, so a keyboard user isn't dropped at the top of the page.
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); ref.current?.querySelector('button')?.focus(); } };
    window.addEventListener('pointerdown', down);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', down); window.removeEventListener('keydown', key); };
  }, [open]);
  const pick = (fn: () => void) => () => { setOpen(false); fn(); };

  return (
    <div ref={ref} className="db-menu-wrap">
      <button type="button" className={(pinned ? 'btn-primary' : 'btn-ghost') + ' btn-sm'} aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        title={pinned ? `Baseline pinned ${pinnedWhen}` : 'Pin this projection as a baseline to compare changes against'}>
        <span aria-hidden="true">📌</span> {pinned ? `Baseline: ${pinnedShort}` : 'Baseline'} ▾
      </button>
      {open && (
        <div className="db-menu fc-base-menu" role="menu">
          {pinned && (
            <div className="fc-base-info">
              <div><span className="fc-base-dash" aria-hidden="true" />Pinned {pinnedWhen}</div>
              {deltas ?? <div className="fc-base-same">No change since it was pinned</div>}
            </div>
          )}
          {pinned ? (<>
            <button type="button" role="menuitem" onClick={pick(onRepin)}>
              Pin the current projection instead
              <small>Replaces the baseline; plan tracking restarts from today</small>
            </button>
            <button type="button" role="menuitem" onClick={pick(onClear)}>
              Clear the baseline
              <small>Removes the dashed line and ends plan tracking</small>
            </button>
          </>) : (
            <button type="button" role="menuitem" onClick={pick(onPin)}>
              Pin the current projection
              <small>Drawn as a dashed line to compare changes against; your net worth is tracked against it under “Are you on track?”</small>
            </button>
          )}
          <p className="fc-base-tip">Tip: drag the age axis to the right to show past years (a modeled back-projection), and back to the left to hide them.</p>
        </div>
      )}
    </div>
  );
}
