import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ResponsiveContainer, LineChart, Line, AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
} from 'recharts';
import { isPieType, type ChartSpec } from '@shared/chartSpec';
import { fmtChartAxis, fmtChartValue, fmtShare } from '../lib/assistantChart.ts';
import { fmtDate } from '../lib/format.ts';
import { useIsMobile } from '../hooks/useIsMobile.ts';

// Draws one chart the AI assistant described in a chat answer.
//
// The spec has already passed the shared validator (lib/assistantChart.ts only
// hands over specs that did), and everything in it is rendered as React text or
// as numbers handed to Recharts — never as markup. Titles, labels and series
// names are model output; keep it that way (no dangerouslySetInnerHTML, no
// iframe, no URL built from a spec).
//
// Colours are theme tokens only, so the chart follows all three themes: ink and
// rules from --text / --muted / --border, a lone series in --accent (the app's
// own "the number you asked about" colour), several series from the --chart-N
// ramp in index.css. A series keeps its colour when others are toggled off —
// colour follows the series, not its position among the visible ones.

const SERIES_COLORS = [
  'var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)',
  'var(--chart-5)', 'var(--chart-6)', 'var(--chart-7)', 'var(--chart-8)',
];
// The validator caps series and slices at the ramp's length, so this never wraps.
const colorAt = (i: number) => SERIES_COLORS[i % SERIES_COLORS.length];

interface LegendEntry { name: string; color: string; detail?: string }

// --- tooltip ------------------------------------------------------------------
// Custom content so the text stays in ink tokens (a light series hue is
// unreadable as text) with a swatch beside it carrying the identity.

interface TipItem { dataKey?: string | number; value?: unknown; payload?: Record<string, unknown> }
interface TipProps { active?: boolean; payload?: TipItem[]; label?: string | number }

const tipBox: React.CSSProperties = {
  background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8,
  padding: '7px 10px', fontSize: 12, lineHeight: 1.45, color: 'var(--text)',
  boxShadow: '0 4px 14px rgba(0,0,0,0.18)', maxWidth: 240, whiteSpace: 'normal',
};

