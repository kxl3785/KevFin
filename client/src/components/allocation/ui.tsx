// Shared presentation for the Investments page's cards (allocation grid,
// returns, rebalancing worksheet, fee check-up), so they share one look: the
// same card box, title row, collapse control, stat tiles, sub-headings,
// disclosure buttons, footers and loading placeholders. Presentation only —
// nothing here fetches, computes or stores anything.

import InfoTip from './InfoTip.tsx';

/** The card box every Investments card uses. */
export const CARD: React.CSSProperties = {
  background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 20,
  minWidth: 0,
};

/** Running text: readable line length on a wide screen. */
export const PROSE: React.CSSProperties = { fontSize: 13, lineHeight: 1.5, maxWidth: '72ch' };

/** Small muted note (12px), still kept to a readable line length. */
export const NOTE: React.CSSProperties = { fontSize: 12, lineHeight: 1.5, color: 'var(--muted)', maxWidth: '72ch' };

/** The one "Estimates for planning, not advice" line at the foot of a card. */
export const FOOTER: React.CSSProperties = { ...NOTE, marginTop: 16 };

/** Table column headings (matches the Positions table). */
export const TH: React.CSSProperties = {
  fontSize: 12, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4,
};

/** Right-aligned figure in a table. */
export const NUM: React.CSSProperties = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };

// The collapse control, same as the Forecast page's section toggles: the
// whole title is a real button with aria-expanded, "▸ Show" / "▾ Hide" on the
// right.
function CollapseTitle({ title, open, onToggle, controls, ariaLabel }: {
  title: React.ReactNode; open: boolean; onToggle: () => void; controls?: string; ariaLabel?: string;
}) {
  return (
    <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0, flex: 1, minWidth: 0 }}>
      <button type="button" aria-label={ariaLabel} aria-expanded={open} aria-controls={open ? controls : undefined} onClick={onToggle}
        title={open ? 'Collapse' : 'Expand'}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between', width: '100%', minHeight: 32,
          background: 'none', border: 'none', padding: 0, borderRadius: 4, color: 'inherit', font: 'inherit', textAlign: 'left', cursor: 'pointer',
        }}>
        <span>{title}</span>
        <span aria-hidden="true" style={{ fontSize: 13, fontWeight: 400, color: 'var(--muted)', userSelect: 'none', whiteSpace: 'nowrap' }}>{open ? '▾ Hide' : '▸ Show'}</span>
      </button>
    </h2>
  );
}

/**
 * Card title row: one 16px title, an optional info tip beside it, optional
 * controls on the right, and at most one short muted line underneath. With
 * `collapse` the title becomes the shared show/hide button.
 */
