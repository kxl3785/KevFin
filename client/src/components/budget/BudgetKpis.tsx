import { rowProps } from '../../lib/budgetUi.ts';
import { monthPace, barColor } from '../../lib/budgetPace.ts';
import { monthLong } from '../../lib/budgetView.ts';
import type { BudgetData, Money } from './types.ts';

export type CompareMode = 'priorMonth' | 'priorYearAvg';
export interface PeriodLabels { spent: string; prevLabel: string; yearLabel: string; curName: string; prevName: string }

// The Overview's five headline tiles:
//   Spent          — the month's spending (mortgage left out), its share of the
//                    total budget and, mid-month, a bar with a tick at how far
//                    through the month it is.
//   Left to spend  — total budget − spent, spread per day over the days left.
//   Income         — the month's income-category deposits.
//   Net            — income − spending − mortgage payments.
//   Comparison     — spending vs the prior month or the same month in prior years.
// Each tile opens that period's transactions.
export default function BudgetKpis({ data, lbl, money, incomeCats, compareMode, setCompareMode, onViewMonth, onSetBudgets }: {
  data: BudgetData; lbl: PeriodLabels; money: Money; incomeCats: Set<string>;
  compareMode: CompareMode; setCompareMode: (m: CompareMode) => void;
  onViewMonth: (ym: string) => void; onSetBudgets: () => void;
}) {
  const p = monthPace(data.spending, data.totalBudget, data.asOfDay, data.daysInMonth);
  // Privacy mode masks the figures; green/red and a sign would still say which way they went.
  const hidden = money(1).includes('•');
  const live = p.inProgress;
  const net = data.income - data.spending - data.mortgage;
  const deposits = data.transactions.filter(t => t.amount > 0 && incomeCats.has(t.category)).length;
  const compVal = compareMode === 'priorMonth' ? data.comparison.priorMonth : data.comparison.priorYearAvg;
  const delta = compVal ? (data.spending - compVal) / compVal : null;
  const compLabel = compareMode === 'priorMonth' ? lbl.prevLabel : lbl.yearLabel;
  const pct = (f: number) => `${Math.round(f * 100)}%`;
  const viewThis = () => onViewMonth(data.month);
  // The comparison tile opens the month it compares against: the prior month,
  // or the same month last year. When that month has no data there is nothing
  // to open, so the tile is plain (not a button) and says so.
  const [cy, cm] = data.month.split('-').map(Number);
  const compMonth = new Date(Date.UTC(cy, cm - 1 - (compareMode === 'priorMonth' ? 1 : 12), 1)).toISOString().slice(0, 7);
  const compOpens = data.months.includes(compMonth);
  const title = `View ${monthLong(data.month)} transactions`;

  return (
    <div className="bud-kpis">
      <div className="db-card bud-kpi" {...rowProps(viewThis)} title={title}>
        <span className="db-label">Spent · {lbl.spent}</span>
        <span className="db-figure-sm">{money(data.spending)}</span>
        {p.usedFrac != null && (
          <span className="bud-meter" aria-hidden="true">
            <i style={{ width: `${Math.min(100, p.usedFrac * 100)}%`, background: barColor(data.spending, data.totalBudget) }} />
            {live && <u style={{ left: `${p.dayFrac * 100}%` }} />}
          </span>
        )}
        <span className="bud-note">
          {p.usedFrac != null ? `${pct(p.usedFrac)} of budget` : 'No budget set'}
          {live && ` · ${pct(p.dayFrac)} of the month gone`}
        </span>
        {data.mortgage > 0 && <span className="bud-note">Mortgage of {money(data.mortgage)} not included</span>}
      </div>

      {p.left != null ? (
        <div className="db-card bud-kpi" {...rowProps(viewThis)} title={title}>
          <span className="db-label">{p.left < 0 ? 'Over budget' : live ? 'Left to spend' : 'Left over'}</span>
          <span className="db-figure-sm" style={{ color: p.left < 0 && !hidden ? 'var(--red)' : undefined }}>{money(Math.abs(p.left))}</span>
          <span className="bud-note">
            {p.perDay != null
              ? `${money(p.perDay)} a day for ${p.daysLeft} day${p.daysLeft === 1 ? '' : 's'}, today included`
              : p.left < 0 ? `Spent more than the ${money(data.totalBudget)} budget`
              : `Of the ${money(data.totalBudget)} budget`}
          </span>
        </div>
      ) : (
        <div className="db-card bud-kpi" {...rowProps(onSetBudgets)} title="Open a category below and give it a budget">
          <span className="db-label">Left to spend</span>
          <span className="db-figure-sm" style={{ color: 'var(--muted)' }}>—</span>
          <span className="bud-note" style={{ color: 'var(--accent)' }}>Set budgets on your categories to see what's left ▸</span>
        </div>
      )}

      <div className="db-card bud-kpi" {...rowProps(viewThis)} title={title}>
        <span className="db-label">Income{live ? ' so far' : ''}</span>
        <span className="db-figure-sm" style={{ color: data.income > 0 && !hidden ? 'var(--green)' : undefined }}>{money(data.income)}</span>
        <span className="bud-note">{deposits === 0 ? 'No deposits' : `${deposits} deposit${deposits === 1 ? '' : 's'}${live ? ' so far' : ''}`}</span>
      </div>

      <div className="db-card bud-kpi" {...rowProps(viewThis)} title={`${title}. Net is income minus spending minus mortgage payments.`}>
        <span className="db-label">Net {live ? 'so far' : 'this month'}</span>
        <span className="db-figure-sm" style={{ color: hidden ? undefined : net < 0 ? 'var(--red)' : 'var(--green)' }}>{hidden || net < 0 ? money(net) : `+${money(net)}`}</span>
        <span className="bud-note">{data.mortgage > 0 ? `After the ${money(data.mortgage)} mortgage` : 'Income minus spending'}</span>
      </div>

      <div className={`db-card bud-kpi${compOpens ? '' : ' bud-kpi-static'}`}
        {...(compOpens ? rowProps(() => onViewMonth(compMonth)) : {})}
        title={compOpens ? `View ${monthLong(compMonth)} transactions` : `No transactions in ${monthLong(compMonth)} to open`}>
        <select onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()} value={compareMode}
          onChange={e => setCompareMode(e.target.value as CompareMode)} aria-label="Comparison period" className="bud-kpi-select">
          <option value="priorMonth">vs {lbl.prevLabel}</option>
          <option value="priorYearAvg">vs {lbl.yearLabel}</option>
        </select>
        {delta != null ? (
          <span className="db-figure-sm" style={{ color: delta > 0 ? 'var(--red)' : 'var(--green)' }}
            title={`${lbl.spent} spending vs ${compLabel}`}>
            {Math.abs(delta * 100).toFixed(0)}% {delta > 0 ? 'more' : 'less'}
          </span>
        ) : <span className="db-figure-sm" style={{ color: 'var(--muted)' }}>—</span>}
        <span className="bud-note">{compVal != null ? `${money(compVal)} in ${compLabel}` : 'No prior data'}</span>
      </div>
    </div>
  );
}
