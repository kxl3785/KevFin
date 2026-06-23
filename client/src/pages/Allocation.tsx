import { useState } from 'react';
import { useApi } from '../hooks/useApi.ts';
import { usePersistentState } from '../hooks/usePersistentState.ts';
import WorldMap from '../components/WorldMap.tsx';
import TopNav, { type View } from '../components/TopNav.tsx';
import PerformanceChart from '../components/PerformanceChart.tsx';

interface Contributor { label: string; value: number }
interface Slice { name: string; value: number; pct: number; contributors: Contributor[] }
interface StockExposure { symbol: string; name: string; value: number; pct: number; sources: Contributor[]; accounts: AccountHolding[] }
interface AccountHolding { name: string; value: number }
interface HoldingRow { symbol: string; name: string; value: number; pct: number; assetClass: string; accounts: AccountHolding[] }
interface AllocationData { total: number; holdings: HoldingRow[]; bySector: Slice[]; byStock: StockExposure[]; byCountry: Slice[]; byAssetClass: Slice[] }

const PALETTE = ['#6c8fff', '#4ade80', '#fbbf24', '#f472b6', '#38bdf8', '#a78bfa', '#fb923c', '#34d399', '#f87171', '#c084fc', '#2dd4bf', '#facc15'];

type Money = (n: number) => string;

interface Row { key: string; label: string; sublabel?: string; value: number; pct: number; detail: Contributor[]; detailHeading: string; accounts?: AccountHolding[] }

const LIMIT = 10;

