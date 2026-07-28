import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend,
} from 'recharts';
import { useMemo } from 'react';
import { useIsMobile } from '../hooks/useIsMobile.ts';
import { axisScale, fmtAxisMoney, dateTicks } from '../lib/axis.ts';

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
  const sorted = useMemo(() => [...data].sort((a, b) => a.date.localeCompare(b.date)), [data]);
  const stacked = mode === 'stacked';
  // A little shorter on a phone so the chart doesn't dominate the screen.
  const isMobile = useIsMobile();

  // Scale the axis to what is actually drawn. A hidden series is passed in as a
  // column of zeroes (so the stack keeps its height), so it must not drag the
  // zoomed floor down to $0 — skip it here the same way `hide` skips it below.
  const y = useMemo(() => {
    const vals: number[] = [];
    for (const p of sorted) {
      vals.push(p.net_worth);
      if (typeof p.index === 'number' && Number.isFinite(p.index)) vals.push(p.index);
      // In stacked mode the areas sum to net_worth, which is already counted;
      // only the separate lines set their own extents.
      if (!stacked) {
        if (showAccounts) vals.push(p.accounts_total);
        if (showRealEstate) vals.push(p.real_estate_total);
      }
    }
    if (vals.length === 0) return axisScale(0, 0, { zeroBased: true });
    // Stacked areas are read against a $0 baseline; lines mode zooms in so a
    // month of movement is a visible slope rather than a flat thread.
    return axisScale(Math.min(...vals), Math.max(...vals), {
      zeroBased: stacked,
      targetTicks: isMobile ? 4 : 5,
    });
  }, [sorted, stacked, showAccounts, showRealEstate, isMobile]);

  const x = useMemo(() => dateTicks(sorted.map(p => p.date), isMobile ? 4 : 7), [sorted, isMobile]);

  return (
    <div style={{ width: '100%', height: isMobile ? 240 : 320 }}>
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
          {/* Horizontal rules only — vertical ones just add noise behind a
              date axis whose ticks are already one-per-month. */}
          <CartesianGrid strokeDasharray="3 3" stroke="#2a2d3a" vertical={false} />
          <XAxis
            dataKey="date"
            ticks={x.ticks}
            tick={{ fill: '#7b7f95', fontSize: 12 }}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={16}
            tickFormatter={x.label}
          />
          <YAxis
            tick={{ fill: '#8f94ad', fontSize: 12 }}
            tickLine={false}
            axisLine={false}
            width={isMobile ? 48 : 58}
            domain={y.domain}
            ticks={y.ticks}
            interval={0}
            allowDataOverflow={!stacked}
            tickMargin={6}
            tickFormatter={v => fmtAxisMoney(v, y.step)}
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
