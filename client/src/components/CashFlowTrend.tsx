import { useEffect, useMemo, useState } from 'react';
import { ComposedChart, Bar, Cell, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { useApi } from '../hooks/useApi.ts';
import { useIsMobile } from '../hooks/useIsMobile.ts';
import MerchantIcon from './MerchantIcon.tsx';
import { openTxnDetail } from './TransactionDetail.tsx';
import CategoryPicker, { type PickerGroup } from './CategoryPicker.tsx';
import { fmtMoney, fmtMoneyCompact } from '../lib/format.ts';
import { fmtTxnDate, rowProps } from '../lib/budgetUi.ts';
import { inOutMortgage, needsCategory } from '../lib/budgetView.ts';

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
  months: { month: string; spending: number; income: number; mortgage?: number }[];
  monthsAnalyzed: number;   // how many complete months the averages (and the forecast) use
  avgMonthlySpending: number;
  avgMonthlyIncome: number;
}
interface Txn {
  id: string; date: string; amount: number; payee: string; merchant: string; category: string;
  account: string; description: string; memo: string; postedAt: number; transactedAt: number | null; suggested: string;
  amountEdited?: boolean;
}

// Income (green, up) vs spending (red, down) per month, with a net cash-flow line
// threading through, a divider at each year boundary, and a faded, dashed-outline
// forecast for next month derived from the trailing averages. The in-progress month
// is hatched and labelled "(to date)" so a partial month doesn't read as a complete
// one. Page back with ← / →. Click a month to list its transactions below (defaults
// to the most recent month). Spending here excludes mortgage payments; the
// tooltip and the month's list show the mortgage as its own figure. On the
// Budget page the selected month IS the page's month picker: `month` comes in
// from the header and clicking a bar sets it (via onSelectMonth).
const GREEN = 'var(--green)', RED = 'var(--red)', NET = 'var(--text)', MUTED = 'var(--muted)';
const WINDOW = 10;        // historical months shown at once
const STEP = 6;           // months paged per arrow click

const ymLabel = (ym: string) => new Date(ym + '-01T00:00:00').toLocaleString('en-US', { month: 'short' });
const ymLong = (ym: string) => new Date(ym + '-01T00:00:00').toLocaleString('en-US', { month: 'long', year: 'numeric' });
function nextMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7); // m (1-based) = next month's JS index
}

