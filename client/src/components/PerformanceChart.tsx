import { useState, useMemo, useEffect, useRef } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { usePersistentState } from '../hooks/usePersistentState.ts';
import { periodLabel, isShortSpan, fmtFullDate, fmtMonthYear } from '../lib/periodLabel.ts';
import {
  rangeBounds, windowSeries, commonStart, firstDateIn, fmtReturn, percentTicks, fmtTick,
  type PerfPoint, type PerfRange, type RangeKey, type Windowed,
} from '../lib/perfWindow.ts';

export interface PerfSeries {
  id: string;
  label: string;
  type: 'account' | 'benchmark';
  accounts: string[];
  points: PerfPoint[];
  cagr: number;
  totalReturn: number;
}
export interface PerformanceData {
  series: PerfSeries[];
  startDate: string;
  endDate: string;
}

// The whole 5y history is fetched once; ranges are applied client-side so
// switching is instant and a true custom from–to window is possible. The page
// makes this one request and hands it to both the chart and the "Return" tile:
// the tile mounts later (after the allocation loads), and a second useApi there
// found the cached result already stale and fetched it all again.
export const FETCH_DAYS = 1825;
export const PERF_URL = `/api/performance?days=${FETCH_DAYS}`;

// Series colours come from the theme's chart tokens, so all three themes keep
// their contrast. The blended "All accounts" line is the text colour and the
// S&P 500 is muted and dashed: the two lines the page is about read first.
const TOTAL_COLOR = 'var(--text)';
const SERIES_TOKENS = ['var(--chart-1)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', 'var(--chart-7)', 'var(--chart-2)', 'var(--chart-6)', 'var(--chart-8)'];
const BENCH_COLORS: Record<string, string> = {
  SPY:   'var(--muted)',
  QQQ:   'var(--chart-7)',
  VFFVX: 'var(--chart-5)',
  BND:   'var(--chart-2)',
};
const BENCH_SHORT: Record<string, string> = {
  SPY:   'S&P 500',
  QQQ:   'Nasdaq 100',
  VFFVX: 'Target date',
  BND:   'Total bond',
};
// Benchmarks drawn when the user has never picked any.
const DEFAULT_INDEXES = ['SPY'];

const PRESETS: { key: RangeKey; label: string }[] = [
  { key: 'YTD', label: 'YTD' },
  { key: '1Y', label: '1Y' },
  { key: '3Y', label: '3Y' },
  { key: '5Y', label: '5Y' },
  { key: 'ALL', label: 'Max' },
];

// Axis ticks read "Jan '26" — "Jan 26" looks like January 26th.
function fmtAxisDate(d: string): string {
  const dt = new Date(d + 'T00:00:00Z');
  const mon = dt.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
  return `${mon} '${String(dt.getUTCFullYear()).slice(2)}`;
}

export const seriesName = (s: PerfSeries) => (s.type === 'account' ? (s.id === 'total' ? 'All accounts' : s.label) : (BENCH_SHORT[s.id] ?? s.label));

// One compact chip per series: a line swatch (solid for accounts, dashed for
// comparisons), the name, and its return over the window. Click toggles the
// line. Declared here, not inside the chart, so a chip keeps its identity (and
// keyboard focus) when toggling it re-renders the chart.
function SeriesChip({ s, color, on, w, range, from, to, privacy, onToggle, onRemove }: {
  s: PerfSeries;
  color: string;
  on: boolean;
  /** The series windowed as drawn (from the lines' common start), if it has data. */
  w: Windowed | undefined;
  range: RangeKey;
  from: string;
  to: string;
  privacy: boolean;
  onToggle: (id: string) => void;
  onRemove: (sym: string) => void;
}) {
  const isAcct = s.type === 'account';
  const name = seriesName(s);
  const isCustom = s.id.startsWith('sym:');
  // Spans under a year show the period return; longer spans add the yearly
  // (annualised) rate, which a partial year would only extrapolate. The tooltip
  // always gives the exact dates the return is measured over.
  const first = w?.points[0]?.date;
  const last = w?.points[w.points.length - 1]?.date;
  const period = w && first ? periodLabel(range, from, to, first) : '';
  const short = !!w && !!first && !!last && isShortSpan(first, last);
  const tip = [
    `${name} — ${on ? 'click to hide' : 'click to show'}`,
    w && first && last ? `${fmtReturn(w.totalReturn)} ${period} (${fmtFullDate(first)} – ${fmtFullDate(last)})${short ? '' : ` · ${fmtReturn(w.cagr)} a year`}` : '',
    ...s.accounts,
  ].filter(Boolean).join('\n');
  const tone = !w || privacy ? 'var(--muted)' : w.totalReturn >= 0 ? 'var(--green)' : 'var(--red)';
  return (
    <span className={'inv-chip' + (on ? ' on' : '')}>
      <button type="button" onClick={() => onToggle(s.id)} aria-pressed={on} title={privacy ? `${name} — ${on ? 'click to hide' : 'click to show'}` : tip}>
        <i aria-hidden="true" style={{ borderTopColor: on ? color : 'var(--muted)', borderTopStyle: isAcct ? 'solid' : 'dashed' }} />
        <span>{name}</span>
        <b style={{ color: tone, fontWeight: isAcct ? 700 : 500 }}>{!w ? '—' : privacy ? '••••' : fmtReturn(w.totalReturn)}</b>
        {w && !short && !privacy && <small>{fmtReturn(w.cagr)}/yr</small>}
      </button>
      {isCustom && (
        <button type="button" className="inv-chip-x" aria-label={`Remove ${name}`} title={`Remove ${name}`}
          onClick={() => onRemove(s.id.replace(/^sym:/, ''))}>×</button>
      )}
    </span>
  );
}

