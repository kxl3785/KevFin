import type { ReactNode } from 'react';
import { FitTip } from './FitTip.tsx';

// Shared presentation for the Forecast's cards, so every card reads the same:
// one title row that is the collapse button (chevron at the far right, like the
// input groups), one muted line under it with optional controls at its right,
// one stat-tile style and a small muted footer. Styles live in index.css under
// "Forecast page". Purely presentational: no state, no data.

// The title row. With `onToggle` the whole row is a button reporting
// aria-expanded; without it the title is plain text.
export function CardHead({ title, note, open = true, onToggle }: {
  title: ReactNode;
  note?: ReactNode;        // a short muted aside after the title (e.g. "today's dollars")
  open?: boolean;
  onToggle?: () => void;
}) {
  const inner = (<>
    <span>{title}{note ? <span className="fc-head-note"> · {note}</span> : null}</span>
    {onToggle && <span aria-hidden="true" className="fc-chev">{open ? '▾' : '▸'}</span>}
  </>);
  return (
    <h2 className="fc-head">
      {onToggle
        ? <button type="button" className="fc-head-btn" aria-expanded={open} onClick={onToggle}>{inner}</button>
        : <span className="fc-head-btn">{inner}</span>}
    </h2>
  );
}

// The one muted line under the title (with an optional "i" for the rest of the
// explanation), and the card's controls at its right.
export function CardMeta({ children, tip, tipLabel, controls }: {
  children?: ReactNode; tip?: string; tipLabel?: string; controls?: ReactNode;
}) {
  return (
    <div className="fc-meta">
      {(children || tip) && (
        <p className="fc-meta-text" style={{ margin: 0 }}>
          {children}
          {tip && <InlineTip label={tipLabel ?? 'More about this card'} text={tip} />}
        </p>
      )}
      {controls && <div className="fc-controls">{controls}</div>}
    </div>
  );
}

// One stat tile: small label (+ "i"), big value, one sub-line. `children` sits
// between the value and the sub-line (e.g. a progress bar).
export function StatTile({ label, value, sub, tip, tipLabel, color, children }: {
  label: string; value: ReactNode; sub?: ReactNode; tip?: string; tipLabel?: string; color?: string; children?: ReactNode;
}) {
  return (
    <div className="fc-tile">
      <p className="fc-tile-label">
        <span>{label}</span>
        {tip && <FitTip label={tipLabel ?? `About ${label.toLowerCase()}`} text={tip} />}
      </p>
      <p className="fc-tile-value" style={color ? { color } : undefined}>{value}</p>
      {children}
      {sub ? <p className="fc-tile-sub">{sub}</p> : null}
    </div>
  );
}

// A grid of tiles: `cols` across on a wide card, two across on a narrow one.
export function Tiles({ cols = 4, dim = false, children }: { cols?: number; dim?: boolean; children: ReactNode }) {
  return (
    <div className={'fc-tiles' + (cols === 3 ? ' fc-tiles-3' : '')} style={{ ['--fc-cols' as string]: cols, opacity: dim ? 0.55 : 1 } as React.CSSProperties}>
      {children}
    </div>
  );
}

// An "i" that sits in a line of running text (after a sentence), wrapping with it.
export function InlineTip({ text, label, width = 300 }: { text: string; label: string; width?: number }) {
  return (
    <span className="fc-tip-wrap" style={{ display: 'inline-flex', verticalAlign: -2, margin: '0 2px 0 6px' }}>
      <FitTip label={label} text={text} width={width} />
    </span>
  );
}
