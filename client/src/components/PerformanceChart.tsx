import { useState, useMemo, useEffect } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { useApi } from '../hooks/useApi.ts';
import { usePersistentState } from '../hooks/usePersistentState.ts';

interface PerfPoint { date: string; value: number }
interface PerfSeries {
  id: string;
  label: string;
  type: 'account' | 'benchmark';
  accounts: string[];
  points: PerfPoint[];
  cagr: number;
  totalReturn: number;
}
interface PerformanceData {
  series: PerfSeries[];
  startDate: string;
  endDate: string;
}

const INST_COLORS = ['#6c8fff', '#4ade80', '#fbbf24', '#f472b6', '#38bdf8', '#a78bfa', '#fb923c'];
// The blended "All Accounts" line gets a bright neutral so it reads as the
// headline series above the individual-account hues.
const TOTAL_COLOR = '#e8eaf0';
// Distinct (but muted) hues so the four dashed benchmark lines can be told
// apart; kept off the INST_COLORS palette to avoid clashing with account lines.
const BENCH_COLORS: Record<string, string> = {
  SPY:   '#94a3b8', // slate
  QQQ:   '#22d3ee', // cyan
  VFFVX: '#c084fc', // purple
  BND:   '#fb7185', // rose
};
const BENCH_SHORT: Record<string, string> = {
  SPY:   'S&P 500',
  QQQ:   'Nasdaq 100',
  VFFVX: 'Target Date',
  BND:   'Total Bond',
};
// Colors for user-added custom comparison tickers (kept off the palettes above).
const CUSTOM_COLORS = ['#e879f9', '#5eead4', '#fdba74', '#a3e635', '#67e8f9', '#f9a8d4'];

type RangeKey = 'YTD' | '1Y' | '3Y' | '5Y' | 'ALL' | 'custom';
const PRESETS: { key: RangeKey; label: string }[] = [
  { key: 'YTD', label: 'YTD' },
  { key: '1Y', label: '1Y' },
  { key: '3Y', label: '3Y' },
  { key: '5Y', label: '5Y' },
  { key: 'ALL', label: 'All' },
];

// The whole 5y history is fetched once; ranges are applied client-side so
// switching is instant and a true custom from–to window is possible.
const FETCH_DAYS = 1825;

function fmtAxisDate(d: string): string {
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}

function fmtPct(n: number): string {
  return (n >= 0 ? '+' : '') + (n * 100).toFixed(1) + '%';
}

function computeCagr(startVal: number, endVal: number, days: number): number {
  if (startVal <= 0 || endVal <= 0 || days <= 0) return 0;
  return Math.pow(endVal / startVal, 365 / days) - 1;
}

// Re-base one series to 100 at the first point inside [from, to] and recompute
// its return stats for that window, so every range/custom selection is honest.
function windowSeries(s: PerfSeries, from: string, to: string):
  { rebased: PerfPoint[]; cagr: number; totalReturn: number } | null {
  const pts = s.points.filter(p => p.date >= from && p.date <= to);
  if (pts.length === 0) return null;
  const base = pts[0].value || 1;
  const rebased = pts.map(p => ({ date: p.date, value: Math.round((p.value / base) * 10000) / 100 }));
  const last = rebased[rebased.length - 1].value;
  const spanDays = (Date.parse(pts[pts.length - 1].date) - Date.parse(pts[0].date)) / 86_400_000;
  return { rebased, cagr: computeCagr(100, last, spanDays), totalReturn: last / 100 - 1 };
}

// Small legend dot / dash indicator for a series box header.
function SeriesIcon({ color, dashed }: { color: string; dashed: boolean }) {
  return dashed
    ? <span style={{ display: 'inline-block', width: 16, height: 2, background: color, borderRadius: 1, verticalAlign: 'middle', marginRight: 6 }} />
    : <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: color, verticalAlign: 'middle', marginRight: 6 }} />;
}

