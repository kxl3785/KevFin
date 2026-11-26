import { useState, useEffect, forwardRef } from 'react';
import MerchantIcon from '../MerchantIcon.tsx';
import CategoryPicker, { type PickerGroup } from '../CategoryPicker.tsx';
import { openTxnDetail } from '../TransactionDetail.tsx';
import { fmtTxnDate, rowProps } from '../../lib/budgetUi.ts';
import { monthPace, categoryLeft, barColor, billState, type BillState } from '../../lib/budgetPace.ts';
import { needsCategory, monthlyTarget, categoryGroups, excludedCategoryNames, healCategoryPrefs, parseBudgetInput } from '../../lib/budgetView.ts';
import { txnToDetail, txnRowLabel, stop, type BudgetData, type BudgetTxn, type CatRow, type BillCategory, type Money, type Recategorize, type CreateCategory } from './types.ts';

const TOP_N = 10;
const monthName = (ym: string) => new Date(ym + '-01T00:00:00').toLocaleString('en-US', { month: 'short' });
const blankRow = (name: string): CatRow => ({ category: name, spent: 0, count: 0, target: 0 });

// The Overview's Categories card. The month's top categories by spend (minus any
// the user hid, plus any they added) split into two groups:
//   Flexible spending — read against a budget: what's left, a pace tick mid-month.
//   Bills             — categories fed mostly by recurring charges (see the
//                       server's util/bills.ts), read as paid / due.
// The mortgage stays as a greyed reference row at the end, never counted, never
// hideable and never offered under "Add category" (see categoryGroups).
const CategoryList = forwardRef<HTMLDivElement, {
  data: BudgetData; cats: string[]; groups: PickerGroup[]; money: Money; moneyCents: Money;
  hiddenCats: string[]; setHiddenCats: (f: (h: string[]) => string[]) => void;
  extraCats: string[]; setExtraCats: (f: (x: string[]) => string[]) => void;
  onRecategorize: Recategorize; onCreateCategory: CreateCategory;
  onSaveTarget: (c: string, n: number, period: 'monthly' | 'annual') => void;
  onManage: () => void;
}>(function CategoryList({ data, cats, groups, money, moneyCents, hiddenCats, setHiddenCats, extraCats, setExtraCats, onRecategorize, onCreateCategory, onSaveTarget, onManage }, ref) {
  const [openCat, setOpenCat] = useState<string | null>(null);
  const pace = monthPace(data.spending, data.totalBudget, data.asOfDay, data.daysInMonth);
  const bills = new Map((data.bills?.categories ?? []).map(b => [b.category, b]));

  // The rows to show, split into groups (lib/budgetView.ts: categoryGroups).
  const excludedNames = excludedCategoryNames(data.byCategory, groups);
  const g = categoryGroups({
    byCategory: data.byCategory, billNames: [...bills.keys()], hidden: hiddenCats, extra: extraCats,
    categories: cats, excludedNames, topN: TOP_N, blank: blankRow,
  });
  const { flexible, bills: billRows, excluded: excludedRows, insertable } = g;
  // Heal saved lists that name an excluded category: an older build let the
  // mortgage be hidden and then added back into Flexible spending, for good.
  // categoryGroups already ignores such names; this also drops them from the
  // saved prefs (functional updates, so they apply to the hydrated value), and
  // every hide/insert below cleans them too.
  const excludedKey = [...excludedNames].join('\n');
  const clean = (list: string[]) => list.filter(n => !excludedNames.has(n));
  useEffect(() => {
    if (!healCategoryPrefs(hiddenCats, extraCats, excludedNames)) return;
    setHiddenCats(clean);
    setExtraCats(clean);
  }, [hiddenCats, extraCats, excludedKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const hideCat = (name: string) => { setExtraCats(x => clean(x.filter(c => c !== name))); setHiddenCats(h => clean(h.includes(name) ? h : [...h, name])); };
  const insertCat = (name: string) => { setHiddenCats(h => clean(h.filter(c => c !== name))); setExtraCats(x => clean(x.includes(name) ? x : [...x, name])); };
  // Showing hidden ones again inserts them, so they appear even if they rank
  // below the top N.
  const showHidden = () => {
    const names = g.hidden.names;
    setHiddenCats(h => clean(h.filter(c => !names.includes(c))));
    setExtraCats(x => clean([...x, ...names.filter(n => !x.includes(n))]));
  };

  // A bill's expected amount is its usual recurring charge (its budget, if any,
  // is still checked separately for going over).
  const expectedOf = (c: CatRow) => bills.get(c.category)?.recurringMonthly || monthlyTarget(c);
  const { flexSpent, flexBudget } = g;
  const billSpent = billRows.reduce((s, c) => s + c.spent, 0);
  const billExpected = billRows.reduce((s, c) => s + expectedOf(c), 0);
  const billStates = billRows.map(c => billState(c.spent, expectedOf(c), pace.inProgress));
  const paidCount = billStates.filter(s => s === 'paid').length;

  const row = (c: CatRow, bill?: BillCategory) => (
    <CategoryRow key={c.category} cat={c} bill={bill} expected={bill ? expectedOf(c) : 0} open={openCat === c.category}
      onToggle={() => setOpenCat(o => (o === c.category ? null : c.category))}
      txns={data.transactions.filter(t => t.category === c.category)}
      cats={cats} groups={groups} money={money} moneyCents={moneyCents} month={data.month}
      paceTick={pace.inProgress ? pace.dayFrac : null} inProgress={pace.inProgress}
      onRecategorize={onRecategorize} onCreateCategory={onCreateCategory} onSaveTarget={onSaveTarget}
      onHide={c.excluded ? undefined : () => hideCat(c.category)} />
  );

  return (
    <div className="db-card" ref={ref} tabIndex={-1} style={{ outline: 'none' }}>
      <div className="db-head" style={{ marginBottom: 10 }}>
        <h2>Categories</h2>
        {pace.inProgress && data.totalBudget > 0 && <span className="db-sub" title="The tick on each monthly budget marks where an even pace would be today">Tick = an even pace today</span>}
      </div>
      {flexible.length === 0 && billRows.length === 0 && excludedRows.length === 0 && <p style={{ fontSize: 13, color: 'var(--muted)' }}>No categories to show. Add one below.</p>}

      {flexible.length > 0 && (
        <>
          <div className="bud-group-head">
            <span>{billRows.length ? 'Flexible spending' : 'Spending'}</span>
            <span>{money(flexSpent)}{flexBudget > 0 && <> of {money(flexBudget)}</>}</span>
          </div>
          {flexible.map(c => row(c))}
        </>
      )}

      {billRows.length > 0 && (
        <>
          <div className="bud-group-head" title={data.bills?.rule} style={{ marginTop: flexible.length ? 12 : 0 }}>
            <span>Bills <span aria-label={data.bills?.rule} style={{ cursor: 'help' }}>ⓘ</span></span>
            <span>{money(billSpent)} of ~{money(billExpected)} · {paidCount} of {billRows.length} paid</span>
          </div>
          {billRows.map(c => row(c, bills.get(c.category)))}
        </>
      )}

      {excludedRows.length > 0 && (
        <div style={{ marginTop: 12 }}>{excludedRows.map(c => row(c))}</div>
      )}

      {/* Say why the groups don't add up to the Spent tile: hidden categories
          (and those past the top N) still count toward Spent. */}
      {g.hidden.names.length > 0 && (
        <p className="bud-hidden-note">
          {g.hidden.names.length} hidden categor{g.hidden.names.length === 1 ? 'y' : 'ies'} · {money(g.hidden.spent)} not shown
          {' '}({g.hidden.names.join(', ')})
          {' '}<button type="button" className="bud-link" onClick={showHidden}>Show {g.hidden.names.length === 1 ? 'it' : 'them'}</button>
        </p>
      )}

      <div className="bud-cat-foot">
        {g.ranked > TOP_N && <span>Top {TOP_N} of {g.ranked} other categories by spend{g.rest.spent > 0.005 ? ` · ${money(g.rest.spent)} in the rest` : ''}.</span>}
        <button type="button" className="bud-link" onClick={onManage}>⚙ Manage categories</button>
      </div>
      {/* Insert a category to budget (hidden ones, or any with no spend yet). */}
      {insertable.length > 0 && (
        <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: 'var(--muted)', flexShrink: 0 }}>Add category:</span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <CategoryPicker value="" placeholder="Choose a category…" options={insertable} groups={groups} onChange={insertCat} />
          </span>
        </div>
      )}
    </div>
  );
});
export default CategoryList;

