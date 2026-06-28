import { useMemo, useState } from 'react';
import { ComposedChart, Bar, Cell, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { useApi } from '../hooks/useApi.ts';
import MerchantIcon from './MerchantIcon.tsx';
import { openTxnDetail } from './TransactionDetail.tsx';
import CategoryPicker, { type PickerGroup } from './CategoryPicker.tsx';

// Inline category editing — wired through from the Budget page, identical to the
// Transactions and Sankey tabs. Optional so the chart still renders read-only if
// the handlers aren't supplied.
interface EditProps {
  cats?: string[];
  groups?: PickerGroup[];
  onRecategorize?: (merchant: string, category: string, ctx?: { payee: string; description: string; amount: number }) => void;
  onCreateCategory?: (merchant: string, name: string) => void;
}

interface Projection {
  months: { month: string; spending: number; income: number }[];
  avgMonthlySpending: number;
  avgMonthlyIncome: number;
}
interface Txn {
  id: string; date: string; amount: number; payee: string; merchant: string; category: string;
  account: string; description: string; memo: string; postedAt: number; transactedAt: number | null; suggested: string;
}

// Income (green, up) vs spending (red, down) per month, with a net cash-flow line
// threading through, a divider at each year boundary, and a faded/dashed forecast
// for next month derived from the trailing averages. Page back with ← / →. Click a
// month to list its transactions below (defaults to the most recent month).
const GREEN = '#4ade80', RED = '#f87171', NET = '#e8eaf0', MUTED = '#7b7f95';
const WINDOW = 10;        // historical months shown at once
const STEP = 6;           // months paged per arrow click

const ymLabel = (ym: string) => new Date(ym + '-01T00:00:00').toLocaleString('en-US', { month: 'short' });
const ymLong = (ym: string) => new Date(ym + '-01T00:00:00').toLocaleString('en-US', { month: 'long', year: 'numeric' });
const shortDate = (d: string) => { const [, m, day] = d.split('-'); return `${+m}/${+day}`; };
function nextMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7); // m (1-based) = next month's JS index
}

