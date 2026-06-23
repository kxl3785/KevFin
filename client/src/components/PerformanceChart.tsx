import { useState, useMemo } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { useApi } from '../hooks/useApi.ts';

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
const BENCH_COLORS: Record<string, string> = {
  SPY:   '#94a3b8',
  QQQ:   '#64748b',
  VFFVX: '#c084fc',
  BND:   '#475569',
};
const BENCH_SHORT: Record<string, string> = {
  SPY:   'S&P 500',
  QQQ:   'Nasdaq 100',
  VFFVX: 'Target Date',
  BND:   'Total Bond',
};

const RANGES = [
  { label: '1Y', days: 365 },
  { label: '3Y', days: 1095 },
  { label: '5Y', days: 1825 },
];

function fmtAxisDate(d: string): string {
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}

function fmtPct(n: number): string {
  return (n >= 0 ? '+' : '') + (n * 100).toFixed(1) + '%';
}

function mergePoints(series: PerfSeries[]): Record<string, unknown>[] {
  const dateSet = new Set<string>();
  for (const s of series) s.points.forEach(p => dateSet.add(p.date));
  return [...dateSet].sort().map(date => {
    const row: Record<string, unknown> = { date };
    for (const s of series) {
      const pt = s.points.find(p => p.date === date);
      if (pt != null) row[s.id] = pt.value;
    }
    return row;
  });
}

// Small legend dot / dash indicator for the CAGR card header
function SeriesIcon({ color, dashed }: { color: string; dashed: boolean }) {
  return dashed
    ? <span style={{ display: 'inline-block', width: 16, height: 2, background: color, borderRadius: 1, verticalAlign: 'middle', marginRight: 6 }} />
    : <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: color, verticalAlign: 'middle', marginRight: 6 }} />;
}

