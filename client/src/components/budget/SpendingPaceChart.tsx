import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, ReferenceLine } from 'recharts';
import { fmtMoney, fmtMoneyCompact } from '../../lib/format.ts';
import { monthPace, paceSeries } from '../../lib/budgetPace.ts';
import type { BudgetData, Money } from './types.ts';
import type { PeriodLabels } from './BudgetKpis.tsx';

// Cumulative spending through the month, against last month and, when a total
// budget is set, a dotted "budget pace" line rising evenly from $0 to the budget
// on the last day. Mid-month a "today" marker and a one-line callout say how far
// under or over that even pace you are and where the month ends at this rate.
export default function SpendingPaceChart({ data, lbl, money, privacy }: {
  data: BudgetData; lbl: PeriodLabels; money: Money; privacy: boolean;
}) {
  const budget = data.totalBudget;
  const p = monthPace(data.spending, budget, data.asOfDay, data.daysInMonth);
  const pace = budget > 0 ? paceSeries(budget, data.daysInMonth) : [];
  const rows = data.dailyCumulative.map((r, i) => ({ ...r, pace: pace[i]?.pace ?? null }));
  const monthName = lbl.curName.split(' ')[0];

  let callout: React.ReactNode = null;
  if (budget > 0 && p.inProgress && p.vsPace != null && p.projectedVsBudget != null) {
    const under = p.vsPace >= 0;
    const endsUnder = p.projectedVsBudget >= 0;
    callout = (
      <>
        You're <b style={{ color: under ? 'var(--green)' : 'var(--red)' }}>{money(Math.abs(p.vsPace))} {under ? 'under' : 'over'}</b> an even pace.
        {' '}At this rate {monthName} ends near <b>{money(p.projected!)}</b>, about {money(Math.abs(p.projectedVsBudget))} {endsUnder ? 'under' : 'over'} budget.
      </>
    );
  } else if (budget > 0 && p.left != null) {
    callout = (
      <>
        {monthName} ended <b style={{ color: p.left >= 0 ? 'var(--green)' : 'var(--red)' }}>{money(Math.abs(p.left))} {p.left >= 0 ? 'under' : 'over'}</b> the {money(budget)} budget.
      </>
    );
  }

  return (
    <div className="db-card" style={{ marginBottom: 20 }}>
      <div className="db-head" style={{ marginBottom: 12 }}>
        <h2>{p.inProgress ? 'Spending so far' : 'Spending through the month'} · {lbl.curName} vs {lbl.prevName}</h2>
        {budget > 0 && <span className="db-sub">Budget {money(budget)}</span>}
      </div>
      <div style={{ width: '100%', height: 220, filter: privacy ? 'blur(8px)' : 'none' }}>
        <ResponsiveContainer>
          <LineChart data={rows} margin={{ top: 14, right: 14, left: 6, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="day" tick={{ fill: 'var(--muted)', fontSize: 11 }} tickLine={false} axisLine={false} />
            {/* The blur alone leaves the tick text in the page (readable by
                assistive tech, copyable), so privacy mode blanks the amounts. */}
            <YAxis tick={{ fill: 'var(--muted)', fontSize: 11 }} tickLine={false} axisLine={false}
              tickFormatter={v => (privacy ? '' : fmtMoneyCompact(v))} width={privacy ? 8 : 44} />
            <Tooltip contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8 }}
              labelFormatter={d => `Day ${d}`} formatter={(v: number) => (privacy ? '••••' : fmtMoney(v))} />
            <Legend wrapperStyle={{ fontSize: 12, color: 'var(--muted)' }} />
            {p.inProgress && (
              <ReferenceLine x={data.asOfDay!} stroke="var(--muted)" strokeDasharray="2 3"
                label={{ value: 'today', position: 'insideTopLeft', fill: 'var(--muted)', fontSize: 11 }} />
            )}
            <Line type="monotone" dataKey="prior" name={lbl.prevName} stroke="var(--muted)" strokeWidth={2} strokeDasharray="5 4" dot={false} connectNulls isAnimationActive={false} />
            {budget > 0 && (
              <Line type="linear" dataKey="pace" name="Budget pace" stroke="var(--accent)" strokeWidth={2} strokeDasharray="1 4" strokeLinecap="round" dot={false} isAnimationActive={false} />
            )}
            <Line type="monotone" dataKey="current" name={lbl.curName} stroke="var(--spend)" strokeWidth={2.5} dot={false} connectNulls isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      {callout && <p className="bud-callout">{callout}</p>}
    </div>
  );
}