export default function CashFlowTrend({ privacy, version = 0, cats, groups, onRecategorize, onCreateCategory }: { privacy: boolean; version?: number } & EditProps) {
  const { data, loading, error } = useApi<Projection>('/api/budget/projection', [version]);
  const [offset, setOffset] = useState(0); // months back from the most recent
  const [selMonth, setSelMonth] = useState(''); // '' → default to most recent
  const moneyK = (n: number) => (privacy ? '•••' : (n < 0 ? '-$' : '$') + (Math.abs(n) >= 1000 ? (Math.abs(n) / 1000).toFixed(Math.abs(n) >= 10000 ? 0 : 1) + 'k' : Math.round(Math.abs(n))));
  const money = (n: number) => (privacy ? '••••' : (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString());

  const view = useMemo(() => {
    const months = data?.months ?? [];
    if (!months.length) return { rows: [] as Record<string, number | string | null>[], boundaries: [] as { x: string; year: string }[], atLatest: true, forecastMonth: '' };
    const total = months.length;
    const endActual = total - offset;
    const startActual = Math.max(0, endActual - WINDOW);
    const windowMonths = months.slice(startActual, endActual);
    const atLatest = offset === 0;
    // Forecast next month from trailing averages, only while viewing the latest window.
    const last = months[total - 1];
    const fc = atLatest ? { month: nextMonth(last.month), income: data!.avgMonthlyIncome, spending: data!.avgMonthlySpending, forecast: true } : null;
    const pts = [...windowMonths.map(m => ({ ...m, forecast: false })), ...(fc ? [fc] : [])];

    const rows = pts.map((p, i) => {
      const isF = p.forecast;
      const net = p.income - p.spending;
      const lastActual = atLatest && fc && i === pts.length - 2; // actual just before the forecast
      return {
        month: p.month,
        income: isF ? null : Math.round(p.income),
        spending: isF ? null : -Math.round(p.spending),
        net: isF ? null : Math.round(net),
        incomeF: isF ? Math.round(p.income) : null,
        spendingF: isF ? -Math.round(p.spending) : null,
        netF: isF || lastActual ? Math.round(net) : null,
      };
    });
    const boundaries: { x: string; year: string }[] = [];
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].month.slice(0, 4) !== pts[i - 1].month.slice(0, 4)) boundaries.push({ x: pts[i].month, year: pts[i].month.slice(0, 4) });
    }
    return { rows, boundaries, atLatest, forecastMonth: fc?.month ?? '' };
  }, [data, offset]);

  const months = data?.months ?? [];
  const total = months.length;
  const canLeft = offset < total - WINDOW;
  const canRight = offset > 0;
  // Selected month for the transaction list — defaults to the most recent month.
  const effMonth = selMonth || (months.length ? months[total - 1].month : '');

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 20, marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 8 }}>
        <div>
          <h2 style={{ fontSize: 15, fontWeight: 600 }}>Monthly cash flow</h2>
          <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 2 }}>
            Income vs. spending each month, with net flow and a forecast for next month. Click a month to list its transactions below.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: 11, color: 'var(--muted)' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: GREEN }} /> Income</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: RED }} /> Spending</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 14, height: 2, background: NET }} /> Net</span>
        </div>
      </div>

      {loading && <div style={{ height: 280, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }}>Loading…</div>}
      {error && <p style={{ color: 'var(--red)', fontSize: 13 }}>Failed to load: {error}</p>}
      {data && view.rows.length === 0 && <p style={{ color: 'var(--muted)', fontSize: 13, padding: '20px 0' }}>Not enough history yet.</p>}

      {data && view.rows.length > 0 && (
        <div style={{ position: 'relative' }}>
          {/* Page back / forward through history */}
          <button onClick={() => setOffset(o => Math.min(total - WINDOW, o + STEP))} disabled={!canLeft}
            title="Earlier months" aria-label="Earlier months"
            style={{ position: 'absolute', left: -6, top: '50%', transform: 'translateY(-50%)', zIndex: 5, width: 30, height: 30, borderRadius: '50%', background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)', cursor: canLeft ? 'pointer' : 'default', opacity: canLeft ? 1 : 0.25 }}>←</button>
          <button onClick={() => setOffset(o => Math.max(0, o - STEP))} disabled={!canRight}
            title="Later months" aria-label="Later months"
            style={{ position: 'absolute', right: -6, top: '50%', transform: 'translateY(-50%)', zIndex: 5, width: 30, height: 30, borderRadius: '50%', background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)', cursor: canRight ? 'pointer' : 'default', opacity: canRight ? 1 : 0.25 }}>→</button>

          <div style={{ width: '100%', height: 300, filter: privacy ? 'blur(7px)' : 'none', cursor: 'pointer' }}>
            <ResponsiveContainer>
              <ComposedChart data={view.rows} margin={{ top: 24, right: 26, left: 6, bottom: 0 }} stackOffset="sign"
                onClick={s => { const ym = s?.activeLabel as string | undefined; if (ym && ym !== view.forecastMonth) setSelMonth(ym); }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#2a2d3a" vertical={false} />
                <XAxis dataKey="month" tickFormatter={ymLabel} tick={{ fill: MUTED, fontSize: 12 }} tickLine={false} axisLine={false} interval={0} />
                <YAxis tickFormatter={moneyK} tick={{ fill: MUTED, fontSize: 11 }} tickLine={false} axisLine={false} width={48} />
                <Tooltip contentStyle={{ background: '#1a1d27', border: '1px solid #2a2d3a', borderRadius: 8 }}
                  labelFormatter={(ym: string) => ymLong(ym)}
                  formatter={(v: number, n: string) => {
                    const label = n === 'income' || n === 'incomeF' ? 'Income' : n === 'spending' || n === 'spendingF' ? 'Spending' : 'Net';
                    return [money(Math.abs(v)) + (n.endsWith('F') ? ' (forecast)' : ''), label];
                  }} />
                <ReferenceLine y={0} stroke="#3a3d4a" />
                {view.boundaries.map(b => (
                  <ReferenceLine key={b.x} x={b.x} stroke={MUTED} strokeOpacity={0.5}
                    label={{ value: b.year + ' →', position: 'insideTopRight', fill: MUTED, fontSize: 11 }} />
                ))}
                {/* Actual months — selected month highlighted brighter */}
                <Bar dataKey="income" stackId="a" fill={GREEN} radius={[3, 3, 0, 0]} maxBarSize={46} isAnimationActive={false}>
                  {view.rows.map(r => <Cell key={String(r.month)} fillOpacity={r.month === effMonth ? 0.9 : 0.4} />)}
                </Bar>
                <Bar dataKey="spending" stackId="a" fill={RED} radius={[0, 0, 3, 3]} maxBarSize={46} isAnimationActive={false}>
                  {view.rows.map(r => <Cell key={String(r.month)} fillOpacity={r.month === effMonth ? 0.9 : 0.4} />)}
                </Bar>
                {/* Forecast month (faded) */}
                <Bar dataKey="incomeF" stackId="a" fill={GREEN} fillOpacity={0.9} radius={[3, 3, 0, 0]} maxBarSize={46} isAnimationActive={false} />
                <Bar dataKey="spendingF" stackId="a" fill={RED} fillOpacity={0.9} radius={[0, 0, 3, 3]} maxBarSize={46} isAnimationActive={false} />
                {/* Net line, plus a dashed segment into the forecast */}
                <Line dataKey="net" stroke={NET} strokeWidth={2.5} dot={false} connectNulls={false} isAnimationActive={false} />
                <Line dataKey="netF" stroke={NET} strokeWidth={2.5} strokeDasharray="5 4" dot={false} connectNulls isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {effMonth && <MonthTransactions month={effMonth} privacy={privacy} version={version} money={money}
            cats={cats} groups={groups} onRecategorize={onRecategorize} onCreateCategory={onCreateCategory} />}
        </div>
      )}
    </div>
  );
}

// The clicked month's transactions, listed below the chart. The category is an
// inline editable picker (when edit handlers are supplied), matching the
// Transactions and Sankey tabs; click elsewhere on a row for full detail. Fetches
// its own slice so it stays in sync with the selection.
function MonthTransactions({ month, privacy, version, money, cats, groups, onRecategorize, onCreateCategory }: {
  month: string; privacy: boolean; version: number; money: (n: number) => string;
} & EditProps) {
  const { data, loading } = useApi<{ transactions: Txn[] }>(`/api/budget/transactions?range=${month}`, [month, version]);
  const txns = data?.transactions ?? [];
  const inflow = txns.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const outflow = txns.filter(t => t.amount < 0).reduce((s, t) => s - t.amount, 0);
  const editable = !!(onRecategorize && cats);

  return (
    <div style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
        <h3 style={{ fontSize: 14, fontWeight: 600 }}>
          {ymLong(month)} transactions
          <span style={{ color: 'var(--muted)', fontWeight: 400 }}> · {loading ? '…' : `${txns.length}`}</span>
        </h3>
        <span style={{ color: 'var(--muted)', fontSize: 12 }}>In {money(inflow)} · Out {money(outflow)}</span>
      </div>
      {!loading && txns.length === 0 && <p style={{ color: 'var(--muted)', fontSize: 13, padding: '6px 0' }}>No transactions this month.</p>}
      {txns.length > 0 && (
        <div style={{ maxHeight: 420, overflowY: 'auto' }}>
          {txns.map(t => (
            <div key={t.id} title="Click for details"
              onClick={() => openTxnDetail({ payee: t.payee, merchant: t.merchant, amount: t.amount, category: t.category, account: t.account, date: t.date, postedAt: t.postedAt, transactedAt: t.transactedAt, description: t.description, memo: t.memo, suggested: t.suggested })}
              style={{ display: 'grid', gridTemplateColumns: '54px 1fr 150px 92px', gap: 8, alignItems: 'center', fontSize: 13, padding: '6px 0', borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
              <span style={{ color: 'var(--muted)', fontSize: 12 }}>{shortDate(t.date)}</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <MerchantIcon merchant={t.merchant} label={t.payee} size={22} />
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.payee}</span>
                  {t.description && t.description.toLowerCase() !== t.payee.toLowerCase() && (
                    <span style={{ display: 'block', fontSize: 10, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'ui-monospace, SFMono-Regular, monospace' }} title={t.description}>{t.description}</span>
                  )}
                </span>
              </span>
              {editable ? (
                <span onClick={e => e.stopPropagation()}>
                  <CategoryPicker value={t.category} options={cats!} groups={groups} suggested={t.suggested} compact
                    onChange={c => onRecategorize!(t.merchant, c, { payee: t.payee, description: t.description, amount: t.amount })}
                    onCreate={onCreateCategory ? n => onCreateCategory(t.merchant, n) : undefined} />
                </span>
              ) : (
                <span style={{ color: 'var(--muted)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.category}</span>
              )}
              <span style={{ textAlign: 'right', color: t.amount > 0 ? 'var(--green)' : 'var(--text)' }}>{money(t.amount)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