function TipRow({ color, name, value }: { color: string; name: string; value: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 2, background: color, flexShrink: 0 }} />
      <span style={{ color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
      <span style={{ marginLeft: 'auto', paddingLeft: 10, fontWeight: 600, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{value}</span>
    </div>
  );
}

// --- the plot -----------------------------------------------------------------

function Plot({ spec, hidden, height, roomy }: { spec: ChartSpec; hidden: ReadonlySet<number>; height: number; roomy: boolean }) {
  const { type, format, labels, series } = spec;
  const tickSize = roomy ? 12 : 11;
  const tick = { fill: 'var(--muted)', fontSize: tickSize };

  // Pie / donut: one series, one slice per label.
  const slices = useMemo(
    () => labels.map((name, i) => ({ name, value: series[0].data[i], index: i })).filter(s => !hidden.has(s.index) && s.value > 0),
    [labels, series, hidden],
  );
  // Cartesian: one row per label, series keyed by position (s0, s1, …) so a
  // series name is only ever displayed, never used as an object key.
  const rows = useMemo(
    () => labels.map((label, i) => {
      const row: Record<string, string | number> = { label };
      series.forEach((s, k) => { row[`s${k}`] = s.data[i]; });
      return row;
    }),
    [labels, series],
  );

  if (isPieType(type)) {
    const total = slices.reduce((sum, s) => sum + s.value, 0);
    const pieTip = ({ active, payload }: TipProps) => {
      const p = active ? payload?.[0]?.payload : undefined;
      if (!p) return null;
      const value = Number(p.value);
      return (
        <div style={tipBox}>
          <TipRow color={colorAt(Number(p.index))} name={String(p.name)} value={fmtChartValue(value, format)} />
          <div style={{ color: 'var(--muted)', textAlign: 'right' }}>{fmtShare(value, total)} of the total shown</div>
        </div>
      );
    };
    return (
      <ResponsiveContainer width="100%" height={height}>
        <PieChart>
          <Pie
            data={slices} dataKey="value" nameKey="name"
            innerRadius={type === 'donut' ? '58%' : 0} outerRadius="92%"
            startAngle={90} endAngle={-270}
            // A gap in the surface colour separates slices (no outline ink).
            stroke="var(--chart-bg)" strokeWidth={2}
            isAnimationActive={false}
          >
            {slices.map(s => <Cell key={s.index} fill={colorAt(s.index)} />)}
          </Pie>
          <Tooltip content={pieTip} />
        </PieChart>
      </ResponsiveContainer>
    );
  }

  const single = series.length === 1;
  const colorOf = (k: number) => (single ? 'var(--accent)' : colorAt(k));
  const shown = series.map((s, k) => ({ s, k })).filter(({ k }) => !hidden.has(k));
  const hasNegative = shown.some(({ s }) => s.data.some(v => v < 0));

  const cartesianTip = ({ active, payload, label }: TipProps) => {
    if (!active || !payload?.length) return null;
    return (
      <div style={tipBox}>
        <div style={{ fontWeight: 600, marginBottom: 3 }}>{label}</div>
        {payload.map(item => {
          const k = Number(String(item.dataKey).slice(1));
          const s = series[k];
          if (!s || typeof item.value !== 'number') return null;
          return <TipRow key={k} color={colorOf(k)} name={s.name} value={fmtChartValue(item.value, format)} />;
        })}
      </div>
    );
  };

  const margin = { top: 6, right: roomy ? 16 : 8, left: 0, bottom: 0 };
  const axes = (
    <>
      {/* Horizontal hairlines only; the plot's ink is the data. */}
      <CartesianGrid stroke="var(--border)" vertical={false} />
      <XAxis
        dataKey="label" tick={tick} tickLine={false} axisLine={{ stroke: 'var(--border)' }}
        tickMargin={6} minTickGap={roomy ? 20 : 12} interval="preserveStartEnd"
      />
      <YAxis
        tick={tick} tickLine={false} axisLine={false} tickMargin={4}
        width={roomy ? 62 : 46}
        tickFormatter={(v: number) => fmtChartAxis(v, format)}
        // A trend line is scaled to the movement on screen (like the dashboard
        // charts); bars and areas are filled from zero, so they keep a zero base.
        domain={type === 'line' ? ['auto', 'auto'] : undefined}
      />
      {hasNegative && type !== 'line' && <ReferenceLine y={0} stroke="var(--muted)" />}
    </>
  );
  const dots = labels.length <= 12;

  if (type === 'line') {
    return (
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={rows} margin={margin}>
          {axes}
          <Tooltip content={cartesianTip} cursor={{ stroke: 'var(--muted)', strokeWidth: 1 }} />
          {shown.map(({ k }) => (
            <Line
              key={k} dataKey={`s${k}`} type="monotone" stroke={colorOf(k)} strokeWidth={2}
              dot={dots ? { r: 3, strokeWidth: 0, fill: colorOf(k) } : false}
              activeDot={{ r: 4, stroke: 'var(--chart-bg)', strokeWidth: 2 }}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    );
  }

  if (type === 'area') {
    return (
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={rows} margin={margin}>
          {axes}
          <Tooltip content={cartesianTip} cursor={{ stroke: 'var(--muted)', strokeWidth: 1 }} />
          {shown.map(({ k }) => (
            // A light wash under a full-strength line, so overlapping series
            // stay readable (these are not stacked).
            <Area
              key={k} dataKey={`s${k}`} type="monotone" stroke={colorOf(k)} strokeWidth={2}
              fill={colorOf(k)} fillOpacity={0.12}
              dot={false} activeDot={{ r: 4, stroke: 'var(--chart-bg)', strokeWidth: 2 }}
              isAnimationActive={false}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    );
  }

  const stacked = type === 'stacked_bar';
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} margin={margin} stackOffset={stacked ? 'sign' : undefined} barGap={2}>
        {axes}
        <Tooltip content={cartesianTip} cursor={{ fill: 'var(--muted)', fillOpacity: 0.12 }} />
        {shown.map(({ k }) => (
          <Bar
            key={k} dataKey={`s${k}`} fill={colorOf(k)} maxBarSize={roomy ? 40 : 24}
            stackId={stacked ? 'stack' : undefined}
            // Stacked segments are separated by a hairline of the surface colour.
            stroke={stacked ? 'var(--chart-bg)' : undefined} strokeWidth={stacked ? 1 : undefined}
            radius={stacked ? 0 : [3, 3, 0, 0]}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

// --- legend -------------------------------------------------------------------
// Real buttons rather than Recharts' <Legend>, so entries are keyboard-reachable
// and announce their state. Click to hide or show a series (or slice).

function Legend({ entries, hidden, onToggle, lineKey, roomy }: {
  entries: LegendEntry[]; hidden: ReadonlySet<number>; onToggle: (i: number) => void; lineKey: boolean; roomy: boolean;
}) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: roomy ? '4px 14px' : '2px 10px', marginTop: 8 }}>
      {entries.map((e, i) => {
        const off = hidden.has(i);
        return (
          <button
            key={i} type="button" onClick={() => onToggle(i)} aria-pressed={!off}
            title={off ? `Show ${e.name}` : `Hide ${e.name}`}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%',
              background: 'transparent', padding: '2px 2px', borderRadius: 4,
              fontSize: roomy ? 13 : 11.5, fontWeight: 400, color: 'var(--text)',
              opacity: off ? 0.45 : 1, textAlign: 'left',
            }}
          >
            <span aria-hidden="true" style={{
              width: lineKey ? 12 : 9, height: lineKey ? 2 : 9, borderRadius: lineKey ? 1 : 2,
              background: e.color, flexShrink: 0,
            }} />
            <span style={{ textDecoration: off ? 'line-through' : 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name}</span>
            {e.detail && <span style={{ color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>{e.detail}</span>}
          </button>
        );
      })}
    </div>
  );
}

// Plot + legend, with the click-to-toggle state. Used both in the chat bubble
// and on the page view (each keeps its own toggles).
function ChartFigure({ spec, height, roomy }: { spec: ChartSpec; height: number; roomy: boolean }) {
  const [hidden, setHidden] = useState<ReadonlySet<number>>(() => new Set());
  const pie = isPieType(spec.type);

  const entries: LegendEntry[] = useMemo(() => {
    if (pie) {
      const values = spec.series[0].data;
      const total = values.reduce((sum, v, i) => (hidden.has(i) ? sum : sum + v), 0);
      return spec.labels.map((name, i) => ({
        name, color: colorAt(i), detail: hidden.has(i) ? undefined : fmtShare(values[i], total),
      }));
    }
    return spec.series.map((s, k) => ({ name: s.name, color: colorAt(k) }));
  }, [spec, pie, hidden]);

  // Hiding the last visible entry would leave an empty plot — bring them all back instead.
  const toggle = (i: number) => setHidden(prev => {
    const next = new Set(prev);
    if (next.has(i)) next.delete(i); else next.add(i);
    return next.size >= entries.length ? new Set<number>() : next;
  });

  // One series needs no legend: the title already says what is plotted.
  const showLegend = pie || spec.series.length > 1;
  return (
    <>
      <Plot spec={spec} hidden={hidden} height={height} roomy={roomy} />
      {showLegend && (
        <Legend
          entries={entries} hidden={hidden} onToggle={toggle} roomy={roomy}
          lineKey={spec.type === 'line' || spec.type === 'area'}
        />
      )}
    </>
  );
}

// --- "Open as page" -----------------------------------------------------------
// A full-window, paper-white view of one chart with its data table underneath,
// laid out so the browser's own Print → Save as PDF produces a clean page (see
// the .chart-page rules in index.css). No PDF library and no network: it is the
// same component drawn larger, in a portal on <body> so print CSS can hide the
// rest of the app.

function DataTable({ spec }: { spec: ChartSpec }) {
  const { format, labels, series } = spec;
  // A pie's slices also get their share of the whole — unless the values are
  // already percentages, where the column would only repeat them.
  const share = isPieType(spec.type) && format !== 'percent';
  const total = share ? series[0].data.reduce((a, b) => a + b, 0) : 0;
  const th: React.CSSProperties = { padding: '7px 10px', fontSize: 12, fontWeight: 600, color: 'var(--muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' };
  const td: React.CSSProperties = { padding: '6px 10px', fontSize: 13, borderBottom: '1px solid var(--border)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th scope="col" style={{ ...th, textAlign: 'left' }} />
            {series.map((s, k) => <th key={k} scope="col" style={{ ...th, textAlign: 'right' }}>{s.name}</th>)}
            {share && <th scope="col" style={{ ...th, textAlign: 'right' }}>% of total</th>}
          </tr>
        </thead>
        <tbody>
          {labels.map((label, i) => (
            <tr key={i}>
              <th scope="row" style={{ ...td, textAlign: 'left', fontWeight: 500 }}>{label}</th>
              {series.map((s, k) => <td key={k} style={{ ...td, textAlign: 'right' }}>{fmtChartValue(s.data[i], format)}</td>)}
              {share && <td style={{ ...td, textAlign: 'right', color: 'var(--muted)' }}>{fmtShare(series[0].data[i], total)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ChartPage({ spec, onClose }: { spec: ChartSpec; onClose: () => void }) {
  const isMobile = useIsMobile();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // The body class is what the print rules key on; it also stops the app
    // behind from scrolling while the page is up.
    document.body.classList.add('chart-page-open');
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.classList.remove('chart-page-open');
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return createPortal(
    <div className="chart-page" role="dialog" aria-modal="true" aria-label={spec.title}>
      <div className="chart-page-bar no-print">
        <button ref={closeRef} type="button" className="btn-ghost btn-sm" onClick={onClose}>← Back to chat</button>
        <button type="button" className="btn-primary btn-sm" onClick={() => window.print()}>Print or save as PDF</button>
      </div>
      <div className="chart-page-sheet">
        <h1 style={{ fontSize: isMobile ? 20 : 24, fontWeight: 650, lineHeight: 1.25 }}>{spec.title}</h1>
        <p style={{ color: 'var(--muted)', fontSize: 12.5, marginTop: 4, marginBottom: 18 }}>
          KevFin AI assistant · {fmtDate(new Date())}
        </p>
        <div className="chart-page-figure" role="figure" aria-label={spec.title}>
          <ChartFigure spec={spec} height={isMobile ? 280 : 420} roomy />
        </div>
        <h2 style={{ fontSize: 14, fontWeight: 600, marginTop: 28, marginBottom: 6 }}>Data</h2>
        <DataTable spec={spec} />
        <p style={{ color: 'var(--muted)', fontSize: 11.5, marginTop: 14 }}>
          Figures are as given by the assistant in its answer. Check anything important against the app.
        </p>
      </div>
    </div>,
    document.body,
  );
}

// --- the chart as it sits in a chat bubble ------------------------------------

function AssistantChart({ spec }: { spec: ChartSpec }) {
  const [pageOpen, setPageOpen] = useState(false);
  const openerRef = useRef<HTMLButtonElement>(null);
  const closePage = useCallback(() => {
    setPageOpen(false);
    openerRef.current?.focus(); // back to where the reader was
  }, []);

  return (
    // The bubble is pre-wrap for the model's text; the chart is laid out normally.
    <div role="figure" aria-label={spec.title} style={{ whiteSpace: 'normal', margin: '6px 0', ['--chart-bg' as string]: 'var(--bg)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 6 }}>
        <p style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, lineHeight: 1.35 }}>{spec.title}</p>
        <button
          ref={openerRef} type="button" onClick={() => setPageOpen(true)}
          title="Open this chart full-width, ready to print or save as PDF"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0,
            background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)',
            padding: '3px 7px', borderRadius: 6, fontSize: 11, fontWeight: 500, whiteSpace: 'nowrap',
          }}
        >
          <svg viewBox="0 0 24 24" width={11} height={11} fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
          </svg>
          Open as page
        </button>
      </div>
      <ChartFigure spec={spec} height={isPieType(spec.type) ? 180 : 190} roomy={false} />
      {pageOpen && <ChartPage spec={spec} onClose={closePage} />}
    </div>
  );
}

export default memo(AssistantChart);