export default function PerformanceChart({ privacy }: { privacy: boolean }) {
  const [range, setRange] = useState<RangeKey>('YTD');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  // Index comparisons (benchmarks + custom tickers) the user has chosen to show
  // by default — persisted, so a selection sticks across visits. Accounts always
  // default to total-only, so only non-account ids live here.
  const [defaultIndexes, setDefaultIndexes] = usePersistentState<string[]>('mon.perfDefaultIndexes', []);
  // Which series are drawn. Default: the blended account total + saved indexes.
  const [active, setActive] = useState<Set<string>>(() => new Set(['total', ...defaultIndexes]));
  // User-added comparison tickers (validated before they're saved here).
  const [customSymbols, setCustomSymbols] = usePersistentState<string[]>('mon.perfCustom', []);
  const [customSeries, setCustomSeries] = useState<Record<string, PerfSeries>>({});
  const [addInput, setAddInput] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const { data, loading, error } = useApi<PerformanceData>(`/api/performance?days=${FETCH_DAYS}`);

  // Accounts are 'total' / 'org:*'; everything else is an index comparison.
  const isIndexId = (id: string) => id !== 'total' && !id.startsWith('org:');

  const toggle = (id: string) => {
    setActive(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
    // Persist index-comparison picks so they're the default next visit.
    if (isIndexId(id)) {
      setDefaultIndexes(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
    }
  };

  // Hydrate persisted custom tickers on load; drop any that no longer resolve.
  useEffect(() => {
    let alive = true;
    for (const sym of customSymbols) {
      if (customSeries[sym]) continue;
      fetch(`/api/performance/symbol?symbol=${encodeURIComponent(sym)}`)
        .then(r => (r.ok ? r.json() : Promise.reject()))
        .then(({ series }: { series: PerfSeries }) => { if (alive) setCustomSeries(prev => ({ ...prev, [sym]: series })); })
        .catch(() => { if (alive) setCustomSymbols(prev => prev.filter(s => s !== sym)); });
    }
    return () => { alive = false; };
  }, [customSymbols]); // eslint-disable-line react-hooks/exhaustive-deps

  async function addSymbol() {
    const sym = addInput.trim().toUpperCase();
    if (!sym) return;
    if (!/^[A-Z0-9.\-]{1,12}$/.test(sym)) { setAddError('Enter a valid ticker symbol.'); return; }
    const existing = new Set([...customSymbols, ...(data?.series.map(s => s.id.replace(/^sym:/, '')) ?? [])]);
    if (existing.has(sym)) { setAddError(`${sym} is already shown.`); return; }
    setAdding(true); setAddError(null);
    try {
      const r = await fetch(`/api/performance/symbol?symbol=${encodeURIComponent(sym)}`);
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        setAddError(e.error || `No data found for ${sym}.`);
        return;
      }
      const { series } = (await r.json()) as { series: PerfSeries };
      setCustomSeries(prev => ({ ...prev, [sym]: series }));
      setCustomSymbols(prev => [...prev, sym]);
      setActive(prev => new Set(prev).add(series.id)); // show it immediately
      setDefaultIndexes(prev => prev.includes(series.id) ? prev : [...prev, series.id]); // default on next visit
      setAddInput('');
    } catch {
      setAddError('Lookup failed — try again.');
    } finally {
      setAdding(false);
    }
  }

  function removeSymbol(sym: string) {
    const id = `sym:${sym}`;
    setCustomSymbols(prev => prev.filter(s => s !== sym));
    setCustomSeries(prev => { const n = { ...prev }; delete n[sym]; return n; });
    setActive(prev => { const n = new Set(prev); n.delete(id); return n; });
    setDefaultIndexes(prev => prev.filter(x => x !== id));
  }

  const accountsAll = useMemo(() => data?.series.filter(s => s.type === 'account') ?? [], [data]);
  const customList = useMemo(
    () => customSymbols.map(s => customSeries[s]).filter((s): s is PerfSeries => !!s),
    [customSymbols, customSeries],
  );
  const benchmarksAll = useMemo(
    () => [...(data?.series.filter(s => s.type === 'benchmark') ?? []), ...customList],
    [data, customList],
  );
  // All series (built-in + custom) for windowing and tooltip lookups.
  const allSeries = useMemo(() => [...(data?.series ?? []), ...customList], [data, customList]);

  // Stable color per series (total = neutral, other accounts cycle the palette,
  // custom tickers get their own palette).
  const colorOf = useMemo(() => {
    const m = new Map<string, string>();
    let i = 0;
    for (const s of accountsAll) m.set(s.id, s.id === 'total' ? TOTAL_COLOR : INST_COLORS[i++ % INST_COLORS.length]);
    customSymbols.forEach((sym, ci) => m.set(`sym:${sym}`, CUSTOM_COLORS[ci % CUSTOM_COLORS.length]));
    for (const s of benchmarksAll) if (!m.has(s.id)) m.set(s.id, BENCH_COLORS[s.id] ?? '#94a3b8');
    return m;
  }, [accountsAll, benchmarksAll, customSymbols]);

  // Resolve the active [from, to] window for the current range selection.
  const [from, to] = useMemo<[string, string]>(() => {
    const end = data?.endDate ?? new Date().toISOString().slice(0, 10);
    if (range === 'custom') return [customFrom || data?.startDate || end, customTo || end];
    if (range === 'ALL') return [data?.startDate ?? '0000-01-01', end];
    if (range === 'YTD') return [`${end.slice(0, 4)}-01-01`, end];
    const back = range === '1Y' ? 365 : range === '3Y' ? 1095 : 1825;
    const d = new Date(end + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - back);
    return [d.toISOString().slice(0, 10), end];
  }, [range, customFrom, customTo, data]);

  // Window every series and merge into chart rows (keyed by date).
  const view = useMemo(() => {
    if (!data) return null;
    const map = new Map<string, { rebased: PerfPoint[]; cagr: number; totalReturn: number }>();
    for (const s of allSeries) { const w = windowSeries(s, from, to); if (w) map.set(s.id, w); }
    const dateSet = new Set<string>();
    for (const w of map.values()) w.rebased.forEach(p => dateSet.add(p.date));
    const rows = [...dateSet].sort().map(date => {
      const row: Record<string, unknown> = { date };
      for (const [id, w] of map) { const pt = w.rebased.find(p => p.date === date); if (pt) row[id] = pt.value; }
      return row;
    });
    return { map, rows };
  }, [data, allSeries, from, to]);

  function openCustom() {
    setRange('custom');
    if (data) {
      if (!customFrom) setCustomFrom(data.startDate);
      if (!customTo) setCustomTo(data.endDate);
    }
  }

  const inputStyle: React.CSSProperties = {
    background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)',
    borderRadius: 6, padding: '3px 8px', fontSize: 12, colorScheme: 'dark',
  };

  // A clickable series box (legend + toggle + windowed stats).
  function SeriesBox({ s }: { s: PerfSeries }) {
    const isInst = s.type === 'account';
    const color = colorOf.get(s.id) ?? '#94a3b8';
    const name = isInst ? s.label : (BENCH_SHORT[s.id] ?? s.label);
    const on = active.has(s.id);
    const w = view?.map.get(s.id);
    const isCustom = s.id.startsWith('sym:');
    return (
      <button
        onClick={() => toggle(s.id)}
        title={`${name} — ${on ? 'click to hide' : 'click to show'}${s.accounts.length ? '\n' + s.accounts.join('\n') : ''}`}
        style={{
          position: 'relative', textAlign: 'left', cursor: 'pointer',
          background: 'var(--bg)',
          border: `1px solid ${on ? color + '88' : 'var(--border)'}`,
          borderLeft: `3px solid ${on ? color : 'var(--border)'}`,
          borderRadius: 8, padding: '7px 9px', opacity: on ? 1 : 0.5,
        }}
      >
        {isCustom && (
          <span
            role="button"
            title={`Remove ${name}`}
            onClick={e => { e.stopPropagation(); removeSymbol(s.id.replace(/^sym:/, '')); }}
            style={{
              position: 'absolute', top: 3, right: 5, fontSize: 14, lineHeight: 1,
              color: 'var(--muted)', cursor: 'pointer', padding: 2,
            }}
          >×</span>
        )}
        <div style={{ display: 'flex', alignItems: 'center', minHeight: 30, marginBottom: 4 }}>
          <SeriesIcon color={on ? color : 'var(--muted)'} dashed={!isInst} />
          <span style={{
            fontSize: 11, color: 'var(--muted)', lineHeight: 1.25,
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
          } as React.CSSProperties}>{name}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
          <span style={{ fontSize: 17, fontWeight: 700, lineHeight: 1.1, color: !w ? 'var(--muted)' : w.cagr >= 0 ? 'var(--green)' : 'var(--red)' }}>
            {w ? (privacy ? '••••' : fmtPct(w.cagr)) : '—'}
          </span>
          <span style={{ fontSize: 9, color: 'var(--muted)' }}>CAGR</span>
        </div>
        <p style={{ fontSize: 11, marginTop: 2, color: !w ? 'var(--muted)' : w.totalReturn >= 0 ? 'var(--green)' : 'var(--red)' }}>
          {w ? (privacy ? '••••' : fmtPct(w.totalReturn)) : '—'} total
          {isInst && s.accounts.length > 1 && <span style={{ color: 'var(--muted)' }}> · {s.accounts.length} acct</span>}
        </p>
      </button>
    );
  }

  const boxGrid: React.CSSProperties = {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(128px, 1fr))', gap: 6,
  };
  const sectionLabel: React.CSSProperties = {
    fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase',
    letterSpacing: 0.5, margin: '14px 0 6px',
  };

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 24 }}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 600 }}>Investment Performance</h2>
          <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 3 }}>
            Total return, normalised to 100 at start · estimated from current holdings
            {data && <> · {fmtAxisDate(from)} – {fmtAxisDate(to)}</>}
          </p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {PRESETS.map(r => (
              <button key={r.key} onClick={() => setRange(r.key)} style={{
                fontSize: 12, padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
                background: range === r.key ? 'var(--accent)' : 'var(--bg)',
                color: range === r.key ? '#fff' : 'var(--muted)',
                border: '1px solid var(--border)',
              }}>{r.label}</button>
            ))}
            <button onClick={openCustom} style={{
              fontSize: 12, padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
              background: range === 'custom' ? 'var(--accent)' : 'var(--bg)',
              color: range === 'custom' ? '#fff' : 'var(--muted)',
              border: '1px solid var(--border)',
            }}>Custom</button>
          </div>
          {range === 'custom' && data && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: 'var(--muted)' }}>
              <input type="date" value={customFrom} min={data.startDate} max={customTo || data.endDate}
                onChange={e => setCustomFrom(e.target.value)} style={inputStyle} />
              <span>–</span>
              <input type="date" value={customTo} min={customFrom || data.startDate} max={data.endDate}
                onChange={e => setCustomTo(e.target.value)} style={inputStyle} />
            </div>
          )}
        </div>
      </div>

      {/* Loading / error */}
      {loading && (
        <div style={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <p style={{ color: 'var(--muted)' }}>Fetching price history…</p>
        </div>
      )}
      {error && <p style={{ color: 'var(--red)', fontSize: 13 }}>Failed to load: {error}</p>}

      {data && !loading && view && (
        <>
          {/* Chart */}
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={view.rows} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis
                dataKey="date"
                tickFormatter={fmtAxisDate}
                tick={{ fill: 'var(--muted)', fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                minTickGap={52}
              />
              <YAxis
                tickFormatter={v => `${v}`}
                tick={{ fill: 'var(--muted)', fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                domain={['auto', 'auto']}
              />
              <ReferenceLine y={100} stroke="var(--border)" strokeDasharray="4 2" />
              <Tooltip
                contentStyle={{
                  background: 'var(--bg)', border: '1px solid var(--border)',
                  borderRadius: 8, fontSize: 12, padding: '8px 12px',
                }}
                itemSorter={item => -(item.value as number)}
                labelFormatter={label =>
                  new Date(label + 'T00:00:00').toLocaleDateString('en-US', {
                    month: 'long', day: 'numeric', year: 'numeric',
                  })
                }
                formatter={(value: number, id: string) => {
                  const s = allSeries.find(x => x.id === id);
                  const name = s?.type === 'benchmark'
                    ? (BENCH_SHORT[id] ?? s.label)
                    : (s?.label ?? id);
                  const pct = value - 100;
                  const sign = pct >= 0 ? '+' : '';
                  return [
                    privacy ? '••••' : `${value.toFixed(1)} (${sign}${pct.toFixed(1)}%)`,
                    name,
                  ];
                }}
              />
              {accountsAll.map(s =>
                active.has(s.id) && view.map.has(s.id) ? (
                  <Line key={s.id} type="linear" dataKey={s.id}
                    stroke={colorOf.get(s.id)}
                    strokeWidth={s.id === 'total' ? 3 : 2.5} dot={false} connectNulls isAnimationActive={false} />
                ) : null
              )}
              {benchmarksAll.map(s =>
                active.has(s.id) && view.map.has(s.id) ? (
                  <Line key={s.id} type="linear" dataKey={s.id}
                    stroke={colorOf.get(s.id)}
                    strokeWidth={1.5} strokeDasharray="5 3"
                    dot={false} connectNulls isAnimationActive={false} />
                ) : null
              )}
            </LineChart>
          </ResponsiveContainer>

          {/* Accounts — click a box to toggle its line */}
          {accountsAll.length > 0 && (
            <>
              <p style={sectionLabel}>Accounts</p>
              <div style={boxGrid}>
                {accountsAll.map(s => <SeriesBox key={s.id} s={s} />)}
              </div>
            </>
          )}

          {/* Index comparisons — built-in benchmarks + custom tickers */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, margin: '14px 0 6px' }}>
            <span style={{ ...sectionLabel, margin: 0 }} title="Indexes you turn on are saved and shown by default next time">
              Index comparisons <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, opacity: 0.7 }}>· picks saved as default</span>
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                value={addInput}
                onChange={e => { setAddInput(e.target.value); if (addError) setAddError(null); }}
                onKeyDown={e => { if (e.key === 'Enter') addSymbol(); }}
                placeholder="Add ticker (e.g. VTI)"
                maxLength={12}
                style={{ ...inputStyle, width: 150, textTransform: 'uppercase' }}
              />
              <button onClick={addSymbol} disabled={adding || !addInput.trim()} style={{
                fontSize: 12, padding: '4px 12px', borderRadius: 6, cursor: adding || !addInput.trim() ? 'default' : 'pointer',
                background: 'var(--accent)', color: '#fff', border: '1px solid var(--border)',
                opacity: adding || !addInput.trim() ? 0.6 : 1,
              }}>{adding ? 'Checking…' : 'Add'}</button>
            </div>
          </div>
          {addError && <p style={{ color: 'var(--red)', fontSize: 12, marginBottom: 6 }}>{addError}</p>}
          <div style={boxGrid}>
            {benchmarksAll.map(s => <SeriesBox key={s.id} s={s} />)}
          </div>
        </>
      )}
    </div>
  );
}