export default function PerformanceChart({ perf, privacy, sel, onSel }: {
  /** The page's one GET of PERF_URL (shared with the "Return" tile). */
  perf: { data: PerformanceData | null; loading: boolean; error: string | null };
  privacy: boolean;
  /** The selected range, shared with the page's "Return" tile. */
  sel: PerfRange;
  onSel: (next: PerfRange) => void;
}) {
  const { range, customFrom, customTo } = sel;
  // Index comparisons (benchmarks + custom tickers) drawn on the chart. They
  // are persisted, so a selection sticks across visits; accounts always start
  // as the total only. The S&P 500 shows by default: picks saved under the
  // earlier key (whose default was none) are carried over with it added, until
  // the user toggles something and the new key takes over.
  const [legacyIndexes] = usePersistentState<string[]>('mon.perfDefaultIndexes', []);
  const [savedIndexes, setSavedIndexes] = usePersistentState<string[] | null>('mon.perfCompare', null);
  const fallbackIndexes = useMemo(() => [...new Set([...DEFAULT_INDEXES, ...legacyIndexes])], [legacyIndexes]);
  const defaultIndexes = Array.isArray(savedIndexes) ? savedIndexes : fallbackIndexes;
  const setDefaultIndexes = (fn: (prev: string[]) => string[]) =>
    setSavedIndexes(prev => fn(Array.isArray(prev) ? prev : fallbackIndexes));
  // Account lines drawn (index lines are exactly the saved picks above).
  const [activeAccts, setActiveAccts] = useState<Set<string>>(() => new Set(['total']));
  const active = useMemo(() => new Set([...activeAccts, ...defaultIndexes]), [activeAccts, defaultIndexes]);
  // User-added comparison tickers (validated before they're saved here).
  const [customSymbols, setCustomSymbols] = usePersistentState<string[]>('mon.perfCustom', []);
  const [customSeries, setCustomSeries] = useState<Record<string, PerfSeries>>({});
  const [addOpen, setAddOpen] = useState(false);
  const [addInput, setAddInput] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const addRef = useRef<HTMLInputElement>(null);

  const { data, loading, error } = perf;

  useEffect(() => { if (addOpen) addRef.current?.focus(); }, [addOpen]);

  // Accounts are 'total' / 'org:*'; everything else is an index comparison.
  const isIndexId = (id: string) => id !== 'total' && !id.startsWith('org:');

  const toggle = (id: string) => {
    // Index-comparison picks persist, so they're the default next visit.
    if (isIndexId(id)) setDefaultIndexes(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
    else setActiveAccts(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
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
      setDefaultIndexes(prev => prev.includes(series.id) ? prev : [...prev, series.id]); // show it now and next visit
      setAddInput('');
      setAddOpen(false);
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

  // Stable colour per series: total = text, other accounts and custom tickers
  // cycle the theme's chart tokens, built-in benchmarks have their own.
  const colorOf = useMemo(() => {
    const m = new Map<string, string>();
    let i = 0;
    for (const s of accountsAll) m.set(s.id, s.id === 'total' ? TOTAL_COLOR : SERIES_TOKENS[i++ % SERIES_TOKENS.length]);
    customSymbols.forEach(sym => m.set(`sym:${sym}`, SERIES_TOKENS[i++ % SERIES_TOKENS.length]));
    for (const s of benchmarksAll) if (!m.has(s.id)) m.set(s.id, BENCH_COLORS[s.id] ?? 'var(--muted)');
    return m;
  }, [accountsAll, benchmarksAll, customSymbols]);

  const [from, to] = useMemo(() => rangeBounds(sel, data?.startDate, data?.endDate), [sel, data]);

  // Window every series and merge into chart rows (keyed by date), in percent.
  // Lines drawn against each other are re-based at one date: the latest first
  // date among the drawn lines in this range (the S&P 500's history can begin
  // a week after your own). Measuring each from its own first point would put
  // a week's market move into the comparison. Lines not drawn are windowed
  // from the same date, so a chip's figure matches its line when switched on;
  // one with no data that early keeps its own start, which its tooltip states.
  const view = useMemo(() => {
    if (!data) return null;
    const drawn = allSeries.filter(s => active.has(s.id));
    const start = commonStart(drawn.map(s => s.points), from, to) ?? from;
    // Earliest first date among the drawn lines: when the common start is
    // later, the header says the lines are compared from that date.
    const own = drawn.map(s => firstDateIn(s.points, from, to)).filter((d): d is string => !!d).sort()[0] ?? start;
    const map = new Map<string, Windowed>();
    for (const s of allSeries) { const w = windowSeries(s.points, start, to); if (w) map.set(s.id, w); }
    const dateSet = new Set<string>();
    for (const w of map.values()) w.points.forEach(p => dateSet.add(p.date));
    const rows = [...dateSet].sort().map(date => {
      const row: Record<string, unknown> = { date };
      for (const [id, w] of map) { const pt = w.points.find(p => p.date === date); if (pt) row[id] = pt.value; }
      return row;
    });
    return { map, rows, start, late: start > own };
  }, [data, allSeries, active, from, to]);

  // Y-axis over the lines actually drawn, always with a labelled 0% tick.
  const yAxis = useMemo(() => {
    let lo = 0, hi = 0;
    for (const [id, w] of view?.map ?? []) {
      if (!active.has(id)) continue;
      for (const p of w.points) { if (p.value < lo) lo = p.value; if (p.value > hi) hi = p.value; }
    }
    return percentTicks(lo, hi);
  }, [view, active]);

  // Actual first/last plotted dates (a window can be wider than the data, and
  // the history fetch is capped at FETCH_DAYS, so "Max" is really that cap).
  const span: [string, string] | null = view && view.rows.length
    ? [view.rows[0].date as string, view.rows[view.rows.length - 1].date as string] : null;

  // One x-axis tick per month: weekly points would otherwise put two ticks in the
  // same month, repeating the label ("Aug '26" twice).
  const monthTicks = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of view?.rows ?? []) {
      const d = r.date as string;
      if (!seen.has(d.slice(0, 7))) { seen.add(d.slice(0, 7)); out.push(d); }
    }
    return out;
  }, [view]);

  function openCustom() {
    onSel({
      range: 'custom',
      customFrom: customFrom || data?.startDate || '',
      customTo: customTo || data?.endDate || '',
    });
  }

  const chipProps = (s: PerfSeries) => ({
    s, color: colorOf.get(s.id) ?? 'var(--muted)', on: active.has(s.id), w: view?.map.get(s.id),
    range, from, to, privacy, onToggle: toggle, onRemove: removeSymbol,
  });

  const inputStyle: React.CSSProperties = {
    background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)',
    borderRadius: 6, padding: '3px 8px', fontSize: 12,
  };

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 20, minWidth: 0 }}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12, flexWrap: 'wrap', gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600 }}>Performance</h2>
          <p style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.5, marginTop: 2, maxWidth: '96ch' }}>
            What today's holdings would have returned · ignores contributions
            and trades · brokerage accounts only
            {span && <> · {fmtMonthYear(span[0])} – {fmtMonthYear(span[1])}</>}
            {view?.late && <> · lines compared from {fmtFullDate(view.start)}, the first date they all have</>}
          </p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8, maxWidth: '100%' }}>
          <div className="seg scroll-row" role="group" aria-label="Chart period" style={{ flexWrap: 'wrap', maxWidth: '100%' }}>
            {PRESETS.map(r => (
              <button key={r.key} type="button" onClick={() => onSel({ ...sel, range: r.key })} aria-pressed={range === r.key}
                className={'seg-btn' + (range === r.key ? ' active' : '')} style={{ minHeight: 30 }}
                title={r.key === 'ALL' ? 'All fetched history (capped at 5 years)' : undefined}>{r.label}</button>
            ))}
            <button type="button" onClick={openCustom} aria-pressed={range === 'custom'}
              className={'seg-btn' + (range === 'custom' ? ' active' : '')} style={{ minHeight: 30 }}>Custom</button>
          </div>
          {range === 'custom' && data && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: 'var(--muted)', flexWrap: 'wrap' }}>
              <input type="date" aria-label="From" value={customFrom} min={data.startDate} max={customTo || data.endDate}
                onChange={e => onSel({ ...sel, customFrom: e.target.value })} style={inputStyle} />
              <span>–</span>
              <input type="date" aria-label="To" value={customTo} min={customFrom || data.startDate} max={data.endDate}
                onChange={e => onSel({ ...sel, customTo: e.target.value })} style={inputStyle} />
            </div>
          )}
        </div>
      </div>

      {/* Loading / error */}
      {loading && (
        <div style={{ height: 280, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <p style={{ color: 'var(--muted)' }}>Fetching price history…</p>
        </div>
      )}
      {error && <p style={{ color: 'var(--red)', fontSize: 13 }}>Failed to load: {error}</p>}

      {data && !loading && view && (
        <>
          {/* Chart: percent return since the start of the window. */}
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={view.rows} margin={{ top: 4, right: 8, left: privacy ? -40 : -8, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--border)" />
              <XAxis
                dataKey="date"
                tickFormatter={fmtAxisDate}
                ticks={monthTicks}
                tick={{ fill: 'var(--muted)', fontSize: 12 }}
                tickLine={false}
                axisLine={false}
                minTickGap={52}
              />
              <YAxis
                // Privacy mode hides returns everywhere, so the axis loses its labels too.
                tickFormatter={v => (privacy ? '' : fmtTick(v))}
                ticks={yAxis.ticks}
                domain={yAxis.domain}
                tick={{ fill: 'var(--muted)', fontSize: 12 }}
                tickLine={false}
                axisLine={false}
                width={56}
              />
              {/* The zero line: above it you've gained since the window began. */}
              <ReferenceLine y={0} stroke="var(--muted)" strokeWidth={1} ifOverflow="extendDomain" />
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
                  return [privacy ? '••••' : fmtReturn(value / 100), s ? seriesName(s) : id];
                }}
              />
              {benchmarksAll.map(s =>
                active.has(s.id) && view.map.has(s.id) ? (
                  <Line key={s.id} type="linear" dataKey={s.id}
                    stroke={colorOf.get(s.id)}
                    strokeWidth={1.75} strokeDasharray="5 4"
                    dot={false} connectNulls isAnimationActive={false} />
                ) : null
              )}
              {/* Accounts last, so the headline line draws on top of the comparisons. */}
              {accountsAll.map(s =>
                active.has(s.id) && view.map.has(s.id) ? (
                  <Line key={s.id} type="linear" dataKey={s.id}
                    stroke={colorOf.get(s.id)}
                    strokeWidth={s.id === 'total' ? 2.5 : 2} dot={false} connectNulls isAnimationActive={false} />
                ) : null
              )}
            </LineChart>
          </ResponsiveContainer>

          {/* One row of chips: accounts, then comparisons, then "+ Compare". */}
          <div className="inv-chips" role="group" aria-label="Lines on the chart" style={{ marginTop: 12 }}>
            {accountsAll.map(s => <SeriesChip key={s.id} {...chipProps(s)} />)}
            {accountsAll.length > 0 && <span className="inv-chip-divider" aria-hidden="true" />}
            {benchmarksAll.map(s => <SeriesChip key={s.id} {...chipProps(s)} />)}
            {addOpen ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <input
                  ref={addRef}
                  aria-label="Ticker to compare"
                  value={addInput}
                  onChange={e => { setAddInput(e.target.value); if (addError) setAddError(null); }}
                  onKeyDown={e => { if (e.key === 'Enter') addSymbol(); if (e.key === 'Escape') { setAddOpen(false); setAddError(null); } }}
                  placeholder="e.g. VTI"
                  maxLength={12}
                  style={{ ...inputStyle, width: 96, textTransform: 'uppercase', minHeight: 28 }}
                />
                <button type="button" className="btn-primary btn-sm" onClick={addSymbol} disabled={adding || !addInput.trim()}>{adding ? 'Checking…' : 'Add'}</button>
                <button type="button" className="btn-ghost btn-sm" onClick={() => { setAddOpen(false); setAddError(null); setAddInput(''); }}>Cancel</button>
              </span>
            ) : (
              <button type="button" className="inv-link" onClick={() => setAddOpen(true)}
                title="Indexes and tickers you turn on are saved and shown by default next time">+ Compare a ticker</button>
            )}
          </div>
          {addError && <p role="alert" style={{ color: 'var(--red)', fontSize: 12, marginTop: 6 }}>{addError}</p>}
        </>
      )}
    </div>
  );
}