function ExpandableBars({ title, subtitle, rows, money, bare }: { title: string; subtitle?: string; rows: Row[]; money: Money; bare?: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? rows : rows.slice(0, LIMIT);
  const cardStyle = bare
    ? { }
    : { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 24 };
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

function PositionRow({ h, money }: { h: HoldingRow; money: Money }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ position: 'relative', display: 'grid', gridTemplateColumns: '70px 1fr 110px 130px 70px', fontSize: 13, padding: '7px 0', borderBottom: '1px solid var(--border)', alignItems: 'center' }}
    >
      <span style={{ fontWeight: 600 }}>{h.symbol || '—'}</span>
      <span style={{ color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingRight: 8 }}>{h.name}</span>
      <span style={{ fontSize: 11, color: 'var(--muted)' }}>{h.assetClass}</span>
      <span style={{ textAlign: 'right' }}>{money(h.value)}</span>
      <span style={{ textAlign: 'right', color: 'var(--muted)' }}>{(h.pct * 100).toFixed(1)}%</span>
      {hover && h.accounts.length > 0 && (
        <div style={{
          position: 'absolute', left: 70, top: '100%', zIndex: 20,
          background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8,
          padding: '8px 12px', boxShadow: '0 6px 20px rgba(0,0,0,0.45)', minWidth: 240,
        }}>
          <p style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>
            Held in {h.accounts.length > 1 ? `${h.accounts.length} accounts` : ''}
          </p>
          {h.accounts.map(a => (
            <div key={a.name} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '2px 0', gap: 16 }}>
              <span>{a.name}</span>
              <span style={{ color: 'var(--muted)' }}>{money(a.value)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface TileDatum { key: string; label: string; value: number; pct: number }
interface Tile extends TileDatum { x: number; y: number; w: number; h: number }

// Relative luminance of a #rrggbb color (for picking readable label text).
function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) / 255, g = parseInt(h.slice(2, 4), 16) / 255, b = parseInt(h.slice(4, 6), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Squarified treemap (Bruls et al.): recursively lay leaves (sorted desc, areas
// pre-scaled to fill the box) into rows along the shorter side, minimizing
// worst aspect ratio so tiles stay close to square.
function squarify(leaves: { item: TileDatum; area: number }[], rect: { x: number; y: number; w: number; h: number }, out: Tile[]): void {
  if (!leaves.length) return;
  const { x, y, w, h } = rect;
  const short = Math.min(w, h);
  const worst = (areas: number[]) => {
    const s = areas.reduce((a, b) => a + b, 0);
    return Math.max((short * short * Math.max(...areas)) / (s * s), (s * s) / (short * short * Math.min(...areas)));
  };
  const row: typeof leaves = [];
  let prev = Infinity;
  for (const leaf of leaves) {
    const wr = worst([...row, leaf].map(d => d.area));
    if (row.length && wr > prev) break;
    row.push(leaf); prev = wr;
  }
  const rowArea = row.reduce((s, d) => s + d.area, 0);
  if (w >= h) {
    const colW = rowArea / h;
    let yy = y;
    for (const d of row) { const rh = d.area / colW; out.push({ ...d.item, x, y: yy, w: colW, h: rh }); yy += rh; }
    squarify(leaves.slice(row.length), { x: x + colW, y, w: w - colW, h }, out);
  } else {
    const rowH = rowArea / w;
    let xx = x;
    for (const d of row) { const rw = d.area / rowH; out.push({ ...d.item, x: xx, y, w: rw, h: rowH }); xx += rw; }
    squarify(leaves.slice(row.length), { x, y: y + rowH, w, h: h - rowH }, out);
  }
}

// Square-ish viewBox sized ≈ a half-width card so SVG units ≈ rendered px
// (keeps label fonts readable in the small reorderable card).
const TM_W = 420, TM_H = 380;

function Treemap({ data, money }: { data: TileDatum[]; money: Money }) {
  const leaves = data.filter(d => d.value > 0);
  if (!leaves.length) return null;
  const sum = leaves.reduce((s, d) => s + d.value, 0);
  const scale = (TM_W * TM_H) / sum;
  const tiles: Tile[] = [];
  squarify(leaves.map(d => ({ item: d, area: d.value * scale })), { x: 0, y: 0, w: TM_W, h: TM_H }, tiles);

  return (
    <svg viewBox={`0 0 ${TM_W} ${TM_H}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
      {tiles.map((t, i) => {
        const color = PALETTE[i % PALETTE.length];
        const txt = luminance(color) < 0.6 ? '#fff' : '#11141c';
        const labelFits = t.w > 56 && t.h > 24;
        const pctFits = t.w > 56 && t.h > 42;
        const valFits = t.w > 56 && t.h > 60;
        const pad = 9;
        return (
          <g key={t.key}>
            <title>{`${t.label}: ${money(t.value)} (${(t.pct * 100).toFixed(1)}%)`}</title>
            <rect x={t.x + 1.5} y={t.y + 1.5} width={Math.max(0, t.w - 3)} height={Math.max(0, t.h - 3)} rx={5} fill={color} />
            {labelFits && (
              <text x={t.x + pad} y={t.y + pad} fill={txt}>
                <tspan x={t.x + pad} dy="0.95em" fontSize={13} fontWeight={700}>{t.label}</tspan>
                {pctFits && <tspan x={t.x + pad} dy="1.45em" fontSize={11.5} opacity={0.9}>{(t.pct * 100).toFixed(1)}%</tspan>}
                {valFits && <tspan x={t.x + pad} dy="1.35em" fontSize={11.5} opacity={0.9}>{money(t.value)}</tspan>}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

export default function Allocation({ onNavigate, privacy, onTogglePrivacy }: {
  onNavigate: (v: View) => void;
  privacy: boolean;
  onTogglePrivacy: () => void;
}) {
  const { data, loading, error } = useApi<AllocationData>('/api/allocation');
  const money: Money = n => (privacy ? '••••••' : '$' + Math.round(n).toLocaleString());
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
  const assetTiles: TileDatum[] = (data?.byAssetClass ?? []).map(s => ({ key: s.name, label: s.name, value: s.value, pct: s.pct }));

  // Position search filter (by symbol or name).
  const posQuery = posSearch.trim().toLowerCase();
  const filteredHoldings = (data?.holdings ?? []).filter(
    h => !posQuery || h.symbol.toLowerCase().includes(posQuery) || h.name.toLowerCase().includes(posQuery),
  );

  return (
    <div style={{ maxWidth: 960, margin: '0 auto', padding: '32px 24px' }}>
      <TopNav view="allocation" onNavigate={onNavigate} privacy={privacy} onTogglePrivacy={onTogglePrivacy} />
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.5px' }}>Investment Allocation</h1>
        <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 4 }}>
          {data ? `${money(data.total)} invested · click any bar to see what it's made of` : 'Analyzing holdings…'}
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
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 24 }}>
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
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 24 }}>
              <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>Asset Allocation</h2>
              <p style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 16 }}>Broad asset classes · % of total holdings.</p>
              {assetTiles.length > 0
                ? <Treemap data={assetTiles} money={money} />
                : <p style={{ color: 'var(--muted)', fontSize: 13 }}>No holdings to classify.</p>}
            </div>
          ),
          sector: <ExpandableBars title="Sector Exposure" subtitle="Look-through across all funds. Click a sector for contributors." rows={sectorRows} money={money} />,
          stock: <ExpandableBars title="Stock Exposure" subtitle="Into each fund's holdings, aggregated. Hover a stock for accounts." rows={stockRows} money={money} />,
          positions: (() => {
            const shown = showAllPos || posQuery ? filteredHoldings : filteredHoldings.slice(0, LIMIT);
            return (
              <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 24 }}>
                <div
                  onClick={() => setPosCollapsed(c => !c)}
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}
                >
                  <h2 style={{ fontSize: 16, fontWeight: 600 }}>
                    <span style={{ display: 'inline-block', width: 14, opacity: 0.7 }}>{posCollapsed ? '▸' : '▾'}</span>
                    Your Positions
                    <span style={{ color: 'var(--muted)', fontWeight: 400, marginLeft: 6 }}>({data.holdings.length})</span>
                  </h2>
                </div>

                {!posCollapsed && (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, margin: '14px 0 12px' }}>
                      <input
                        value={posSearch}
                        onChange={e => setPosSearch(e.target.value)}
                        placeholder="Search symbol or name…"
                        style={{ flex: '1 1 auto', maxWidth: 280, padding: '6px 10px', fontSize: 13 }}
                      />
                      {!posQuery && data.holdings.length > LIMIT && (
                        <button onClick={() => setShowAllPos(s => !s)} style={{ background: 'transparent', color: 'var(--accent)', fontSize: 12, padding: '2px 0', whiteSpace: 'nowrap' }}>
                          {showAllPos ? 'Show less' : `Show all ${data.holdings.length} ↓`}
                        </button>
                      )}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '70px 1fr 110px 130px 70px', fontSize: 12, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, paddingBottom: 8, borderBottom: '1px solid var(--border)' }}>
                      <span>Symbol</span><span>Name</span><span>Class</span><span style={{ textAlign: 'right' }}>Value</span><span style={{ textAlign: 'right' }}>%</span>
                    </div>
                    {shown.map((h, i) => (
                      <PositionRow key={h.symbol + i} h={h} money={money} />
                    ))}
                    {shown.length === 0 && (
                      <p style={{ color: 'var(--muted)', fontSize: 13, padding: '12px 0' }}>No positions match “{posSearch}”.</p>
                    )}
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
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, alignItems: 'start' }}>
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
                <span draggable onDragStart={e => e.dataTransfer.setData('text/plain', key)} title="Drag to reorder"
                  style={{ position: 'absolute', left: -22, top: 20, cursor: 'grab', color: 'var(--muted)', fontSize: 16, userSelect: 'none' }}>⠿</span>
                <span onClick={() => toggleWidth(key)} title={isFull(key) ? 'Shrink to half width' : 'Expand to full width'}
                  style={{ position: 'absolute', left: -22, top: 46, cursor: 'pointer', color: 'var(--muted)', fontSize: 15, userSelect: 'none' }}>
                  {isFull(key) ? '⤡' : '⤢'}
                </span>
                {sectionNodes[key]}
              </div>
            ))}
          </div>
        );
      })()}
    </div>
  );
}
