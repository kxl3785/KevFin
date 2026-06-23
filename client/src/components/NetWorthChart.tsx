import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend,
} from 'recharts';

interface ChartPoint {
  date: string;
  accounts_total: number;
  real_estate_total: number;
  net_worth: number;
  index?: number | null;
}

function fmt(n: number) {
  return '$' + Math.round(n).toLocaleString();
}

// Round a value down/up to a "nice" $100k step so the zoomed axis lands on
// readable bounds (e.g. $1.4M, not $1,387,204).
const STEP = 100_000;

export default function NetWorthChart({
  data,
  mode = 'stacked',
  showAccounts = true,
  showRealEstate = true,
  indexLabel,
  onToggleSeries,
}: {
  data: ChartPoint[];
  mode?: 'stacked' | 'lines';
  showAccounts?: boolean;
  showRealEstate?: boolean;
  indexLabel?: string;
  onToggleSeries?: (dataKey: string) => void;
}) {
  const sorted = [...data].sort((a, b) => a.date.localeCompare(b.date));
  const stacked = mode === 'stacked';

  // Stacked areas need a $0 baseline to read correctly. Lines mode zooms the
  // axis to the data range so month-to-month change is visible.
  const yDomain = stacked
    ? ([, dataMax]: [number, number]): [number, number] =>
        [0, Math.ceil((dataMax * 1.05) / STEP) * STEP]
    : ([dataMin, dataMax]: [number, number]): [number, number] =>
        [Math.max(0, Math.floor((dataMin * 0.98) / STEP) * STEP), Math.ceil((dataMax * 1.02) / STEP) * STEP];

  return (
    <div style={{ width: '100%', height: 320 }}>
      <ResponsiveContainer>
        {/* key={mode} forces a clean remount when switching area↔line so every
            series re-renders (recharts otherwise drops series on type swap). */}
        <ComposedChart key={mode} data={sorted} margin={{ top: 8, right: 16, left: 16, bottom: 0 }}>
          <defs>
            <linearGradient id="gRE" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#4ade80" stopOpacity={0.7} />
              <stop offset="95%" stopColor="#4ade80" stopOpacity={0.4} />
            </linearGradient>
            <linearGradient id="gAcc" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#fbbf24" stopOpacity={0.7} />
              <stop offset="95%" stopColor="#fbbf24" stopOpacity={0.35} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#2a2d3a" />
          <XAxis
            dataKey="date"
            tick={{ fill: '#7b7f95', fontSize: 12 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={d => d.slice(2, 7)}
          />
          <YAxis
            tick={{ fill: '#7b7f95', fontSize: 12 }}
            tickLine={false}
            axisLine={false}
            width={52}
            domain={yDomain}
            allowDataOverflow={!stacked}
            tickFormatter={v => '$' + (v >= 1_000_000 ? (v / 1_000_000).toFixed(1) + 'M' : (v / 1000).toFixed(0) + 'k')}
          />
          <Tooltip
            contentStyle={{ background: '#1a1d27', border: '1px solid #2a2d3a', borderRadius: 8 }}
            labelStyle={{ color: '#e8eaf0', marginBottom: 4 }}
            formatter={(val: number, name: string) => [fmt(val), name]}
          />
          <Legend
            wrapperStyle={{ fontSize: 13, color: '#7b7f95', cursor: 'pointer' }}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            onClick={(e: any) => { const k = e?.dataKey; if (typeof k === 'string') onToggleSeries?.(k); }}
          />

          {stacked ? (
            <>
              {/* Stacked composition: real estate on the bottom, accounts on top. */}
              <Area
                type="monotone" dataKey="real_estate_total" name="Real Estate" stackId="nw"
                stroke="#4ade80" fill="url(#gRE)" strokeWidth={1.5} dot={false} hide={!showRealEstate}
              />
              <Area
                type="monotone" dataKey="accounts_total" name="Accounts" stackId="nw"
                stroke="#fbbf24" fill="url(#gAcc)" strokeWidth={1.5} dot={false} hide={!showAccounts}
              />
            </>
          ) : (
            <>
              {/* Trend lines, no fill — readable against a zoomed axis. */}
              <Line
                type="monotone" dataKey="real_estate_total" name="Real Estate"
                stroke="#4ade80" strokeWidth={2} dot={false} hide={!showRealEstate}
              />
              <Line
                type="monotone" dataKey="accounts_total" name="Accounts"
                stroke="#fbbf24" strokeWidth={2} dot={false} hide={!showAccounts}
              />
            </>
          )}

          {/* Net worth — the headline line, drawn on top in both modes. */}
          <Line
            type="monotone" dataKey="net_worth" name="Net Worth"
            stroke="#6c8fff" strokeWidth={2.5} dot={false}
          />

          {indexLabel && (
            <Line
              type="monotone" dataKey="index" name={indexLabel}
              stroke="#f472b6" strokeWidth={2} strokeDasharray="5 4" dot={false} connectNulls
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
