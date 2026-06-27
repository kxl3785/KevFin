import { useEffect, useState } from 'react';
import { useApi } from '../hooks/useApi.ts';
import { usePersistentState } from '../hooks/usePersistentState.ts';
import WorldMap from '../components/WorldMap.tsx';
import TopNav, { type View } from '../components/TopNav.tsx';
import PerformanceChart from '../components/PerformanceChart.tsx';
import RiskQuestionnaire from '../components/RiskQuestionnaire.tsx';
import { ASSET_CLASS_META, RISK_PROFILES, type ProfileId, type AssetClassKey } from '../lib/riskProfiles.ts';

interface Contributor { label: string; value: number }
interface Slice { name: string; value: number; pct: number; contributors: Contributor[] }
interface StockExposure { symbol: string; name: string; value: number; pct: number; sources: Contributor[]; accounts: AccountHolding[] }
interface AccountHolding { name: string; value: number; costBasis?: number | null }
type CostBasisSource = 'manual' | 'imported' | 'reported' | 'estimated';
interface HoldingRow { symbol: string; name: string; value: number; costBasis: number | null; costBasisCoveredValue: number; costBasisComplete: boolean; costBasisSource: CostBasisSource | null; pct: number; assetClass: string; overridden: boolean; accounts: AccountHolding[] }
interface RealEstateLot { id: number; address: string; equity: number; excluded: boolean }
interface AllocationData { total: number; holdings: HoldingRow[]; bySector: Slice[]; byStock: StockExposure[]; byCountry: Slice[]; byAssetClass: Slice[]; assetClasses: string[]; realEstate: RealEstateLot[] }

const PALETTE = ['#6c8fff', '#4ade80', '#fbbf24', '#f472b6', '#38bdf8', '#a78bfa', '#fb923c', '#34d399', '#f87171', '#c084fc', '#2dd4bf', '#facc15'];

type Money = (n: number) => string;
type Classify = (id: string) => void;

// Stable id for a holding's override, matching the server's holdingId().
const idOf = (symbol: string, name: string) => (symbol && symbol.trim() ? symbol.trim() : name.trim());

interface Row { key: string; label: string; sublabel?: string; value: number; pct: number; detail: Contributor[]; detailHeading: string; accounts?: AccountHolding[] }

const LIMIT = 10;
// Positions list is taller than the bar lists (it sits next to the asset-class
// chart), so it shows more rows by default to fill the box before "Show all".
const POS_LIMIT = 15;

