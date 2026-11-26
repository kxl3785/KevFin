import { useRef, useState } from 'react';
import { useApi } from '../../hooks/useApi.ts';
import { usePersistentState } from '../../hooks/usePersistentState.ts';
import { useIsMobile } from '../../hooks/useIsMobile.ts';
import MerchantIcon from '../MerchantIcon.tsx';
import CategoryPicker, { type PickerGroup } from '../CategoryPicker.tsx';
import { openTxnDetail } from '../TransactionDetail.tsx';
import { fmtTxnDate, rowProps } from '../../lib/budgetUi.ts';
import { AMOUNT_FILTERS, NO_FILTERS, filterTxns, inOutMortgage, needsCategory, monthLong, type AmountFilter, type TxnFilters } from '../../lib/budgetView.ts';
import { txnToDetail, stop, type BudgetTxn, type Money, type Recategorize, type CreateCategory } from './types.ts';

// The Transactions sub-tab: every transaction for the header month (or all
// time), filtered by a row of chips — period, category, account, "needs a
// category", amount and search — with In / Out / Mortgage tiles over the list.
// The list is virtualised (fixed row height), so it keeps a date column rather
// than day headers.
export default function TransactionsView({ money, moneyCents, cats, groups, month, allTime, setAllTime, filters, setFilters, onRecategorize, onCreateCategory, onFlipSign, version }: {
  money: Money; moneyCents: Money; cats: string[]; groups: PickerGroup[];
  month: string; allTime: boolean; setAllTime: (v: boolean) => void;
  filters: TxnFilters; setFilters: (f: TxnFilters) => void;
  onRecategorize: Recategorize; onCreateCategory: CreateCategory;
  onFlipSign: (merchant: string, payee?: string) => void;
  version: number;
}) {
  const range = allTime || !month ? 'all' : month;
  const [sortBy, setSortBy] = usePersistentState<'date' | 'amount'>('mon.txnSortBy', 'date');
  const [sortDir, setSortDir] = usePersistentState<'asc' | 'desc'>('mon.txnSortDir', 'desc');
  const { data: list, loading } = useApi<{ months: string[]; transactions: BudgetTxn[] }>(`/api/budget/transactions?range=${range}`, [range, version]);
  const all = list?.transactions ?? [];
  const set = (patch: Partial<TxnFilters>) => setFilters({ ...filters, ...patch });

  // Virtualize: with all-time selected there can be thousands of rows (each with
  // a category picker), so only render the slice in (and just around) the viewport.
  // Phone rows are two lines tall (see .txn-grid in index.css), so the fixed row
  // height the windowing maths relies on has to follow the breakpoint.
  const isMobile = useIsMobile();
  const ROW_H = isMobile ? 64 : 48, VIEW_H = 560, BUFFER = 6;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);

  const filtered = filterTxns(all, filters);
  const dir = sortDir === 'asc' ? 1 : -1;
  const rows = [...filtered].sort((a, b) =>
    sortBy === 'amount' ? (a.amount - b.amount) * dir : (a.date.localeCompare(b.date) || (a.postedAt - b.postedAt)) * dir);
  // In / Out by sign (Transfers already excluded server-side); mortgage payments
  // are listed but counted on their own, matching the Overview's "Spent".
  const { inflow, outflow, mortgage } = inOutMortgage(filtered);
  const needCount = all.filter(needsCategory).length;
  const accounts = [...new Set(all.map(t => t.account))].sort((a, b) => a.localeCompare(b));
  const narrowed = filters.category !== '' || filters.account !== '' || filters.needsCategory || filters.amount !== 'any' || filters.q.trim() !== '';

  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - BUFFER);
  const end = Math.min(rows.length, Math.ceil((scrollTop + VIEW_H) / ROW_H) + BUFFER);
  const visible = rows.slice(start, end).map((t, i) => ({ t, idx: start + i }));

  function toggleSort(col: 'date' | 'amount') {
    if (sortBy === col) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortBy(col); setSortDir('desc'); }
  }
  const arrow = (col: 'date' | 'amount') => (sortBy === col ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '');
  const sortBtn: React.CSSProperties = { background: 'transparent', padding: 0, font: 'inherit', textTransform: 'inherit', letterSpacing: 'inherit', fontWeight: 'inherit', color: 'inherit', cursor: 'pointer', userSelect: 'none' };
  const chipCls = (on: boolean) => `bud-fchip${on ? ' on' : ''}`;

  return (
    <div className="db-card">
      <div className="db-head" style={{ marginBottom: 10 }}>
        <h2>
          {range === 'all' ? 'All transactions' : monthLong(range)}
          <span style={{ color: 'var(--muted)', fontWeight: 400 }}> · {loading ? '…' : `${rows.length}${narrowed ? ` of ${all.length}` : ''} transaction${(narrowed ? all.length : rows.length) === 1 ? '' : 's'}`}</span>
        </h2>
        {narrowed && <button type="button" className="bud-link" onClick={() => setFilters(NO_FILTERS)}>Clear filters</button>}
      </div>

      <div className="bud-filters" role="group" aria-label="Filter transactions">
        {month && (
          <button type="button" className={chipCls(!allTime)} aria-pressed={!allTime} onClick={() => setAllTime(false)}
            title="Show the month picked at the top of the page">{monthLong(month)}</button>
        )}
        <button type="button" className={chipCls(allTime)} aria-pressed={allTime} onClick={() => setAllTime(true)}>All time</button>
        <span className="bud-fchip-wrap">
          <CategoryPicker value={filters.category} placeholder="Category" options={cats} groups={groups} onChange={c => set({ category: c })}
            triggerStyle={{ width: 'auto', borderRadius: 999, padding: '4px 10px', fontSize: 12, background: 'var(--surface)', color: filters.category ? 'var(--accent)' : 'var(--muted)', border: `1px solid ${filters.category ? 'var(--accent)' : 'var(--border)'}` }} />
          {filters.category && <button type="button" className="bud-fchip-x" onClick={() => set({ category: '' })} aria-label="Clear the category filter">×</button>}
        </span>
        <select className={chipCls(filters.account !== '')} value={filters.account} onChange={e => set({ account: e.target.value })} aria-label="Account">
          <option value="">All accounts</option>
          {accounts.map(a => <option key={a} value={a}>{a}</option>)}
        </select>
        <button type="button" className={chipCls(filters.needsCategory)} aria-pressed={filters.needsCategory}
          onClick={() => set({ needsCategory: !filters.needsCategory })} disabled={needCount === 0 && !filters.needsCategory}
          title="Expenses still in Miscellaneous">Needs a category · {needCount}</button>
        <select className={chipCls(filters.amount !== 'any')} value={filters.amount} onChange={e => set({ amount: e.target.value as AmountFilter })} aria-label="Amount">
          {AMOUNT_FILTERS.map(a => <option key={a.key} value={a.key}>{a.label}</option>)}
        </select>
        <input type="search" className={`${chipCls(filters.q.trim() !== '')} bud-search`} value={filters.q} onChange={e => set({ q: e.target.value })}
          placeholder="Search…" aria-label="Search merchant, account or category" />
      </div>

      <div className="bud-mini-tiles" title="In and Out are summed by sign, so a refund counts as In. Mortgage payments are listed but counted on their own, as in the Overview.">
        <div><span>In</span><b style={{ color: 'var(--green)' }}>{money(inflow)}</b></div>
        <div><span>Out</span><b>{money(outflow)}</b></div>
        <div><span>Mortgage</span><b>{money(mortgage)}</b></div>
      </div>

      {/* The column grid lives in index.css (.txn-grid): six columns on desktop;
          on a phone each row becomes two lines so the amount stays on screen. */}
      <div className="txn-grid txn-head" style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, paddingBottom: 6, borderBottom: '1px solid var(--border)' }}>
        <button type="button" onClick={() => toggleSort('date')} aria-label={`Sort by date${sortBy === 'date' ? (sortDir === 'asc' ? ', ascending' : ', descending') : ''}`}
          style={{ ...sortBtn, textAlign: 'left', color: sortBy === 'date' ? 'var(--text)' : undefined }} title="Sort by date">Date{arrow('date')}</button>
        <span>Merchant</span><span>Account</span><span>Category</span>
        <button type="button" onClick={() => toggleSort('amount')} aria-label={`Sort by amount${sortBy === 'amount' ? (sortDir === 'asc' ? ', ascending' : ', descending') : ''}`}
          style={{ ...sortBtn, textAlign: 'right', color: sortBy === 'amount' ? 'var(--text)' : undefined }} title="Sort by amount">Amount{arrow('amount')}</button>
        <span style={{ textAlign: 'center' }} title="⇄ reverses the +/− sign for a merchant, for its past and future transactions">±</span>
      </div>
      <div ref={scrollRef} onScroll={e => setScrollTop(e.currentTarget.scrollTop)} style={{ maxHeight: VIEW_H, overflowY: 'auto', position: 'relative' }}>
        <div style={{ height: rows.length * ROW_H, position: 'relative' }}>
          {visible.map(({ t, idx }) => {
            const isMortgage = t.category === 'Mortgage';
            return (
              <div key={t.id} {...rowProps(() => openTxnDetail(txnToDetail(t)))} title="Click for details"
                className="txn-grid"
                style={{ position: 'absolute', top: idx * ROW_H, left: 0, right: 0, height: ROW_H, boxSizing: 'border-box', fontSize: 13, borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
                <span className="txn-date" style={{ color: 'var(--muted)', fontSize: 12, whiteSpace: 'nowrap' }}>{fmtTxnDate(t.date)}</span>
                <span className="txn-merchant" style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <MerchantIcon merchant={t.merchant} label={t.payee} size={24} />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.payee}</span>
                      {isMortgage && <span className="bud-tag" style={{ marginLeft: 0, flexShrink: 0 }} title="Counted on its own, not in Out or Spent">mortgage</span>}
                    </span>
                    {t.description && t.description.toLowerCase() !== t.payee.toLowerCase() && (
                      <span style={{ display: 'block', fontSize: 10, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'ui-monospace, SFMono-Regular, monospace' }} title={t.description}>{t.description}</span>
                    )}
                  </span>
                </span>
                <span className="txn-acct" style={{ color: 'var(--muted)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.account}>{t.account}</span>
                <span className="txn-cat" onClick={stop} style={{ minWidth: 0 }}>
                  <CategoryPicker chip value={needsCategory(t) ? '' : t.category} options={cats} groups={groups} suggested={t.suggested} applyHint={`Applies to every ${t.payee} transaction`}
                    onChange={c => onRecategorize(t.merchant, c, { payee: t.payee, description: t.description, amount: t.amount })} onCreate={n => onCreateCategory(t.merchant, n)} />
                </span>
                <span className="txn-amt" style={{ textAlign: 'right', whiteSpace: 'nowrap', color: t.amount > 0 ? 'var(--green)' : 'var(--text)' }}>{moneyCents(t.amount)}</span>
                <button type="button" className="txn-flip" onClick={e => { stop(e); onFlipSign(t.merchant, t.payee); }}
                  aria-label={t.flipped ? `Restore the original +/− sign for ${t.payee}` : `Reverse the +/− sign for ${t.payee}, now and in future`} aria-pressed={!!t.flipped}
                  title={t.flipped
                    ? `Sign reversed for ${t.payee} and similar merchants. Click to restore the original sign.`
                    : `Reverse the +/− sign: treat ${t.payee} (and similar merchants) as money ${t.amount > 0 ? 'out' : 'in'} instead, for past and future transactions`}
                  style={{ background: 'transparent', padding: 0, cursor: 'pointer', textAlign: 'center', fontSize: 13, lineHeight: 1, color: t.flipped ? 'var(--accent)' : 'var(--muted)', fontWeight: t.flipped ? 700 : 400 }}>⇄</button>
              </div>
            );
          })}
        </div>
        {!loading && rows.length === 0 && <p style={{ color: 'var(--muted)', fontSize: 13, padding: '10px 0' }}>{narrowed ? 'No transactions match these filters.' : 'No transactions.'}</p>}
        {loading && <p style={{ color: 'var(--muted)', fontSize: 13, padding: '10px 0' }}>Loading…</p>}
      </div>
      <p className="db-sub" style={{ marginTop: 8 }}>⇄ reverses the +/− sign for a merchant (now and for future transactions), for a payment that posts the wrong way round.</p>
    </div>
  );
}
