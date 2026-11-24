import { useId, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import type { ReturnsIncomeMonth } from '@shared/apiTypes';
import { fmtMoney, fmtMoneyCompact } from '../../lib/format.ts';
import { monthLabel } from './returnsDisplay.ts';
import { NUM, TH } from '../allocation/ui.tsx';

// Monthly dividend / interest / capital-gain income as stacked bars. Each kind
// is named in the legend and the tooltip (never colour alone). The same numbers
// sit in a table that screen readers always get; "Show table" also puts it on
// screen.

const KINDS: { key: 'dividends' | 'interest' | 'capitalGains'; label: string; color: string }[] = [
  { key: 'dividends', label: 'Dividends', color: 'var(--chart-1)' },
  { key: 'interest', label: 'Interest', color: 'var(--chart-3)' },
  { key: 'capitalGains', label: 'Fund payouts of gains', color: 'var(--chart-4)' },
];

const srOnly: React.CSSProperties = {
  position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden',
  clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0,
};

export default function IncomeChart({ months, privacy }: { months: ReturnsIncomeMonth[]; privacy: boolean }) {
  const [showTable, setShowTable] = useState(false);
  const tableId = useId();
  // Only draw the kinds that actually occur (dividends always, as the baseline).
  const kinds = KINDS.filter(k => k.key === 'dividends' || months.some(m => m[k.key] !== 0));
  const money = (n: number) => (privacy ? '••••••' : fmtMoney(n));
  const rows = months.map(m => ({ ...m, label: monthLabel(m.month) }));
  const cell: React.CSSProperties = { ...NUM, padding: '5px 0 5px 12px', borderBottom: '1px solid var(--border)' };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 4 }}>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12, color: 'var(--muted)' }} aria-hidden="true">
          {kinds.map(k => (
            <span key={k.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: k.color, display: 'inline-block' }} />
              {k.label}
            </span>
          ))}
        </div>
        {/* Screen readers always have the table; this also puts it on screen. */}
        <button type="button" onClick={() => setShowTable(s => !s)} aria-controls={tableId}
          style={{ background: 'transparent', border: 'none', color: 'var(--accent)', fontSize: 12, padding: '6px 0', minHeight: 32 }}>
          {showTable ? 'Show chart' : 'Show table'}
        </button>
      </div>
      {!showTable && (
        <div aria-hidden="true">
          <ResponsiveContainer width="100%" height={150}>
            <BarChart data={rows} margin={{ top: 4, right: 4, left: privacy ? -40 : -8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis dataKey="label" tick={{ fill: 'var(--muted)', fontSize: 12 }} tickLine={false} axisLine={false}
                tickFormatter={(l: string) => l.slice(0, 3)} interval="preserveStartEnd" minTickGap={6} />
              <YAxis tick={{ fill: 'var(--muted)', fontSize: 12 }} tickLine={false} axisLine={false} width={privacy ? 20 : 48}
                tickCount={4} tickFormatter={(v: number) => (privacy ? '' : fmtMoneyCompact(v))} />
              <Tooltip
                cursor={{ fill: 'var(--muted)', fillOpacity: 0.12 }}
                contentStyle={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12, padding: '8px 12px' }}
                labelStyle={{ color: 'var(--text)' }}
                formatter={(value: number, name: string) => [money(value), KINDS.find(k => k.key === name)?.label ?? name]}
              />
              {kinds.map(k => (
                <Bar key={k.key} dataKey={k.key} stackId="income" fill={k.color} isAnimationActive={false} radius={[2, 2, 0, 0]} maxBarSize={36} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
      <div id={tableId} className={showTable ? 'scroll-x' : undefined} style={showTable ? { maxHeight: 320, overflowY: 'auto' } : undefined}>
        <table style={showTable ? { width: '100%', borderCollapse: 'collapse', fontSize: 13 } : srOnly}>
          <caption style={srOnly}>Dividends and interest by month</caption>
          <thead>
            <tr>
              <th scope="col" style={showTable ? { ...TH, textAlign: 'left', padding: '0 0 6px', borderBottom: '1px solid var(--border)' } : undefined}>Month</th>
              {kinds.map(k => <th key={k.key} scope="col" style={showTable ? { ...TH, ...NUM, padding: '0 0 6px 12px', borderBottom: '1px solid var(--border)' } : undefined}>{k.label}</th>)}
              <th scope="col" style={showTable ? { ...TH, ...NUM, padding: '0 0 6px 12px', borderBottom: '1px solid var(--border)' } : undefined}>Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.month}>
                <th scope="row" style={showTable ? { textAlign: 'left', fontWeight: 400, padding: '5px 0', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' } : undefined}>{r.label}</th>
                {kinds.map(k => <td key={k.key} style={showTable ? { ...cell, color: r[k.key] ? 'var(--text)' : 'var(--muted)' } : undefined}>{money(r[k.key])}</td>)}
                <td style={showTable ? { ...cell, fontWeight: 600 } : undefined}>{money(r.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
