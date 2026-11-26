import MerchantIcon from '../MerchantIcon.tsx';
import CategoryPicker, { type PickerGroup } from '../CategoryPicker.tsx';
import { openTxnDetail } from '../TransactionDetail.tsx';
import { rowProps } from '../../lib/budgetUi.ts';
import { dayHeader, groupByDay, needsCategory } from '../../lib/budgetView.ts';
import { txnToDetail, txnRowLabel, stop, type BudgetTxn, type Money, type Recategorize, type CreateCategory } from './types.ts';

// The Overview's "Latest transactions" (across all months), grouped under day
// headers. The category is a chip that opens the picker; an uncategorized
// expense shows a dashed "+ Categorize" chip instead.
export default function LatestTransactions({ txns, cats, groups, moneyCents, onRecategorize, onCreateCategory, onSeeAll }: {
  txns: BudgetTxn[]; cats: string[]; groups: PickerGroup[]; moneyCents: Money;
  onRecategorize: Recategorize; onCreateCategory: CreateCategory; onSeeAll: () => void;
}) {
  return (
    <div className="db-card">
      <div className="db-head" style={{ marginBottom: 6 }}>
        <h2>Latest transactions <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 12 }}>(all months)</span></h2>
        <button type="button" className="bud-link" onClick={onSeeAll}>See all ▸</button>
      </div>
      {txns.length === 0 && <p style={{ fontSize: 13, color: 'var(--muted)' }}>No transactions.</p>}
      {groupByDay(txns).map(day => (
        <div key={day.date}>
          <p className="bud-day">{dayHeader(day.date)}</p>
          {day.rows.map(t => (
            <div key={t.id} {...rowProps(() => openTxnDetail(txnToDetail(t)))} title="Click for details" aria-label={txnRowLabel(t, moneyCents)} className="bud-txn">
              <MerchantIcon merchant={t.merchant} label={t.payee} size={24} />
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.payee}</span>
                <span style={{ display: 'block', fontSize: 11, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.description || t.account}>{t.account}</span>
              </span>
              <span onClick={stop} style={{ minWidth: 0, display: 'flex', justifyContent: 'flex-end' }}>
                <CategoryPicker chip value={needsCategory(t) ? '' : t.category} options={cats} groups={groups} suggested={t.suggested} applyHint={`Applies to every ${t.payee} transaction`}
                  onChange={c => onRecategorize(t.merchant, c, { payee: t.payee, description: t.description, amount: t.amount })} onCreate={n => onCreateCategory(t.merchant, n, { payee: t.payee, description: t.description, amount: t.amount })} />
              </span>
              <span className="bud-amt" style={{ color: t.amount > 0 ? 'var(--green)' : 'var(--text)' }}>{t.amount > 0 ? '+' : ''}{moneyCents(t.amount)}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