function BillLine({ state, spent, expected, money }: { state: BillState; spent: number; expected: number; money: Money }) {
  switch (state) {
    case 'paid': return <><span style={{ color: 'var(--green)', fontWeight: 600 }}>✓ Paid</span> {money(spent)}</>;
    case 'partial': return <>{money(spent)} <small>of ~{money(expected)}</small></>;
    case 'due': return <><span style={{ color: 'var(--muted)' }}>Due</span> ~{money(expected)}</>;
    default: return <span style={{ color: 'var(--muted)' }}>Not charged</span>;
  }
}

function CategoryRow({ cat, bill, expected, open, onToggle, txns, cats, groups, money, moneyCents, month, paceTick, inProgress, onRecategorize, onCreateCategory, onSaveTarget, onHide }: {
  cat: CatRow; bill?: BillCategory; expected: number; open: boolean; onToggle: () => void; txns: BudgetTxn[]; cats: string[]; groups: PickerGroup[];
  money: Money; moneyCents: Money; month: string; paceTick: number | null; inProgress: boolean;
  onRecategorize: Recategorize; onCreateCategory: CreateCategory; onSaveTarget: (c: string, n: number, period: 'monthly' | 'annual') => void;
  onHide?: () => void;
}) {
  const [targetDraft, setTargetDraft] = useState(String(cat.target || ''));
  const [period, setPeriod] = useState<'monthly' | 'annual'>(cat.period ?? 'monthly');
  const [targetErr, setTargetErr] = useState(false);
  // Blank input must not save (it used to send 0, which clears the target); type
  // 0 to clear one deliberately. Anything that isn't an amount ("abc30") says so
  // instead of saving whatever digits it contains.
  const commitTarget = () => {
    const r = parseBudgetInput(targetDraft);
    setTargetErr(r.kind === 'invalid');
    if (r.kind === 'amount') onSaveTarget(cat.category, r.value, period);
  };
  const isAnnual = cat.period === 'annual';
  // Annual budgets track year-to-date spend; monthly budgets track the month.
  const periodSpent = isAnnual ? (cat.ytdSpent ?? 0) : cat.spent;
  const excluded = !!cat.excluded;
  const left = categoryLeft(periodSpent, cat.target);
  const bState = bill ? billState(cat.spent, expected, inProgress) : null;
  const overBudget = bill && cat.target > 0 && !isAnnual && cat.spent > cat.target + 0.005;

  // Bar: a bill fills toward its expected amount; a budgeted category toward its
  // budget (capped at full); no budget shows a faint full-width track.
  const fill = excluded ? 1 : bill ? (expected > 0 ? Math.min(1, cat.spent / expected) : cat.spent > 0 ? 1 : 0)
    : cat.target > 0 ? Math.min(1, periodSpent / cat.target) : 1;
  const color = excluded ? 'var(--muted)' : bill ? (overBudget ? 'var(--red)' : bState === 'paid' ? 'var(--green)' : 'var(--accent)') : barColor(periodSpent, cat.target);
  const faint = excluded || (!bill && !cat.target);
  const tick = !bill && !excluded && !isAnnual && cat.target > 0 ? paceTick : null;
  const billTitle = bill && `Recurring here: ${bill.items.map(i => `${i.payee} ~${money(i.monthlyAvg)}/mo${i.annual ? ' (billed yearly)' : ''}`).join(', ')}`;

  return (
    <div style={{ marginBottom: 11, opacity: excluded ? 0.55 : 1 }} className="cat-row">
      <div {...rowProps(onToggle)} aria-expanded={open} style={{ cursor: 'pointer' }} title={billTitle || undefined}>
        <div className="bud-cat-line">
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            <span style={{ display: 'inline-block', width: 12, opacity: 0.6 }}>{open ? '▾' : '▸'}</span>
            {cat.category} <span style={{ color: 'var(--muted)', fontSize: 11 }}>({cat.count})</span>
            {isAnnual && <span className="bud-tag" style={{ color: 'var(--accent)', borderColor: 'var(--accent)' }}>annual</span>}
            {excluded && <span className="bud-tag">not in spending</span>}
          </span>
          <span className="bud-cat-val">
            <span>
            {excluded ? <>{money(cat.spent)} <small>paid, counted on its own</small></>
              : bill ? (
                <>
                  <BillLine state={bState!} spent={cat.spent} expected={expected} money={money} />
                  {overBudget && <span style={{ color: 'var(--red)', fontWeight: 600 }}> · {money(cat.spent - cat.target)} over</span>}
                </>
              )
              : left.state === 'none' ? <>{money(periodSpent)} <small>spent · no budget</small></>
              : left.state === 'over' ? <span style={{ color: 'var(--red)', fontWeight: 600 }}>{money(-left.left)} over <small style={{ fontWeight: 400 }}>{money(cat.target)}{isAnnual ? '/yr' : ''}</small></span>
              : <><b style={{ color: left.state === 'near' ? 'var(--amber)' : undefined }}>{money(left.left)} left</b> <small>of {money(cat.target)}{isAnnual ? '/yr' : ''}</small></>}
            </span>
            {onHide && (
              <button type="button" onClick={e => { e.stopPropagation(); onHide(); }} title="Hide from budget list" aria-label={`Hide ${cat.category} from the budget list`} className="cat-hide"
                style={{ background: 'transparent', cursor: 'pointer', fontSize: 12, lineHeight: 1, padding: '0 2px', marginLeft: 6 }}>🚫</button>
            )}
          </span>
        </div>
        <div className="bud-track">
          <i style={{ width: `${fill * 100}%`, background: color, opacity: faint ? 0.3 : 1 }} />
          {tick != null && <u style={{ left: `${tick * 100}%` }} />}
        </div>
      </div>
      {open && (
        <div style={{ margin: '8px 0 4px 18px', paddingLeft: 10, borderLeft: '2px solid var(--border)' }}>
          {excluded ? (
            <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
              Left out of spending and budgets. The headline tiles show it as its own figure.
            </p>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, fontSize: 12, flexWrap: 'wrap' }}>
              <span style={{ color: 'var(--muted)' }}>Budget:</span>
              <input value={targetDraft} onChange={e => { setTargetDraft(e.target.value); setTargetErr(false); }}
                onKeyDown={e => { if (e.key === 'Enter') commitTarget(); }}
                aria-label={`${cat.category} budget`} aria-invalid={targetErr || undefined} aria-describedby={targetErr ? `bud-err-${cat.category}` : undefined}
                placeholder="0" style={{ width: 76, padding: '3px 6px', fontSize: 12, borderColor: targetErr ? 'var(--red)' : undefined }} />
              <select value={period} onChange={e => setPeriod(e.target.value as 'monthly' | 'annual')}
                style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', fontSize: 12, padding: '3px 4px', cursor: 'pointer' }}>
                <option value="monthly">/ month</option>
                <option value="annual">/ year</option>
              </select>
              <button className="btn-primary" style={{ fontSize: 11, padding: '3px 8px' }}
                onClick={commitTarget}>Save</button>
              {targetErr && <span id={`bud-err-${cat.category}`} role="alert" style={{ color: 'var(--red)', flexBasis: '100%' }}>Enter an amount, like 300, $1,250 or 1.5k.</span>}
            </div>
          )}
          {bill && (
            <p style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8 }}>
              Counted as a bill: recurring charges here come to ~{money(bill.recurringMonthly)} a month
              {bill.typicalMonthly > 0 ? `, of a typical ${money(bill.typicalMonthly)}` : ''}. {billTitle}.
            </p>
          )}
          {!excluded && isAnnual && cat.target > 0 && (
            <p style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8 }}>
              {(() => {
                // Name the periods: year-to-date through the viewed month, then that month alone.
                const yr = month.slice(0, 4), m = monthName(month);
                const ytdLabel = month.slice(5, 7) === '01' ? `${m} ${yr}` : `${monthName(`${yr}-01`)}–${m} ${yr}`;
                return `${ytdLabel}: ${money(cat.ytdSpent ?? 0)} · ${m}: ${money(cat.spent)}`;
              })()}
            </p>
          )}
          {txns.length === 0 && <p style={{ fontSize: 12, color: 'var(--muted)' }}>No transactions.</p>}
          {txns.map(t => (
            <div key={t.id} {...rowProps(() => openTxnDetail(txnToDetail(t)))} title="Click for details" aria-label={txnRowLabel(t, moneyCents)} className="bud-sub-row">
              <span style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>{fmtTxnDate(t.date)}</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }} title={t.account}>
                <MerchantIcon merchant={t.merchant} label={t.payee} size={20} />
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.payee}</span>
              </span>
              <span onClick={stop} style={{ minWidth: 0 }}>
                <CategoryPicker chip value={needsCategory(t) ? '' : t.category} options={cats} groups={groups} suggested={t.suggested} applyHint={`Applies to every ${t.payee} transaction`}
                  onChange={c => onRecategorize(t.merchant, c, { payee: t.payee, description: t.description, amount: t.amount })} onCreate={n => onCreateCategory(t.merchant, n, { payee: t.payee, description: t.description, amount: t.amount })} />
              </span>
              <span style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{moneyCents(t.amount)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