function ExpandableBars({ title, subtitle, rows, money, bare }: { title: string; subtitle?: string; rows: Row[]; money: Money; bare?: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? rows : rows.slice(0, LIMIT);
  const cardStyle = bare
    ? { }
    : { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 24, height: '100%', boxSizing: 'border-box' as const };
  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ fontSize: bare ? 14 : 16, fontWeight: 600 }}>{title}</h2>
        {rows.length > LIMIT && (
          <button onClick={() => setShowAll(s => !s)} style={{ background: 'transparent', color: 'var(--accent)', fontSize: 12, padding: '2px 0' }}>
            {showAll ? 'Show less' : `Show all ${rows.length} ↓`}
          </button>
        )}
      </div>
      {subtitle && <p style={{ color: 'var(--muted)', fontSize: 12, margin: '4px 0 16px' }}>{subtitle}</p>}
      {!subtitle && <div style={{ height: 16 }} />}
      {shown.map((r, i) => {
        const isOpen = open === r.key;
        const hasAccts = r.accounts && r.accounts.length > 0;
        return (
          <div key={r.key} style={{ marginBottom: 10, position: 'relative' }}
            onMouseEnter={() => setHover(r.key)} onMouseLeave={() => setHover(h => (h === r.key ? null : h))}>
            <div
              onClick={() => setOpen(isOpen ? null : r.key)}
              style={{ cursor: 'pointer' }}
              title={hasAccts ? 'Hover for accounts · click for breakdown' : "Click to see what's counted here"}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
                <span>
                  <span style={{ display: 'inline-block', width: 12, opacity: 0.6 }}>{isOpen ? '▾' : '▸'}</span>
                  {r.label}{r.sublabel && <span style={{ color: 'var(--muted)', marginLeft: 6, fontSize: 12 }}>{r.sublabel}</span>}
                </span>
                <span style={{ color: 'var(--muted)' }}>{money(r.value)} · {(r.pct * 100).toFixed(1)}%</span>
              </div>
              <div style={{ height: 8, background: 'var(--bg)', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{ width: `${Math.min(100, r.pct * 100)}%`, height: '100%', background: PALETTE[i % PALETTE.length] }} />
              </div>
            </div>
            {hover === r.key && hasAccts && (
              <div style={{
                position: 'absolute', left: 18, top: '100%', zIndex: 20,
                background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8,
                padding: '8px 12px', boxShadow: '0 6px 20px rgba(0,0,0,0.45)', minWidth: 240,
              }}>
                <p style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>Held in</p>
                {r.accounts!.map(a => (
                  <div key={a.name} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '2px 0', gap: 16 }}>
                    <span>{a.name}</span>
                    <span style={{ color: 'var(--muted)' }}>{money(a.value)}</span>
                  </div>
                ))}
              </div>
            )}
            {isOpen && (
              <div style={{ margin: '8px 0 4px 18px', paddingLeft: 10, borderLeft: '2px solid var(--border)' }}>
                <p style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>{r.detailHeading}</p>
                {r.detail.map(c => (
                  <div key={c.label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '3px 0', color: 'var(--muted)' }}>
                    <span>{c.label}</span>
                    <span>{money(c.value)} · {r.value ? (c.value / r.value * 100).toFixed(0) : 0}%</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const COLS = '18px 56px 1fr 100px 88px 88px 118px 44px';

function PositionRow({ h, money, editable, onClassify, onEditBasis }: {
  h: HoldingRow; money: Money; editable: boolean; onClassify: Classify; onEditBasis: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const id = idOf(h.symbol, h.name);
  const cb = h.costBasis;
  // Measure gain against only the value that has a known basis, so a PARTIAL
  // basis isn't charged against the whole position (which would overstate gain).
  const gain = cb != null ? h.costBasisCoveredValue - cb : null;
  const gainPct = gain != null && cb ? gain / cb : null;
  const gainColor = gain == null ? 'var(--muted)' : gain >= 0 ? '#4ade80' : '#f87171';
  const partial = cb != null && !h.costBasisComplete;
  const expandable = h.accounts.length > 0;

  const estimated = h.costBasisSource === 'estimated';
  const costTitle = cb == null
    ? (editable ? 'Click to add a cost basis' : 'No cost basis available for this position')
    : partial ? 'Partial basis — known for only some lots; gain is shown on the covered portion. Click to override.'
    : h.costBasisSource === 'manual' ? 'Manually entered — click to edit or clear'
    : h.costBasisSource === 'imported' ? 'Imported from a document (1099-B / statement) — click to override'
    : estimated ? 'Estimated: shares × price on the acquisition date — a rough guess. Click to set the real value.'
    : 'Reported by your institution — click to override';

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: COLS, fontSize: 13, padding: '6px 0', borderBottom: expanded ? 'none' : '1px solid var(--border)', alignItems: 'center' }}>
        <span
          onClick={expandable ? () => setExpanded(e => !e) : undefined}
          title={expandable ? 'Show accounts holding this position' : undefined}
          style={{ cursor: expandable ? 'pointer' : 'default', color: 'var(--muted)', opacity: expandable ? 0.7 : 0, userSelect: 'none' }}
        >{expanded ? '▾' : '▸'}</span>
        <span
          onClick={expandable ? () => setExpanded(e => !e) : undefined}
          style={{ fontWeight: 600, paddingRight: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: expandable ? 'pointer' : 'default' }}
        >{h.symbol || '—'}</span>
        <span title={h.name} style={{ color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingRight: 10 }}>{h.name}</span>
        <span
          onClick={() => onClassify(id)}
          title={h.overridden ? 'Manually set — click to change asset class' : 'Click to change asset class'}
          style={{ fontSize: 11, color: h.overridden ? 'var(--accent)' : 'var(--muted)', cursor: 'pointer', justifySelf: 'start', borderBottom: '1px dashed var(--border)' }}
        >{h.assetClass}{h.overridden ? ' •' : ''} <span style={{ opacity: 0.5 }}>✎</span></span>
        <span
          onClick={editable ? () => onEditBasis(id) : undefined}
          title={costTitle}
          style={{ textAlign: 'right', color: cb == null || estimated ? 'var(--muted)' : 'var(--text)', cursor: editable ? 'pointer' : 'default', whiteSpace: 'nowrap' }}
        >
          {cb != null ? (
            <>
              {estimated ? '≈ ' : ''}{money(cb)}
              {partial ? <span style={{ color: '#fbbf24' }} title="partial"> ~</span>
                : h.costBasisSource === 'manual' ? <span style={{ color: 'var(--accent)' }} title="manual"> •</span>
                : h.costBasisSource === 'imported' ? <span style={{ color: 'var(--muted)', fontSize: 10 }} title="imported"> imp</span>
                : null}
            </>
          ) : editable ? <span style={{ color: 'var(--accent)', fontSize: 12 }}>+ add</span> : '—'}
        </span>
        <span style={{ textAlign: 'right' }}>{money(h.value)}</span>
        <span style={{ textAlign: 'right', color: gainColor, whiteSpace: 'nowrap' }} title={partial ? 'Gain on the portion with a known basis only' : undefined}>
          {gain == null ? '—' : (
            <>
              {gain >= 0 ? '+' : '−'}{money(Math.abs(gain))}
              {gainPct != null && (
                <span style={{ opacity: 0.75, fontSize: 11, marginLeft: 5 }}>
                  {gain >= 0 ? '+' : '−'}{(Math.abs(gainPct) * 100).toFixed(1)}%{partial ? '*' : ''}
                </span>
              )}
            </>
          )}
        </span>
        <span style={{ textAlign: 'right', color: 'var(--muted)' }}>{(h.pct * 100).toFixed(1)}%</span>
      </div>

      {expanded && expandable && (
        <div style={{ padding: '6px 0 10px 74px', borderBottom: '1px solid var(--border)', background: 'var(--bg)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 96px 110px 120px', fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5, padding: '2px 12px 4px 0' }}>
            <span>Account</span><span style={{ textAlign: 'right' }}>Value</span><span style={{ textAlign: 'right' }}>Cost</span><span style={{ textAlign: 'right' }}>Gain/Loss</span>
          </div>
          {h.accounts.map(a => {
            const acb = a.costBasis ?? null;
            const ag = acb != null ? a.value - acb : null;
            const agColor = ag == null ? 'var(--muted)' : ag >= 0 ? '#4ade80' : '#f87171';
            return (
              <div key={a.name} style={{ display: 'grid', gridTemplateColumns: '1fr 96px 110px 120px', fontSize: 12, padding: '3px 12px 3px 0' }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingRight: 8 }}>{a.name}</span>
                <span style={{ textAlign: 'right' }}>{money(a.value)}</span>
                <span style={{ textAlign: 'right', color: 'var(--muted)' }} title={acb == null ? 'No cost basis reported for this account' : undefined}>{acb != null ? money(acb) : '—'}</span>
                <span style={{ textAlign: 'right', color: agColor, whiteSpace: 'nowrap' }}>{ag == null ? '—' : (ag >= 0 ? '+' : '−') + money(Math.abs(ag))}</span>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

interface TileDatum { key: string; label: string; value: number; pct: number; detail?: Contributor[] }

// Colors for buckets outside the model palette (real estate, alternatives, etc.).
const EXTRA_CLASS_COLORS: Record<string, string> = {
  'Real Estate': '#fb923c',
  'Private Equity': '#c084fc',
  'Alternatives': '#2dd4bf',
  'Options': '#f87171',
  'Uncategorized': '#7b7f95',
};

// Display label + color for a broad asset-class bucket. Falls back to the raw
// class name for buckets not in the model palette.
function classMeta(key: string): { label: string; color: string } {
  const m = ASSET_CLASS_META.find(x => x.key === key);
  return m ? { label: m.label, color: m.color } : { label: key, color: EXTRA_CLASS_COLORS[key] ?? '#7b7f95' };
}

// Asset allocation as paired horizontal bars: a solid bar for the current
// weight and a dashed "ghost" bar for the model target from the chosen risk
// profile. Clicking a class lists its holdings in the adjacent Positions card.
function AssetAllocationChart({ data, model, selectedKey, onSelectClass }: {
  data: TileDatum[];
  model: Record<AssetClassKey, number> | null;
  selectedKey: string | null;
  onSelectClass: (key: string | null) => void;
}) {
  const currentByKey = new Map(data.map(d => [d.key, d]));
  const metaKeys = ASSET_CLASS_META.map(m => m.key as string);
  // Model classes first (in canonical order), then any extra current-only
  // buckets (e.g. "Uncategorized") appended in their existing order.
  const extras = data.map(d => d.key).filter(k => !metaKeys.includes(k));
  const keys = [...metaKeys, ...extras];

  const rows = keys
    .map(key => {
      const cur = currentByKey.get(key);
      const curPct = cur ? cur.pct * 100 : 0;
      const modPct = model ? (model[key as AssetClassKey] ?? 0) : 0;
      return { key, cur, curPct, modPct, ...classMeta(key) };
    })
    .filter(r => r.curPct > 0.01 || r.modPct > 0);

  // Scale bars against the largest weight on screen, but cap fill at ~62% of the
  // row so the trailing "Current (x%)" label always has room (matches the
  // inspiration layout). Empty bars keep a sliver so the color reads.
  const max = Math.max(1, ...rows.map(r => Math.max(r.curPct, r.modPct)));
  const fill = (pct: number) => (pct <= 0 ? 0 : Math.max(2, (pct / max) * 100));

  if (!rows.length) return <p style={{ color: 'var(--muted)', fontSize: 13 }}>No holdings to classify.</p>;

  return (
    <div>
      {rows.map(r => {
        const isSel = selectedKey === r.key;
        const drift = r.modPct - r.curPct; // + = under target, − = over target
        return (
          <div key={r.key}
            onClick={() => onSelectClass(isSel ? null : r.key)}
            title="Click to list these holdings in Your Positions"
            style={{
              cursor: 'pointer', borderRadius: 8, padding: '6px 8px', margin: '0 -8px 5px',
              background: isSel ? 'var(--accent-dim)' : 'transparent',
              boxShadow: isSel ? 'inset 2px 0 0 var(--accent)' : 'none',
            }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: isSel ? 'var(--accent)' : 'var(--text)' }}>
                {r.label}
                <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 400, color: 'var(--muted)' }}>{isSel ? '▾ shown' : '›'}</span>
              </span>
              {model && Math.abs(drift) >= 1 && (
                <span style={{ fontSize: 11, color: drift > 0 ? 'var(--amber)' : 'var(--muted)' }}>
                  {drift > 0 ? `${drift.toFixed(0)}% below model` : `${(-drift).toFixed(0)}% above model`}
                </span>
              )}
            </div>

            {/* Current — solid bar */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ flex: '0 0 62%', height: 6 }}>
                <div style={{ width: `${fill(r.curPct)}%`, height: '100%', background: r.color, borderRadius: 3 }} />
              </div>
              <span style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                Current <span style={{ color: 'var(--muted)' }}>({r.curPct.toFixed(2)}%)</span>
              </span>
            </div>

            {/* Model — dashed ghost bar (only when a risk profile is set) */}
            {model && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3 }}>
                <div style={{ flex: '0 0 62%', height: 6 }}>
                  <div style={{ width: `${fill(r.modPct)}%`, height: '100%', borderRadius: 3, border: `1.5px dashed ${r.color}`, opacity: 0.85, boxSizing: 'border-box' }} />
                </div>
                <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                  Model ({r.modPct}%)
                </span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Pop-out for manually setting a holding's asset class. Used everywhere a single
// asset is listed (positions table, treemap breakdown) so the behavior is the
// same across the page; on save it refetches so every panel reflects the change.
function ClassifyModal({ target, classes, onClose, onSaved }: {
  target: { id: string; symbol: string; name: string; currentClass: string; overridden: boolean };
  classes: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [choice, setChoice] = useState(target.overridden ? target.currentClass : 'auto');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function save() {
    setSaving(true);
    try {
      await fetch('/api/allocation/classification', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: target.id, assetClass: choice }),
      });
      onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 3500, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 20, width: 'min(420px, 100%)', boxShadow: '0 24px 70px rgba(0,0,0,0.6)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 4 }}>
          <p style={{ fontSize: 16, fontWeight: 700 }}>Classify asset</p>
          <button className="btn-ghost" onClick={onClose} title="Close (Esc)" style={{ fontSize: 16, lineHeight: 1, padding: '4px 10px' }}>×</button>
        </div>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16 }}>
          <strong style={{ color: 'var(--text)' }}>{target.symbol || target.name}</strong>
          {target.symbol && target.name && target.symbol !== target.name ? ` · ${target.name}` : ''}
        </p>
        <label style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Asset class</label>
        <select value={choice} onChange={e => setChoice(e.target.value)}
          style={{ width: '100%', marginTop: 6, marginBottom: 6, padding: '8px 10px', fontSize: 14, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text)' }}>
          <option value="auto">Auto (detect from security data)</option>
          {classes.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <p style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 18 }}>
          {choice === 'auto'
            ? 'Reverts to automatic classification.'
            : 'Forces this holding into the chosen bucket across every allocation panel.'}
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn-ghost" onClick={onClose} disabled={saving} style={{ fontSize: 13 }}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={saving} style={{ fontSize: 13 }}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}

// Pop-out for entering/overriding a position's total cost basis. Used when the
// institution reports no basis (or a wrong one); on save it refetches so the
// gain/loss and portfolio total update everywhere.
function CostBasisModal({ target, money, onClose, onSaved }: {
  target: { id: string; symbol: string; name: string; value: number; costBasis: number | null; edited: boolean };
  money: Money;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [val, setVal] = useState(target.costBasis != null ? String(Math.round(target.costBasis)) : '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const parsed = val.trim() === '' ? null : Number(val.replace(/[,$\s]/g, ''));
  const valid = parsed == null || (Number.isFinite(parsed) && parsed >= 0);
  const previewGain = parsed != null && parsed > 0 ? target.value - parsed : null;

  async function save(clear = false) {
    setSaving(true);
    try {
      await fetch('/api/allocation/cost-basis', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: target.id, costBasis: clear ? null : parsed }),
      });
      onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 3500, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 20, width: 'min(420px, 100%)', boxShadow: '0 24px 70px rgba(0,0,0,0.6)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 4 }}>
          <p style={{ fontSize: 16, fontWeight: 700 }}>Edit cost basis</p>
          <button className="btn-ghost" onClick={onClose} title="Close (Esc)" style={{ fontSize: 16, lineHeight: 1, padding: '4px 10px' }}>×</button>
        </div>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16 }}>
          <strong style={{ color: 'var(--text)' }}>{target.symbol || target.name}</strong>
          {target.symbol && target.name && target.symbol !== target.name ? ` · ${target.name}` : ''}
          {' · '}current value {money(target.value)}
        </p>
        <label style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Total cost basis ($)</label>
        <input
          value={val} onChange={e => setVal(e.target.value)} autoFocus inputMode="decimal"
          onKeyDown={e => { if (e.key === 'Enter' && valid && parsed != null) save(); }}
          placeholder="e.g. 12500"
          style={{ width: '100%', marginTop: 6, marginBottom: 6, padding: '8px 10px', fontSize: 14, background: 'var(--bg)', border: `1px solid ${valid ? 'var(--border)' : '#f87171'}`, borderRadius: 8, color: 'var(--text)', boxSizing: 'border-box' }}
        />
        <p style={{ fontSize: 11, color: previewGain == null ? 'var(--muted)' : previewGain >= 0 ? '#4ade80' : '#f87171', marginBottom: 18 }}>
          {!valid ? 'Enter a non-negative number.'
            : previewGain != null
              ? `Unrealized ${previewGain >= 0 ? 'gain' : 'loss'}: ${previewGain >= 0 ? '+' : '−'}${money(Math.abs(previewGain))}`
              : 'Total amount paid for this position (across all lots). Overrides any reported/derived basis.'}
        </p>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
          <button className="btn-ghost" onClick={() => save(true)} disabled={saving || !target.edited}
            title={target.edited ? 'Remove the manual value and revert to the reported/derived basis' : 'No manual value to clear'}
            style={{ fontSize: 13, opacity: target.edited ? 1 : 0.4 }}>Clear override</button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn-ghost" onClick={onClose} disabled={saving} style={{ fontSize: 13 }}>Cancel</button>
            <button className="btn-primary" onClick={() => save()} disabled={saving || !valid || parsed == null} style={{ fontSize: 13 }}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Allocation({ onNavigate, privacy, onTogglePrivacy }: {
  onNavigate: (v: View) => void;
  privacy: boolean;
  onTogglePrivacy: () => void;
}) {
  // Opt-in: estimate a basis (shares × historical price) for positions that have
  // none. Off by default; appends ?estimate=1 so the server only does the work
  // (and historical-price fetches) when asked.
  const [estimateBasis, setEstimateBasis] = usePersistentState('mon.estimateBasis', false);
  const { data, loading, error, refetch } = useApi<AllocationData>('/api/allocation' + (estimateBasis ? '?estimate=1' : ''));
  const money: Money = n => (privacy ? '••••••' : '$' + Math.round(n).toLocaleString());

  // Include/exclude a home (e.g. primary residence) from the allocation. The
  // flag is stored per-property server-side, so it persists across browsers.
  async function toggleHome(id: number, excluded: boolean) {
    await fetch('/api/allocation/property-exclusion', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, excluded }),
    });
    refetch();
  }
  const [classifyId, setClassifyId] = useState<string | null>(null);
  const [editBasisId, setEditBasisId] = useState<string | null>(null);
  // Asset class selected in the allocation chart → filters the Positions card.
  const [selectedClass, setSelectedClass] = useState<string | null>(null);
  const [riskProfileId, setRiskProfileId] = usePersistentState<ProfileId | null>('mon.riskProfile', null);
  const [showRisk, setShowRisk] = useState(false);
  const riskProfile = riskProfileId ? RISK_PROFILES[riskProfileId] : null;
  const [showAllPos, setShowAllPos] = useState(false);
  const [posSearch, setPosSearch] = useState('');
  const [order, setOrder] = usePersistentState<string[]>('mon.allocOrder', ['assets', 'country', 'sector', 'stock', 'positions']);
  const [widths, setWidths] = usePersistentState<Record<string, 'half' | 'full'>>('mon.allocWidths', { positions: 'full' });
  const [posCollapsed, setPosCollapsed] = usePersistentState('mon.posCollapsed', true);
  const [dragOver, setDragOver] = useState<string | null>(null);

  // Each widget can be a half-column or span the full width. Positions defaults full.
  const isFull = (key: string) => (widths[key] ?? (key === 'positions' ? 'full' : 'half')) === 'full';
  function toggleWidth(key: string) {
    setWidths(prev => {
      const cur = prev[key] ?? (key === 'positions' ? 'full' : 'half');
      return { ...prev, [key]: cur === 'full' ? 'half' : 'full' };
    });
  }

  function reorder(from: string, to: string) {
    setOrder(prev => {
      const a = prev.includes(from) ? [...prev] : [...prev, from];
      const fi = a.indexOf(from), ti = a.indexOf(to);
      if (fi < 0 || ti < 0 || fi === ti) return prev;
      a.splice(fi, 1); a.splice(ti, 0, from);
      return a;
    });
  }

  const sectorRows: Row[] = (data?.bySector ?? []).map(s => ({
    key: s.name, label: s.name, value: s.value, pct: s.pct, detail: s.contributors, detailHeading: 'Counted from',
  }));
  const stockRows: Row[] = (data?.byStock ?? []).map(s => ({
    key: s.symbol, label: s.symbol, sublabel: s.name, value: s.value, pct: s.pct, detail: s.sources, detailHeading: 'Exposure via', accounts: s.accounts,
  }));
  const countryRows: Row[] = (data?.byCountry ?? []).map(s => ({
    key: s.name, label: s.name, value: s.value, pct: s.pct, detail: s.contributors, detailHeading: 'Counted from',
  }));

  // Broad Schwab-style asset classes (computed server-side via look-through).
  const assetTiles: TileDatum[] = (data?.byAssetClass ?? []).map(s => ({ key: s.name, label: s.name, value: s.value, pct: s.pct, detail: s.contributors }));

  // Look up a holding by its override id, for the classify / cost-basis pop-outs.
  const holdingsById = new Map((data?.holdings ?? []).map(h => [idOf(h.symbol, h.name), h]));
  const classifyHolding = classifyId ? holdingsById.get(classifyId) : undefined;
  const editBasisHolding = editBasisId ? holdingsById.get(editBasisId) : undefined;
  // Real-estate rows are non-editable for cost basis (their value is equity).
  const realEstateNames = new Set((data?.realEstate ?? []).map(r => r.address));

  // Position filters: by selected asset class (from the allocation chart) and
  // by the search box.
  const posQuery = posSearch.trim().toLowerCase();
  const filteredHoldings = (data?.holdings ?? []).filter(
    h => (!selectedClass || h.assetClass === selectedClass)
      && (!posQuery || h.symbol.toLowerCase().includes(posQuery) || h.name.toLowerCase().includes(posQuery)),
  );

  return (
    <div className="page" style={{ maxWidth: 1280, margin: '0 auto', padding: '32px 24px' }}>
      <TopNav view="allocation" onNavigate={onNavigate} privacy={privacy} onTogglePrivacy={onTogglePrivacy} />
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.5px' }}>Investment Allocation</h1>
        <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 4 }}>
          {data ? `${money(data.total)} across investments, real estate & other assets · click any bar to see what it's made of` : 'Analyzing holdings…'}
        </p>
      </div>

      <div style={{ marginBottom: 20 }}>
        <PerformanceChart privacy={privacy} />
      </div>

      {loading && <p style={{ color: 'var(--muted)' }}>Loading allocation (fetching security data)…</p>}
      {error && <p style={{ color: 'var(--red)' }}>Failed to load allocation: {error}</p>}

      {data && (() => {
        const sectionNodes: Record<string, React.ReactNode> = {
          country: (
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 24, height: '100%', boxSizing: 'border-box' }}>
              <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>Country / Region Exposure</h2>
              <p style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 16 }}>
                Estimated from each fund's holdings by ISIN country. Hover the map; click a row for contributing funds.
              </p>
              <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                <div style={{ flex: '1 1 460px', minWidth: 300 }}><WorldMap data={data.byCountry} money={money} /></div>
                <div style={{ flex: '1 1 280px' }}><ExpandableBars bare title="Breakdown" rows={countryRows} money={money} /></div>
              </div>
            </div>
          ),
          assets: (
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 24, height: '100%', boxSizing: 'border-box' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 4 }}>
                <h2 style={{ fontSize: 16, fontWeight: 600 }}>Asset Allocation</h2>
                <button onClick={() => setShowRisk(true)} className="btn-ghost"
                  title="Answer a few questions to get a recommended target allocation"
                  style={{ fontSize: 12, padding: '5px 11px', whiteSpace: 'nowrap', borderRadius: 8 }}>
                  ✦ {riskProfile ? `Risk: ${riskProfile.name}` : 'Set risk profile'}
                </button>
              </div>
              <p style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 12, lineHeight: 1.45 }}>
                {riskProfile
                  ? <>Solid bar = your current mix · dashed bar = <strong style={{ color: 'var(--text)' }}>{riskProfile.name}</strong> model target. Investments, real estate &amp; other assets. Click a class to see its holdings.</>
                  : 'Investments, real estate & other assets · % of total. Take the risk questionnaire to compare against a recommended model portfolio.'}
              </p>
              {data.realEstate.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14, alignItems: 'center' }}>
                  <span style={{ fontSize: 11, color: 'var(--muted)' }}>Real estate:</span>
                  {data.realEstate.map(h => {
                    const on = !h.excluded;
                    return (
                      <button key={h.id}
                        onClick={() => toggleHome(h.id, on)}
                        title={on ? 'Click to exclude this home from the allocation' : 'Click to include this home'}
                        style={{
                          fontSize: 11, padding: '3px 9px', borderRadius: 12, cursor: 'pointer',
                          border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
                          background: on ? 'var(--accent-dim)' : 'transparent',
                          color: on ? 'var(--text)' : 'var(--muted)', opacity: on ? 1 : 0.6,
                        }}>
                        {on ? '✓ ' : '+ '}{h.address.split(',')[0]} · {money(h.equity)}
                      </button>
                    );
                  })}
                </div>
              )}
              {assetTiles.length > 0
                ? <AssetAllocationChart data={assetTiles} model={riskProfile?.model ?? null} selectedKey={selectedClass}
                    onSelectClass={key => { setSelectedClass(key); if (key) setPosCollapsed(false); }} />
                : <p style={{ color: 'var(--muted)', fontSize: 13 }}>No holdings to classify.</p>}
            </div>
          ),
          sector: <ExpandableBars title="Sector Exposure" subtitle="Look-through across all funds. Click a sector for contributors." rows={sectorRows} money={money} />,
          stock: <ExpandableBars title="Stock Exposure" subtitle="Into each fund's holdings, aggregated. Hover a stock for accounts." rows={stockRows} money={money} />,
          positions: (() => {
            const shown = showAllPos || posQuery || selectedClass ? filteredHoldings : filteredHoldings.slice(0, POS_LIMIT);
            // Portfolio unrealized gain, over the positions where a cost basis was
            // reported. Excluded positions are flagged so the headline isn't read
            // as covering the whole book.
            const basisRows = data.holdings.filter(h => h.costBasis != null);
            const totalCost = basisRows.reduce((s, h) => s + (h.costBasis ?? 0), 0);
            const totalGain = basisRows.length ? basisRows.reduce((s, h) => s + h.value, 0) - totalCost : null;
            const totalGainPct = totalGain != null && totalCost ? totalGain / totalCost : null;
            const noBasisCount = data.holdings.length - basisRows.length;
            return (
              <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 24, height: '100%', boxSizing: 'border-box' }}>
                <div
                  onClick={() => setPosCollapsed(c => !c)}
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', gap: 12 }}
                >
                  <h2 style={{ fontSize: 16, fontWeight: 600 }}>
                    <span style={{ display: 'inline-block', width: 14, opacity: 0.7 }}>{posCollapsed ? '▸' : '▾'}</span>
                    Your Positions
                    <span style={{ color: 'var(--muted)', fontWeight: 400, marginLeft: 6 }}>({data.holdings.length})</span>
                  </h2>
                  {totalGain != null && (
                    <span
                      title={noBasisCount > 0 ? `${noBasisCount} position(s) excluded — no cost basis reported by your institution` : 'Across all positions with a reported cost basis'}
                      style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', color: totalGain >= 0 ? '#4ade80' : '#f87171' }}
                    >
                      {totalGain >= 0 ? '+' : '−'}{money(Math.abs(totalGain))}
                      {totalGainPct != null && (
                        <span style={{ opacity: 0.75, fontWeight: 400, marginLeft: 5 }}>
                          {totalGain >= 0 ? '+' : '−'}{(Math.abs(totalGainPct) * 100).toFixed(1)}%
                        </span>
                      )}
                      <span style={{ color: 'var(--muted)', fontWeight: 400, marginLeft: 6 }}>unrealized{noBasisCount > 0 ? ' *' : ''}</span>
                    </span>
                  )}
                </div>

                {!posCollapsed && (
                  <>
                    {/* Active asset-class filter (driven by the allocation chart). */}
                    {selectedClass && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '14px 0 0' }}>
                        <span style={{
                          display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12, padding: '4px 6px 4px 11px',
                          borderRadius: 14, background: 'var(--accent-dim)', border: '1px solid var(--accent)', color: 'var(--text)',
                        }}>
                          {selectedClass} <span style={{ color: 'var(--muted)' }}>({filteredHoldings.length})</span>
                          <button onClick={() => setSelectedClass(null)} title="Clear filter"
                            style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 2px' }}>×</button>
                        </span>
                      </div>
                    )}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, margin: '14px 0 12px' }}>
                      <input
                        value={posSearch}
                        onChange={e => setPosSearch(e.target.value)}
                        placeholder="Search symbol or name…"
                        style={{ flex: '1 1 auto', maxWidth: 280, padding: '6px 10px', fontSize: 13 }}
                      />
                      <label
                        title="For positions with no basis, estimate one from shares × the price on the acquisition date. Rough — shown as ≈ and clearly flagged."
                        style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)', cursor: 'pointer', whiteSpace: 'nowrap' }}
                      >
                        <input type="checkbox" checked={estimateBasis} onChange={e => setEstimateBasis(e.target.checked)} />
                        Estimate missing (≈)
                      </label>
                      {!posQuery && !selectedClass && data.holdings.length > POS_LIMIT && (
                        <button onClick={() => setShowAllPos(s => !s)} style={{ background: 'transparent', color: 'var(--accent)', fontSize: 12, padding: '2px 0', whiteSpace: 'nowrap' }}>
                          {showAllPos ? 'Show less' : `Show all ${data.holdings.length} ↓`}
                        </button>
                      )}
                    </div>
                    {/* Holdings table is wider than a phone; scroll it sideways
                        within the box rather than squashing the columns. */}
                    <div className="scroll-x"><div className="tbl-scroll" style={{ ['--tbl-min']: '680px' } as React.CSSProperties}>
                    <div style={{ display: 'grid', gridTemplateColumns: COLS, fontSize: 12, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, paddingBottom: 8, borderBottom: '1px solid var(--border)' }}>
                      <span /><span>Symbol</span><span>Name</span><span>Class</span><span style={{ textAlign: 'right' }}>Cost</span><span style={{ textAlign: 'right' }}>Value</span><span style={{ textAlign: 'right' }}>Gain/Loss</span><span style={{ textAlign: 'right' }}>%</span>
                    </div>
                    {shown.map((h, i) => (
                      <PositionRow key={h.symbol + i} h={h} money={money} editable={!!h.symbol || !realEstateNames.has(h.name)} onClassify={setClassifyId} onEditBasis={setEditBasisId} />
                    ))}
                    {shown.length === 0 && (
                      <p style={{ color: 'var(--muted)', fontSize: 13, padding: '12px 0' }}>
                        {selectedClass ? `No positions classified as ${selectedClass}.` : `No positions match “${posSearch}”.`}
                      </p>
                    )}
                    </div></div>
                  </>
                )}
              </div>
            );
          })(),
        };
        const keys = order.filter(k => sectionNodes[k]);
        // Surface any section not yet in the saved order (e.g. newly added) at the
        // front rather than the end, so it's visible; dragging then persists it.
        for (const k of Object.keys(sectionNodes)) if (!keys.includes(k)) keys.unshift(k);
        return (
          <div className="stack-mobile" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, alignItems: 'stretch' }}>
            <p style={{ gridColumn: '1 / -1', color: 'var(--muted)', fontSize: 12, marginTop: -8 }}>Tip: drag ⠿ to rearrange · click ⤢ / ⤡ to resize a box.</p>
            {keys.map(key => (
              <div key={key}
                onDragOver={e => { e.preventDefault(); if (dragOver !== key) setDragOver(key); }}
                onDragLeave={() => setDragOver(d => (d === key ? null : d))}
                onDrop={e => { e.preventDefault(); const from = e.dataTransfer.getData('text/plain'); setDragOver(null); if (from) reorder(from, key); }}
                style={{
                  position: 'relative', borderRadius: 12,
                  outline: dragOver === key ? '2px dashed var(--accent)' : 'none', outlineOffset: 4,
                  ...(isFull(key) ? { gridColumn: '1 / -1' } : {}),
                }}
              >
                {/* Reorder/resize controls live inside the card's right padding
                    strip so they're never clipped off-screen on narrow layouts. */}
                <div style={{ position: 'absolute', top: 14, right: 5, display: 'flex', flexDirection: 'column', gap: 7, zIndex: 5 }}>
                  <span draggable onDragStart={e => e.dataTransfer.setData('text/plain', key)} title="Drag to reorder"
                    style={{ cursor: 'grab', color: 'var(--muted)', fontSize: 16, lineHeight: 1, userSelect: 'none' }}>⠿</span>
                  <span onClick={() => toggleWidth(key)} title={isFull(key) ? 'Shrink to half width' : 'Expand to full width'}
                    style={{ cursor: 'pointer', color: 'var(--muted)', fontSize: 15, lineHeight: 1, userSelect: 'none' }}>
                    {isFull(key) ? '⤡' : '⤢'}
                  </span>
                </div>
                {sectionNodes[key]}
              </div>
            ))}
          </div>
        );
      })()}

      {showRisk && (
        <RiskQuestionnaire
          initialProfile={riskProfileId}
          onClose={() => setShowRisk(false)}
          onApply={setRiskProfileId}
        />
      )}

      {classifyHolding && data && (
        <ClassifyModal
          target={{ id: classifyId!, symbol: classifyHolding.symbol, name: classifyHolding.name, currentClass: classifyHolding.assetClass, overridden: classifyHolding.overridden }}
          classes={data.assetClasses}
          onClose={() => setClassifyId(null)}
          onSaved={refetch}
        />
      )}

      {editBasisHolding && (
        <CostBasisModal
          target={{
            id: editBasisId!, symbol: editBasisHolding.symbol, name: editBasisHolding.name,
            value: editBasisHolding.value, costBasis: editBasisHolding.costBasis, edited: editBasisHolding.costBasisSource === 'manual',
          }}
          money={money}
          onClose={() => setEditBasisId(null)}
          onSaved={refetch}
        />
      )}
    </div>
  );
}
