import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
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

export default function NetWorthChart({
  data,
  showAccounts = true,
  showRealEstate = true,
  indexLabel,
  onToggleSeries,
}: {
  data: ChartPoint[];
  showAccounts?: boolean;
  showRealEstate?: boolean;
  indexLabel?: string;
  onToggleSeries?: (dataKey: string) => void;
}) {
  const sorted = [...data].sort((a, b) => a.date.localeCompare(b.date));

  return (
    <div style={{ width: '100%', height: 320 }}>
      <ResponsiveContainer>
        <ComposedChart data={sorted} margin={{ top: 8, right: 16, left: 16, bottom: 0 }}>
          <defs>
            <linearGradient id="gNW" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#6c8fff" stopOpacity={0.3} />
              <stop offset="95%" stopColor="#6c8fff" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="gRE" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#4ade80" stopOpacity={0.25} />
              <stop offset="95%" stopColor="#4ade80" stopOpacity={0} />
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
            width={48}
            // Zoom to the data range (with padding) instead of anchoring at $0,
            // so changes in the lines are visible. Adapts when series are toggled.
            domain={[(min: number) => min * 0.97, (max: number) => max * 1.03]}
            tickFormatter={v => '$' + (v >= 1_000_000 ? (v / 1_000_000).toFixed(2) + 'M' : (v / 1000).toFixed(0) + 'k')}
          />
          <Tooltip
            contentStyle={{ background: '#1a1d27', border: '1px solid #2a2d3a', borderRadius: 8 }}
            labelStyle={{ color: '#e8eaf0', marginBottom: 4 }}
            formatter={(val: number) => fmt(val)}
          />
          <Legend
            wrapperStyle={{ fontSize: 13, color: '#7b7f95', cursor: 'pointer' }}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            onClick={(e: any) => { const k = e?.dataKey; if (typeof k === 'string') onToggleSeries?.(k); }}
          />
          {/* Areas are always present (with `hide`) so excluded ones keep a clickable legend entry. */}
          <Area type="monotone" dataKey="real_estate_total" name="Real Estate" stroke="#4ade80" fill="url(#gRE)" strokeWidth={2} dot={false} hide={!showRealEstate} />
          <Area type="monotone" dataKey="accounts_total" name="Accounts" stroke="#fbbf24" fill="none" strokeWidth={2} dot={false} hide={!showAccounts} />
          <Area type="monotone" dataKey="net_worth" name="Net Worth" stroke="#6c8fff" fill="url(#gNW)" strokeWidth={2.5} dot={false} />
          {indexLabel && (
            <Line type="monotone" dataKey="index" name={indexLabel} stroke="#f472b6" strokeWidth={2} strokeDasharray="5 4" dot={false} connectNulls />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