export function CardHeader({ title, titleId, tip, tipLabel, subtitle, controls, collapse, reserveRight = 0 }: {
  title: React.ReactNode;
  /** Name for the title's info tip when the title isn't plain text. */
  tipLabel?: string;
  titleId?: string;
  tip?: React.ReactNode;
  subtitle?: React.ReactNode;
  controls?: React.ReactNode;
  collapse?: { open: boolean; onToggle: () => void; controls?: string; ariaLabel?: string };
  /** Room kept free on the right for the grid's drag / resize handles. */
  reserveRight?: number;
}) {
  return (
    <div style={{ marginBottom: subtitle ? 14 : 12, paddingRight: reserveRight }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px 12px', flexWrap: 'wrap', minHeight: 32 }}>
        {collapse ? (
          <CollapseTitle title={title} open={collapse.open} onToggle={collapse.onToggle} controls={collapse.controls} ariaLabel={collapse.ariaLabel} />
        ) : (
          <h2 id={titleId} style={{ fontSize: 16, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            {title}
            {tip && <InfoTip label={tipLabel ?? (typeof title === 'string' ? title : undefined)}>{tip}</InfoTip>}
          </h2>
        )}
        {controls && <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginLeft: 'auto' }}>{controls}</div>}
      </div>
      {subtitle && <p style={{ ...NOTE, maxWidth: '96ch', marginTop: 2 }}>{subtitle}</p>}
    </div>
  );
}

/** Sub-heading inside a card ("What each holding costs"). */
export function SubHeading({ children, tip, tipLabel, style }: {
  children: React.ReactNode; tip?: string; tipLabel?: string; style?: React.CSSProperties;
}) {
  return (
    <h3 style={{ fontSize: 14, fontWeight: 600, margin: '20px 0 8px', display: 'flex', alignItems: 'center', gap: 6, ...style }}>
      {children}
      {tip && <InfoTip text={tip} label={tipLabel} />}
    </h3>
  );
}

/**
 * One headline figure: small muted label (wraps, never cut off), big tabular
 * value with an optional unit beside it, one muted line under it.
 */
export function StatTile({ label, tip, tipLabel, value, unit, sub, color = 'var(--text)' }: {
  label: string;
  tip?: React.ReactNode;
  /** Name for the tip's button; defaults to the label ("More about …"). Pass '' for plain "More info". */
  tipLabel?: string;
  value: React.ReactNode;
  unit?: React.ReactNode;
  sub?: React.ReactNode;
  color?: string;
}) {
  return (
    <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 6, fontSize: 12, lineHeight: 1.35, color: 'var(--muted)' }}>
        <span style={{ minWidth: 0 }}>{label}</span>
        {tip && <InfoTip label={tipLabel === undefined ? label : tipLabel || undefined}>{tip}</InfoTip>}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.15, letterSpacing: '-0.3px', fontVariantNumeric: 'tabular-nums', color }}>{value}</span>
        {unit && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{unit}</span>}
      </div>
      {sub && <div style={{ fontSize: 12, lineHeight: 1.4, color: 'var(--muted)', marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

/** Grid for a row of StatTiles: as many across as fit, two across on a phone. */
export function tileGrid(isMobile: boolean, min = 190): React.CSSProperties {
  return {
    display: 'grid', gap: 10,
    gridTemplateColumns: isMobile ? 'repeat(2, minmax(0, 1fr))' : `repeat(auto-fit, minmax(min(100%, ${min}px), 1fr))`,
  };
}

/** Small "▸ Label" button that shows or hides a panel below it. */
export function DisclosureButton({ open, onToggle, controls, children }: {
  open: boolean; onToggle: () => void; controls: string; children: React.ReactNode;
}) {
  return (
    <button type="button" className="btn-ghost btn-sm" aria-expanded={open} aria-controls={controls} onClick={onToggle}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 32, background: open ? 'var(--surface-2)' : undefined }}>
      <span aria-hidden="true" style={{ fontSize: 10, color: 'var(--muted)' }}>{open ? '▾' : '▸'}</span>
      {children}
    </button>
  );
}

/** Muted dot-separated facts on one wrapping line. */
export function FactRow({ items, style }: { items: React.ReactNode[]; style?: React.CSSProperties }) {
  const shown = items.filter(Boolean);
  if (!shown.length) return null;
  return (
    <p style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--muted)', display: 'flex', flexWrap: 'wrap', columnGap: 0, ...style }}>
      {shown.map((it, i) => (
        <span key={i}>
          {it}
          {i < shown.length - 1 && <span aria-hidden="true" style={{ margin: '0 8px', opacity: 0.6 }}>·</span>}
        </span>
      ))}
    </p>
  );
}

// Loading placeholders. The keyframes live here (the page is styled inline);
// motion is switched off for people who ask for reduced motion.
const SKELETON_CSS = `
@keyframes kf-skel-pulse { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }
.kf-skel { animation: kf-skel-pulse 1.6s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .kf-skel { animation: none; } }
`;

export function SkeletonStyles() {
  return <style>{SKELETON_CSS}</style>;
}

/** One grey placeholder bar. Render <SkeletonStyles /> once nearby. */
export function SkeletonBar({ width = '100%', height = 12, style }: { width?: number | string; height?: number; style?: React.CSSProperties }) {
  return <div className="kf-skel" style={{ width, height, borderRadius: 6, background: 'var(--surface-2)', ...style }} />;
}

/** A card-shaped placeholder: a title bar, a subtitle bar and some rows. */
export function SkeletonCard({ height, rows = 6 }: { height: number; rows?: number }) {
  return (
    <div style={{ ...CARD, height, overflow: 'hidden', boxSizing: 'border-box' }}>
      <SkeletonBar width="38%" height={16} />
      <SkeletonBar width="64%" height={10} style={{ marginTop: 10 }} />
      <div style={{ display: 'grid', gap: 30, marginTop: 30 }}>
        {Array.from({ length: rows }, (_, i) => (
          <div key={i}>
            <SkeletonBar width={`${30 + ((i * 17) % 40)}%`} height={10} />
            <SkeletonBar width={`${85 - ((i * 13) % 45)}%`} height={6} style={{ marginTop: 8 }} />
          </div>
        ))}
      </div>
    </div>
  );
}
