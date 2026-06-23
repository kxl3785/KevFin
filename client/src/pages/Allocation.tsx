import { useState } from 'react';
import { useApi } from '../hooks/useApi.ts';
import { usePersistentState } from '../hooks/usePersistentState.ts';
import WorldMap from '../components/WorldMap.tsx';
import TopNav, { type View } from '../components/TopNav.tsx';

interface Contributor { label: string; value: number }
interface Slice { name: string; value: number; pct: number; contributors: Contributor[] }
interface StockExposure { symbol: string; name: string; value: number; pct: number; sources: Contributor[]; accounts: AccountHolding[] }
interface AccountHolding { name: string; value: number }
interface HoldingRow { symbol: string; name: string; value: number; pct: number; assetClass: string; accounts: AccountHolding[] }
interface AllocationData { total: number; holdings: HoldingRow[]; bySector: Slice[]; byStock: StockExposure[]; byCountry: Slice[] }

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

export default function Allocation({ onNavigate, privacy, onTogglePrivacy }: {
  onNavigate: (v: View) => void;
  privacy: boolean;
  onTogglePrivacy: () => void;
}) {
  const { data, loading, error } = useApi<AllocationData>('/api/allocation');
  const money: Money = n => (privacy ? '••••••' : '$' + Math.round(n).toLocaleString());
  const [showAllPos, setShowAllPos] = useState(false);
  const [order, setOrder] = usePersistentState<string[]>('mon.allocOrder', ['country', 'sector', 'stock', 'positions']);
  const [dragOver, setDragOver] = useState<string | null>(null);

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

  return (
    <div style={{ maxWidth: 960, margin: '0 auto', padding: '32px 24px' }}>
      <TopNav view="allocation" onNavigate={onNavigate} privacy={privacy} onTogglePrivacy={onTogglePrivacy} />
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.5px' }}>Investment Allocation</h1>
        <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 4 }}>
          {data ? `${money(data.total)} invested · click any bar to see what it's made of` : 'Analyzing holdings…'}
        </p>
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
          sector: <ExpandableBars title="Sector Exposure" subtitle="Look-through across all funds. Click a sector for contributors." rows={sectorRows} money={money} />,
          stock: <ExpandableBars title="Stock Exposure" subtitle="Into each fund's holdings, aggregated. Hover a stock for accounts." rows={stockRows} money={money} />,
          positions: (
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 24 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <h2 style={{ fontSize: 16, fontWeight: 600 }}>Your Positions</h2>
                {data.holdings.length > LIMIT && (
                  <button onClick={() => setShowAllPos(s => !s)} style={{ background: 'transparent', color: 'var(--accent)', fontSize: 12, padding: '2px 0' }}>
                    {showAllPos ? 'Show less' : `Show all ${data.holdings.length} ↓`}
                  </button>
                )}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '70px 1fr 110px 130px 70px', fontSize: 12, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, paddingBottom: 8, borderBottom: '1px solid var(--border)' }}>
                <span>Symbol</span><span>Name</span><span>Class</span><span style={{ textAlign: 'right' }}>Value</span><span style={{ textAlign: 'right' }}>%</span>
              </div>
              {(showAllPos ? data.holdings : data.holdings.slice(0, LIMIT)).map((h, i) => (
                <PositionRow key={h.symbol + i} h={h} money={money} />
              ))}
            </div>
          ),
        };
        const keys = order.filter(k => sectionNodes[k]);
        for (const k of Object.keys(sectionNodes)) if (!keys.includes(k)) keys.push(k);
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: -8 }}>Tip: drag the ⠿ handle (left of each box) to rearrange.</p>
            {keys.map(key => (
              <div key={key}
                onDragOver={e => { e.preventDefault(); if (dragOver !== key) setDragOver(key); }}
                onDragLeave={() => setDragOver(d => (d === key ? null : d))}
                onDrop={e => { e.preventDefault(); const from = e.dataTransfer.getData('text/plain'); setDragOver(null); if (from) reorder(from, key); }}
                style={{ position: 'relative', borderRadius: 12, outline: dragOver === key ? '2px dashed var(--accent)' : 'none', outlineOffset: 4 }}
              >
                <span draggable onDragStart={e => e.dataTransfer.setData('text/plain', key)} title="Drag to reorder"
                  style={{ position: 'absolute', left: -22, top: 20, cursor: 'grab', color: 'var(--muted)', fontSize: 16, userSelect: 'none' }}>⠿</span>
                {sectionNodes[key]}
              </div>
            ))}
          </div>
        );
      })()}
    </div>
  );
}