export default function PerformanceChart({ privacy }: { privacy: boolean }) {
  const [days, setDays] = useState(365);
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const { data, loading, error } = useApi<PerformanceData>(`/api/performance?days=${days}`);

  const toggle = (id: string) =>
    setHidden(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const institutions = useMemo(() => data?.series.filter(s => s.type === 'account') ?? [], [data]);
  const benchmarks   = useMemo(() => data?.series.filter(s => s.type === 'benchmark') ?? [], [data]);
  const visibleSeries = useMemo(() => data?.series.filter(s => !hidden.has(s.id)) ?? [], [data, hidden]);
  const chartData = useMemo(() => data ? mergePoints(data.series) : [], [data]);

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 24 }}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 600 }}>Investment Performance</h2>
          <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 3 }}>
            Normalised to 100 at start · based on current holdings · estimated
          </p>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {RANGES.map(r => (
            <button key={r.label} onClick={() => setDays(r.days)} style={{
              fontSize: 12, padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
              background: days === r.days ? 'var(--accent)' : 'var(--bg)',
              color: days === r.days ? '#fff' : 'var(--muted)',
              border: '1px solid var(--border)',
            }}>{r.label}</button>
          ))}
        </div>
      </div>

      {/* Institution + benchmark toggles */}
      {data && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14, alignItems: 'center' }}>
          {institutions.map((s, i) => {
            const color = INST_COLORS[i % INST_COLORS.length];
            const off = hidden.has(s.id);
            return (
              <button
                key={s.id}
                onClick={() => toggle(s.id)}
                title={s.accounts.join('\n')}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  fontSize: 12, padding: '4px 12px', borderRadius: 14, cursor: 'pointer',
                  background: off ? 'transparent' : color + '20',
                  color: off ? 'var(--muted)' : color,
                  border: `1px solid ${off ? 'var(--border)' : color + '88'}`,
                  opacity: off ? 0.5 : 1,
                }}
              >
                <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: off ? 'var(--muted)' : color }} />
                {s.label}
                <span style={{ fontSize: 10, opacity: 0.7 }}>({s.accounts.length})</span>
              </button>
            );
          })}

          {institutions.length > 0 && benchmarks.length > 0 && (
            <span style={{ width: 1, height: 20, background: 'var(--border)', margin: '0 2px', flexShrink: 0 }} />
          )}

          {benchmarks.map(s => {
            const color = BENCH_COLORS[s.id] ?? '#94a3b8';
            const off = hidden.has(s.id);
            return (
              <button
                key={s.id}
                onClick={() => toggle(s.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  fontSize: 12, padding: '4px 12px', borderRadius: 14, cursor: 'pointer',
                  background: off ? 'transparent' : 'var(--bg)',
                  color: off ? 'var(--muted)' : color,
                  border: `1px solid ${off ? 'var(--border)' : color}`,
                  opacity: off ? 0.5 : 1,
                }}
              >
                <span style={{ width: 14, height: 2, borderRadius: 1, flexShrink: 0, background: off ? 'var(--muted)' : color }} />
                {BENCH_SHORT[s.id] ?? s.label}
              </button>
            );
          })}
        </div>
      )}

      {/* Loading / error */}
      {loading && (
        <div style={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <p style={{ color: 'var(--muted)' }}>Fetching price history…</p>
        </div>
      )}
      {error && <p style={{ color: 'var(--red)', fontSize: 13 }}>Failed to load: {error}</p>}

      {data && !loading && (
        <>
          {/* Chart */}
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={chartData} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
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
                labelFormatter={label =>
                  new Date(label + 'T00:00:00').toLocaleDateString('en-US', {
                    month: 'long', day: 'numeric', year: 'numeric',
                  })
                }
                formatter={(value: number, id: string) => {
                  const s = data.series.find(x => x.id === id);
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
              {institutions.map((s, i) =>
                !hidden.has(s.id) ? (
                  <Line key={s.id} type="monotone" dataKey={s.id}
                    stroke={INST_COLORS[i % INST_COLORS.length]}
                    strokeWidth={2.5} dot={false} connectNulls isAnimationActive={false} />
                ) : null
              )}
              {benchmarks.map(s =>
                !hidden.has(s.id) ? (
                  <Line key={s.id} type="monotone" dataKey={s.id}
                    stroke={BENCH_COLORS[s.id] ?? '#94a3b8'}
                    strokeWidth={1.5} strokeDasharray="5 3"
                    dot={false} connectNulls isAnimationActive={false} />
                ) : null
              )}
            </LineChart>
          </ResponsiveContainer>

          {/* CAGR cards — institutions then benchmarks */}
          {visibleSeries.length > 0 && (
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
              gap: 8,
              marginTop: 16,
            }}>
              {visibleSeries.map(s => {
                const isInst = s.type === 'account';
                const instIdx = institutions.findIndex(a => a.id === s.id);
                const color = isInst
                  ? INST_COLORS[instIdx % INST_COLORS.length]
                  : (BENCH_COLORS[s.id] ?? '#94a3b8');
                const name = isInst ? s.label : (BENCH_SHORT[s.id] ?? s.label);
                return (
                  <div key={s.id} style={{
                    background: 'var(--bg)',
                    border: '1px solid var(--border)',
                    borderLeft: `3px solid ${color}`,
                    borderRadius: 8,
                    padding: '10px 12px',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
                      <SeriesIcon color={color} dashed={!isInst} />
                      <p style={{
                        fontSize: 11, color: 'var(--muted)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>{name}</p>
                    </div>
                    <p style={{ fontSize: 22, fontWeight: 700, color: s.cagr >= 0 ? 'var(--green)' : 'var(--red)' }}>
                      {privacy ? '••••' : fmtPct(s.cagr)}
                    </p>
                    <p style={{ fontSize: 10, color: 'var(--muted)', marginTop: 1, marginBottom: 6 }}>CAGR</p>
                    <p style={{ fontSize: 12, color: s.totalReturn >= 0 ? 'var(--green)' : 'var(--red)' }}>
                      {privacy ? '••••' : fmtPct(s.totalReturn)} total
                    </p>
                    {isInst && s.accounts.length > 1 && (
                      <p style={{ fontSize: 10, color: 'var(--muted)', marginTop: 6 }}>
                        {s.accounts.length} accounts
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