export default function CashFlowTrend({ privacy, version = 0, cats, groups, onRecategorize, onCreateCategory, month, onSelectMonth }: {
  privacy: boolean; version?: number;
  month?: string;                       // the selected month, when the parent owns it
  onSelectMonth?: (ym: string) => void; // clicking a bar picks that month
} & EditProps) {
  const { data, loading, error } = useApi<Projection>('/api/budget/projection', [version]);
  // A phone can't fit every month's label; show every other one there.
  const isMobile = useIsMobile();
  const [offset, setOffset] = useState(0); // months back from the most recent
  const [ownMonth, setOwnMonth] = useState(''); // '' → default to most recent (when no parent month)
  const selMonth = month ?? ownMonth;
  const setSelMonth = onSelectMonth ?? setOwnMonth;
  const moneyK = (n: number) => (privacy ? '•••' : fmtMoneyCompact(n));
  const money = (n: number) => (privacy ? '••••' : fmtMoney(n));
  const moneyCents = (n: number) => (privacy ? '••••' : fmtMoney(n, { cents: true }));
  const thisMonth = new Date().toISOString().slice(0, 7); // the in-progress month (server uses UTC too)

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
    // The forecast's mortgage is the average over the same complete months the
    // spending/income averages use, so its net line nets the mortgage out too.
    const avgWindow = months.filter(m => m.month < thisMonth).slice(-(data!.monthsAnalyzed || 0));
    const avgMortgage = avgWindow.length ? avgWindow.reduce((s, m) => s + (m.mortgage ?? 0), 0) / avgWindow.length : 0;
    const fc = atLatest ? { month: nextMonth(last.month), income: data!.avgMonthlyIncome, spending: data!.avgMonthlySpending, mortgage: avgMortgage, forecast: true } : null;
    const pts = [...windowMonths.map(m => ({ ...m, forecast: false })), ...(fc ? [fc] : [])];

    const rows = pts.map((p, i) => {
      const isF = p.forecast;
      // Net after the mortgage, matching the Overview's "Net" and the flow view's "Saved".
      const net = p.income - p.spending - (p.mortgage ?? 0);
      const lastActual = atLatest && fc && i === pts.length - 2; // actual just before the forecast
      return {
        month: p.month,
        income: isF ? null : Math.round(p.income),
        spending: isF ? null : -Math.round(p.spending),
        net: isF ? null : Math.round(net),
        mortgage: Math.round(p.mortgage ?? 0),
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
  // Keep the selected month in view: when it's picked elsewhere (the page's month
  // picker) and sits outside the current window, page to the window ending on it.
  useEffect(() => {
    if (!selMonth || !data) return;
    const i = data.months.findIndex(m => m.month === selMonth);
    if (i < 0) return;
    const n = data.months.length;
    setOffset(o => {
      const end = n - o, startI = Math.max(0, end - WINDOW);
      if (i >= startI && i < end) return o;
      return Math.max(0, Math.min(n - WINDOW, n - 1 - i));
    });
  }, [selMonth, data]);
  const canLeft = offset < total - WINDOW;
  const canRight = offset > 0;
  // Selected month for the transaction list — defaults to the most recent month.
  const effMonth = (selMonth && months.some(m => m.month === selMonth)) ? selMonth : (months.length ? months[total - 1].month : '');

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 20, marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 240px', minWidth: 0 }}>
          <h2 style={{ fontSize: 15, fontWeight: 600 }}>Monthly cash flow</h2>
          <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 2 }}>
            Spending excludes mortgage payments; net is after them.
            {data && data.monthsAnalyzed > 0 && <> The forecast is the average of the last {data.monthsAnalyzed} complete month{data.monthsAnalyzed === 1 ? '' : 's'}.</>}
            {' '}Click a month to pick it and see its transactions.
          </p>
        </div>
        {/* May shrink so the items wrap: fixed-width, it pushed the page sideways on a phone. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px 14px', fontSize: 11, color: 'var(--muted)', flex: '0 1 auto', minWidth: 0, flexWrap: 'wrap' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}><span style={{ width: 10, height: 10, borderRadius: 2, background: GREEN }} /> Income</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}><span style={{ width: 10, height: 10, borderRadius: 2, background: RED }} /> Spending</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}><span style={{ width: 14, height: 2, background: NET }} /> Net, after mortgage</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}><span style={{ width: 10, height: 10, borderRadius: 2, border: `1px dashed ${MUTED}`, background: `repeating-linear-gradient(45deg, color-mix(in srgb, ${MUTED} 40%, transparent) 0 2px, transparent 2px 5px)` }} /> Month to date</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}><span style={{ width: 10, height: 10, borderRadius: 2, border: `1px dashed ${MUTED}`, background: `color-mix(in srgb, ${MUTED} 20%, transparent)` }} /> Forecast</span>
        </div>
      </div>

      {loading && <div style={{ height: 280, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }}>Loading…</div>}
      {error && <p style={{ color: 'var(--red)', fontSize: 13 }}>Failed to load: {error}</p>}
      {data && view.rows.length === 0 && <p style={{ color: 'var(--muted)', fontSize: 13, padding: '20px 0' }}>Not enough history yet.</p>}

      {data && view.rows.length > 0 && (
        <div>
          {/* Page back / forward through history — anchored to the chart only, not the
              transaction list below it, so the arrows sit beside the bars. */}
          <div style={{ position: 'relative' }}>
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
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <defs>
                  {[['g', GREEN], ['r', RED]].map(([k, c]) => (
                    <pattern key={k} id={`cf-hatch-${k}`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                      <rect width="6" height="6" fill={c} fillOpacity={0.12} />
                      <line x1="0" y1="0" x2="0" y2="6" stroke={c} strokeWidth="2.5" strokeOpacity={0.55} />
                    </pattern>
                  ))}
                </defs>
                <XAxis dataKey="month" height={40} interval={isMobile ? 1 : 0} tickLine={false} axisLine={false}
                  tick={(p: { x: number; y: number; payload: { value: string } }) => {
                    const ym = p.payload.value;
                    const note = ym === thisMonth ? '(to date)' : ym === view.forecastMonth ? '(forecast)' : '';
                    return (
                      <text x={p.x} y={p.y + 12} textAnchor="middle" fill={MUTED} fontSize={12}>
                        <tspan x={p.x}>{ymLabel(ym)}</tspan>
                        {note && <tspan x={p.x} dy={13} fontSize={10}>{note}</tspan>}
                      </text>
                    );
                  }} />
                <YAxis tickFormatter={moneyK} tick={{ fill: MUTED, fontSize: 11 }} tickLine={false} axisLine={false} width={48} />
                <Tooltip contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8 }}
                  labelFormatter={(ym: string) => ymLong(ym) + (ym === thisMonth ? ' (month to date)' : ym === view.forecastMonth ? ' (forecast)' : '')}
                  formatter={(v: number, n: string, item: { payload?: { month?: string } }) => {
                    const isNet = n === 'net' || n === 'netF';
                    // The dashed forecast line starts on the last actual month so the
                    // two lines join; there it only repeats that month's real net.
                    if (n === 'netF' && item?.payload?.month !== view.forecastMonth) return [null, null] as unknown as [string, string];
                    if (n === 'mortgage') return [money(v) + ' (not in spending)', 'Mortgage'];
                    const label = n === 'income' || n === 'incomeF' ? 'Income' : n === 'spending' || n === 'spendingF' ? 'Spending' : 'Net after mortgage';
                    // Spending is plotted below zero, so show its size; net keeps its sign (a deficit reads as −$).
                    return [(isNet ? (privacy ? '••••' : fmtMoney(v, { sign: true })) : money(Math.abs(v))) + (n.endsWith('F') ? ' (forecast)' : ''), label];
                  }} />
                <ReferenceLine y={0} stroke="#3a3d4a" />
                {view.boundaries.map(b => (
                  <ReferenceLine key={b.x} x={b.x} stroke={MUTED} strokeOpacity={0.5}
                    label={{ value: b.year + ' →', position: 'insideTopRight', fill: MUTED, fontSize: 11 }} />
                ))}
                {/* Actual months — selected month highlighted brighter */}
                {/* The in-progress month is hatched with a dashed outline so it can't pass for a complete one. */}
                <Bar dataKey="income" stackId="a" fill={GREEN} radius={[3, 3, 0, 0]} maxBarSize={46} isAnimationActive={false}>
                  {view.rows.map(r => r.month === thisMonth
                    ? <Cell key={String(r.month)} fill="url(#cf-hatch-g)" stroke={GREEN} strokeDasharray="4 3" strokeOpacity={r.month === effMonth ? 1 : 0.6} />
                    : <Cell key={String(r.month)} fillOpacity={r.month === effMonth ? 0.9 : 0.4} />)}
                </Bar>
                <Bar dataKey="spending" stackId="a" fill={RED} radius={[0, 0, 3, 3]} maxBarSize={46} isAnimationActive={false}>
                  {view.rows.map(r => r.month === thisMonth
                    ? <Cell key={String(r.month)} fill="url(#cf-hatch-r)" stroke={RED} strokeDasharray="4 3" strokeOpacity={r.month === effMonth ? 1 : 0.6} />
                    : <Cell key={String(r.month)} fillOpacity={r.month === effMonth ? 0.9 : 0.4} />)}
                </Bar>
                {/* Forecast month: faded fill with a dashed outline */}
                <Bar dataKey="incomeF" stackId="a" fill={GREEN} fillOpacity={0.3} stroke={GREEN} strokeDasharray="4 3" radius={[3, 3, 0, 0]} maxBarSize={46} isAnimationActive={false} />
                <Bar dataKey="spendingF" stackId="a" fill={RED} fillOpacity={0.3} stroke={RED} strokeDasharray="4 3" radius={[0, 0, 3, 3]} maxBarSize={46} isAnimationActive={false} />
                {/* Net line, plus a dashed segment into the forecast */}
                {/* Not drawn: carries the month's mortgage into the tooltip, beside spending. */}
                <Line dataKey="mortgage" stroke={MUTED} strokeWidth={0} strokeOpacity={0} dot={false} activeDot={false} legendType="none" isAnimationActive={false} />
                <Line dataKey="net" stroke={NET} strokeWidth={2.5} dot={false} connectNulls={false} isAnimationActive={false} />
                <Line dataKey="netF" stroke={NET} strokeWidth={2.5} strokeDasharray="5 4" dot={false} connectNulls isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          </div>

          {effMonth && <MonthTransactions month={effMonth} privacy={privacy} version={version} money={money} moneyCents={moneyCents} partial={effMonth === thisMonth}
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
function MonthTransactions({ month, privacy, version, money, moneyCents, partial, cats, groups, onRecategorize, onCreateCategory }: {
  month: string; privacy: boolean; version: number; money: (n: number) => string; moneyCents: (n: number) => string; partial: boolean;
} & EditProps) {
  const { data, loading } = useApi<{ transactions: Txn[] }>(`/api/budget/transactions?range=${month}`, [month, version]);
  const txns = data?.transactions ?? [];
  // Same definition as the chart above: Mortgage payments are listed but counted on their own, not in Out.
  const { inflow, outflow, mortgage: mortgageOut } = inOutMortgage(txns);
  const editable = !!(onRecategorize && cats);

  return (
    <div style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
        <h3 style={{ fontSize: 14, fontWeight: 600 }}>
          {ymLong(month)}{partial ? ' (to date)' : ''} transactions
          <span style={{ color: 'var(--muted)', fontWeight: 400 }}> · {loading ? '…' : `${txns.length}`}</span>
        </h3>
        <span style={{ color: 'var(--muted)', fontSize: 12 }}>In {money(inflow)} · Out {money(outflow)}{mortgageOut > 0 && ` · Mortgage ${money(mortgageOut)}`}</span>
      </div>
      {!loading && txns.length === 0 && <p style={{ color: 'var(--muted)', fontSize: 13, padding: '6px 0' }}>No transactions this month.</p>}
      {txns.length > 0 && (
        <div className="scroll-x"><div className="tbl-scroll" style={{ ['--tbl-min']: '560px', maxHeight: 420, overflowY: 'auto' } as React.CSSProperties}>
          {txns.map(t => (
            <div key={t.id} title="Click for details"
              {...rowProps(() => openTxnDetail({ id: t.id, amountEdited: t.amountEdited, payee: t.payee, merchant: t.merchant, amount: t.amount, category: t.category, account: t.account, date: t.date, postedAt: t.postedAt, transactedAt: t.transactedAt, description: t.description, memo: t.memo, suggested: t.suggested }))}
              style={{ display: 'grid', gridTemplateColumns: '84px 1fr 150px 92px', gap: 8, alignItems: 'center', fontSize: 13, padding: '6px 0', borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
              <span style={{ color: 'var(--muted)', fontSize: 12, whiteSpace: 'nowrap' }}>{fmtTxnDate(t.date)}</span>
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
                  <CategoryPicker chip value={needsCategory(t) ? '' : t.category} options={cats!} groups={groups} suggested={t.suggested} applyHint={`Applies to every ${t.payee} transaction`}
                    onChange={c => onRecategorize!(t.merchant, c, { payee: t.payee, description: t.description, amount: t.amount })}
                    onCreate={onCreateCategory ? n => onCreateCategory(t.merchant, n) : undefined} />
                </span>
              ) : (
                <span style={{ color: 'var(--muted)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.category}</span>
              )}
              <span style={{ textAlign: 'right', color: t.amount > 0 ? 'var(--green)' : 'var(--text)' }}>{moneyCents(t.amount)}</span>
            </div>
          ))}
        </div></div>
      )}
    </div>
  );
}
