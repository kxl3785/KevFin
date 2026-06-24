import { useState, useRef, useEffect } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { useApi } from '../hooks/useApi.ts';
import { usePersistentState } from '../hooks/usePersistentState.ts';
import TopNav, { type View } from '../components/TopNav.tsx';
import Recurring from './Recurring.tsx';
import MerchantIcon from '../components/MerchantIcon.tsx';
import CategoryPicker, { type PickerGroup } from '../components/CategoryPicker.tsx';
import CashFlowSankey from '../components/CashFlowSankey.tsx';
import ReviewWizard from '../components/ReviewWizard.tsx';
import RuleSuggestModal, { type RuleCtx } from '../components/RuleSuggestModal.tsx';
import { TransactionDetailProvider, openTxnDetail, type TxnDetail } from '../components/TransactionDetail.tsx';

interface BudgetTxn { id: string; date: string; amount: number; payee: string; account: string; merchant: string; category: string; suggested: string; description: string; memo: string; postedAt: number; transactedAt: number | null }
interface CatRow { category: string; spent: number; count: number; target: number; period?: 'monthly' | 'annual'; ytdSpent?: number; excluded?: boolean }
interface BudgetData {
  months: string[]; month: string; transactions: BudgetTxn[]; byCategory: CatRow[];
  needsReview: BudgetTxn[]; recent: BudgetTxn[]; income: number; spending: number; mortgage: number; totalBudget: number; categories: string[]; groups: PickerGroup[];
  comparison: { priorMonth: number | null; priorYearAvg: number | null };
  dailyCumulative: { day: number; current: number | null; prior: number | null }[];
  importedCount: number;
}
interface ImportedTxn { id: string; date: string; amount: number; payee: string; account: string; category: string | null }

const PROTECTED = new Set(['Paychecks', 'Other Income', 'Dividends & Capital Gains', 'Transfers', 'Credit Card Payment', 'Mortgage', 'Miscellaneous']);

// Map a transaction row to the shared detail-popup shape.
const txnToDetail = (t: BudgetTxn): TxnDetail => ({
  payee: t.payee, merchant: t.merchant, amount: t.amount, category: t.category, account: t.account,
  date: t.date, postedAt: t.postedAt, transactedAt: t.transactedAt, description: t.description, memo: t.memo,
  suggested: t.suggested,
});
// Stop a click on an inner control (the category picker, a remove button) from
// also opening the row's detail popup.
const stop = (e: React.MouseEvent) => e.stopPropagation();

function fmtMonth(m: string) {
  return new Date(m + '-01T00:00:00').toLocaleString('en-US', { month: 'long', year: 'numeric' });
}
// Compact date with year (e.g. 2026-06-18 → 6/18/26), for the all-time list.
function shortDate(d: string) {
  const [y, m, day] = d.split('-');
  return `${+m}/${+day}/${y.slice(2)}`;
}
function addMonths(ym: string, delta: number) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
}
function barColor(spent: number, target: number) {
  if (!target) return 'var(--accent)';
  const r = spent / target;
  return r > 1 ? 'var(--red)' : r > 0.85 ? 'var(--amber)' : 'var(--green)';
}

export default function Budget({ onNavigate, privacy, onTogglePrivacy }: {
  onNavigate: (v: View) => void; privacy: boolean; onTogglePrivacy: () => void;
}) {
  const [month, setMonth] = useState('');
  const [subTab, setSubTab] = useState<'overview' | 'cashflow' | 'transactions' | 'recurring'>('overview');
  const [txnFilter, setTxnFilter] = useState('');
  const [openCat, setOpenCat] = useState<string | null>(null);
  const [compareMode, setCompareMode] = useState<'priorMonth' | 'priorYearAvg'>('priorMonth');
  const [manageOpen, setManageOpen] = useState(false);
  const [newCat, setNewCat] = useState('');
  const [reviewOpen, setReviewOpen] = useState(false);
  const [importMsg, setImportMsg] = useState('');
  const [importedOpen, setImportedOpen] = useState(false);
  const [importedList, setImportedList] = useState<ImportedTxn[]>([]);
  const [ruleMsg, setRuleMsg] = useState('');
  const ruleMsgTimer = useRef(0);
  // After categorizing, offer smart rules (merchant / amount / text) to apply to
  // other and future transactions.
  const [ruleCtx, setRuleCtx] = useState<RuleCtx | null>(null);
  const [recatVersion, setRecatVersion] = useState(0); // bumps the Sankey to re-fetch after a categorization
  const fileRef = useRef<HTMLInputElement>(null);

  // Deep-link from another page (e.g. Forecast category rows): open the
  // transactions tab pre-filtered to a category. Consumed once.
  useEffect(() => {
    try {
      const raw = localStorage.getItem('mon.budgetDeepLink');
      if (!raw) return;
      localStorage.removeItem('mon.budgetDeepLink');
      const dl = JSON.parse(raw) as { tab?: typeof subTab; filter?: string };
      if (dl.tab) setSubTab(dl.tab);
      if (dl.filter != null) setTxnFilter(dl.filter);
    } catch { /* ignore */ }
  }, []);
  const { data, loading, error, refetch } = useApi<BudgetData>(`/api/budget${month ? `?month=${month}` : ''}`, [month]);
  const money = (n: number) => (privacy ? '••••••' : '$' + Math.round(n).toLocaleString());

  // Create a new category (server auto-picks an emoji), then assign it to the
  // merchant — used by the "+ Create" action in the category picker.
  async function categorizeNew(merchant: string, name: string) {
    const res = await fetch('/api/budget/category', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    const d = await res.json().catch(() => ({} as { created?: string }));
    await recategorize(merchant, d?.created || name.trim());
  }

  function toast(msg: string) {
    setRuleMsg(msg);
    window.clearTimeout(ruleMsgTimer.current);
    ruleMsgTimer.current = window.setTimeout(() => setRuleMsg(''), 4000);
  }

  // Categorize just this merchant (scope 'one'), then offer smart rules to apply
  // the same category to other/future transactions (by merchant, amount or text).
  async function recategorize(merchant: string, category: string, ctx?: { payee: string; description: string; amount: number }) {
    await fetch('/api/budget/rule', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ merchant, category }) });
    refetch();
    setRecatVersion(v => v + 1);
    setRuleCtx({ merchant, payee: ctx?.payee ?? merchant, description: ctx?.description, amount: ctx?.amount ?? 0, category });
  }
  async function saveTarget(category: string, limit: number, period: 'monthly' | 'annual' = 'monthly') {
    await fetch('/api/budget/target', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ category, limit, period }) });
    refetch();
  }
  async function addCat() {
    if (!newCat.trim()) return;
    await fetch('/api/budget/category', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: newCat.trim() }) });
    setNewCat(''); refetch();
  }
  async function removeCat(name: string) {
    await fetch(`/api/budget/category/${encodeURIComponent(name)}`, { method: 'DELETE' });
    refetch();
  }
  // Rename a category's display label (canonical id stays stable everywhere).
  async function renameCat(canonical: string, label: string) {
    await fetch(`/api/budget/category/${encodeURIComponent(canonical)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label }) });
    refetch();
  }
  async function onImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportMsg('Importing…');
    try {
      const csv = await file.text();
      const res = await fetch('/api/budget/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ csv }) });
      const d = await res.json();
      setImportMsg(res.ok
        ? `Imported ${d.imported} · skipped ${d.skipped} in-file dupe${d.skipped === 1 ? '' : 's'} · reconciled ${d.reconciled ?? 0} matching your bank data`
        : (d.error || 'Import failed'));
      refetch();
    } catch {
      setImportMsg('Could not read file');
    }
    e.target.value = '';
  }
  async function toggleImported() {
    if (!importedOpen) setImportedList(await (await fetch('/api/budget/imported')).json());
    setImportedOpen(o => !o);
  }
  async function clearAllImported() {
    await fetch('/api/budget/imported', { method: 'DELETE' });
    setImportedList([]); setImportMsg(''); refetch();
  }
  async function removeImported(id: string) {
    await fetch(`/api/budget/imported/${encodeURIComponent(id)}`, { method: 'DELETE' });
    setImportedList(l => l.filter(t => t.id !== id)); refetch();
  }
  async function reconcile() {
    setImportMsg('Reconciling…');
    const d = await (await fetch('/api/budget/reconcile', { method: 'POST' })).json();
    setImportMsg(`Removed ${d.removed} imported transaction${d.removed === 1 ? '' : 's'} that duplicated your bank data`);
    if (importedOpen) setImportedList(await (await fetch('/api/budget/imported')).json());
    refetch();
  }

  const cats = data?.categories ?? [];
  const groups = data?.groups ?? [];
  const reviewTotal = (data?.needsReview ?? []).reduce((s, t) => s + Math.abs(t.amount), 0);
  const compVal = compareMode === 'priorMonth' ? data?.comparison.priorMonth : data?.comparison.priorYearAvg;
  const delta = compVal && data ? (data.spending - compVal) / compVal : null;

  return (
    <TransactionDetailProvider privacy={privacy}>
    <div className="page" style={{ maxWidth: 960, margin: '0 auto', padding: '32px 24px' }}>
      {reviewOpen && (
        <ReviewWizard cats={cats} groups={groups} money={money}
          onClose={() => { setReviewOpen(false); refetch(); }}
          onCategorized={() => { refetch(); setRecatVersion(v => v + 1); }} />
      )}
      <RuleSuggestModal ctx={ruleCtx} onClose={() => setRuleCtx(null)}
        onApplied={m => { refetch(); setRecatVersion(v => v + 1); if (m > 0) toast(`✨ Categorized ${m} transaction${m === 1 ? '' : 's'}`); }} />
      {ruleMsg && (
        <div style={{
          position: 'fixed', left: '50%', bottom: 28, transform: 'translateX(-50%)', zIndex: 2000,
          background: 'var(--surface)', border: '1px solid var(--accent)', borderRadius: 10,
          padding: '10px 16px', fontSize: 13, color: 'var(--text)', boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
        }}>
          {ruleMsg}
        </div>
      )}

      <TopNav view="budget" onNavigate={onNavigate} privacy={privacy} onTogglePrivacy={onTogglePrivacy} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h1 style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.5px' }}>Budget</h1>
        {subTab !== 'recurring' && subTab !== 'cashflow' && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn-primary" onClick={() => setReviewOpen(true)} title="Quickly categorize transactions that need review">⚡ Quick review</button>
            <button className="btn-ghost" onClick={() => fileRef.current?.click()} title="Import a CSV of transactions (e.g. Monarch)">⬆ Import</button>
            <input ref={fileRef} type="file" accept=".csv,text/csv" style={{ display: 'none' }} onChange={onImportFile} />
            {/* The Overview month picker; the All-transactions tab has its own period control. */}
            {subTab === 'overview' && data && (
              <select value={month || data.month} onChange={e => setMonth(e.target.value)}
                style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', fontSize: 13, padding: '6px 10px' }}>
                {data.months.map(m => <option key={m} value={m}>{fmtMonth(m)}</option>)}
              </select>
            )}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 16, marginBottom: 20, borderBottom: '1px solid var(--border)' }}>
        {(['overview', 'cashflow', 'transactions', 'recurring'] as const).map(t => (
          <button key={t} onClick={() => setSubTab(t)}
            style={{ background: 'transparent', color: subTab === t ? 'var(--text)' : 'var(--muted)', fontWeight: subTab === t ? 600 : 400, fontSize: 14, padding: '6px 2px', borderBottom: subTab === t ? '2px solid var(--accent)' : '2px solid transparent' }}>
            {t === 'overview' ? 'Overview' : t === 'cashflow' ? 'Cash Flow' : t === 'transactions' ? 'All transactions' : 'Recurring'}
          </button>
        ))}
      </div>

      {subTab !== 'recurring' && subTab !== 'cashflow' && loading && <p style={{ color: 'var(--muted)' }}>Loading…</p>}
      {subTab !== 'recurring' && subTab !== 'cashflow' && error && <p style={{ color: 'var(--red)' }}>Failed to load: {error}</p>}

      {subTab === 'cashflow' && (
        <CashFlowSankey privacy={privacy} cats={cats} groups={groups}
          onRecategorize={recategorize} onCreateCategory={categorizeNew} version={recatVersion} />
      )}

      {subTab === 'transactions' && (
        <TransactionsView money={money} cats={cats} groups={groups} filter={txnFilter} setFilter={setTxnFilter} onRecategorize={recategorize} onCreateCategory={categorizeNew} version={recatVersion} />
      )}

      {data && subTab === 'overview' && (
        <>
          {/* Summary: Spent vs a prior-period comparison */}
          <div className="stack-mobile" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 18px' }}>
              <p style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 4 }}>Spent · {fmtMonth(data.month)}</p>
              <p style={{ fontSize: 22, fontWeight: 700, color: 'var(--amber)' }}>{money(data.spending)}</p>
              {data.mortgage > 0 && (
                <p style={{ color: 'var(--muted)', fontSize: 11, marginTop: 6 }}>
                  + {money(data.mortgage)} mortgage (excluded · see Recurring tab)
                </p>
              )}
            </div>
            <div
              onClick={() => { const tgt = compareMode === 'priorMonth' ? addMonths(data.month, -1) : addMonths(data.month, -12); if (data.months.includes(tgt)) { setMonth(tgt); setSubTab('transactions'); } }}
              title="Click to view that period's transactions"
              style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 18px', cursor: 'pointer' }}>
              <select onClick={e => e.stopPropagation()} value={compareMode} onChange={e => setCompareMode(e.target.value as 'priorMonth' | 'priorYearAvg')}
                style={{ background: 'transparent', border: 'none', color: 'var(--muted)', fontSize: 12, padding: 0, marginBottom: 4, cursor: 'pointer' }}>
                <option value="priorMonth">vs prior month</option>
                <option value="priorYearAvg">vs same month, prior years (avg)</option>
              </select>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <p style={{ fontSize: 22, fontWeight: 700, color: 'var(--text)' }}>{compVal != null ? money(compVal) : '—'}</p>
                {delta != null && (
                  <span style={{ fontSize: 13, fontWeight: 600, color: delta > 0 ? 'var(--red)' : 'var(--green)' }}>
                    {delta > 0 ? '↑' : '↓'} {Math.abs(delta * 100).toFixed(0)}% {delta > 0 ? 'more' : 'less'}
                  </span>
                )}
                {compVal == null && <span style={{ fontSize: 12, color: 'var(--muted)' }}>no prior data</span>}
              </div>
            </div>
          </div>

          {importMsg && <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: -8, marginBottom: 16 }}>{importMsg}</p>}

          {/* Cumulative spending: this month vs prior month, day by day */}
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 20, marginBottom: 20 }}>
            <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Spending so far · vs prior month</h2>
            <div style={{ width: '100%', height: 220, filter: privacy ? 'blur(8px)' : 'none' }}>
              <ResponsiveContainer>
                <LineChart data={data.dailyCumulative} margin={{ top: 6, right: 14, left: 6, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2a2d3a" />
                  <XAxis dataKey="day" tick={{ fill: '#7b7f95', fontSize: 11 }} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fill: '#7b7f95', fontSize: 11 }} tickLine={false} axisLine={false}
                    tickFormatter={v => '$' + (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v)} width={44} />
                  <Tooltip contentStyle={{ background: '#1a1d27', border: '1px solid #2a2d3a', borderRadius: 8 }}
                    labelFormatter={d => `Day ${d}`} formatter={(v: number) => '$' + Math.round(v).toLocaleString()} />
                  <Legend wrapperStyle={{ fontSize: 12, color: '#7b7f95' }} />
                  <Line type="monotone" dataKey="prior" name="Prior month" stroke="#7b7f95" strokeWidth={2} strokeDasharray="5 4" dot={false} connectNulls />
                  <Line type="monotone" dataKey="current" name="This month" stroke="#fbbf24" strokeWidth={2.5} dot={false} connectNulls />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Needs review — fast categorization */}
          {data.needsReview.length > 0 && (
            <div style={{ background: 'var(--surface)', border: '1px solid var(--amber)', borderRadius: 12, padding: 20, marginBottom: 20 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h2 style={{ fontSize: 15, fontWeight: 600 }}>Needs review · {data.needsReview.length} · {money(reviewTotal)}</h2>
                <button className="btn-primary" style={{ fontSize: 12, padding: '5px 12px' }} onClick={() => setReviewOpen(true)} title="Step through everything that needs review">⚡ Quick review</button>
              </div>
              <p style={{ color: 'var(--muted)', fontSize: 12, margin: '4px 0 12px' }}>Pick a category — it remembers the merchant for next time.</p>
              {data.needsReview.map(t => (
                <div key={t.id} onClick={() => openTxnDetail(txnToDetail(t))} title="Click for details"
                  style={{ display: 'grid', gridTemplateColumns: '50px 1fr 120px 78px 130px', gap: 10, alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
                  <span style={{ color: 'var(--muted)', fontSize: 12 }}>{t.date.slice(5)}</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, minWidth: 0 }}>
                    <MerchantIcon merchant={t.merchant} label={t.payee} size={22} />
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.payee}</span>
                      {t.description && t.description.toLowerCase() !== t.payee.toLowerCase() && (
                        <span style={{ display: 'block', fontSize: 10, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'ui-monospace, SFMono-Regular, monospace' }} title={t.description}>{t.description}</span>
                      )}
                    </span>
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.account}>{t.account}</span>
                  <span style={{ textAlign: 'right', fontSize: 13 }}>{money(t.amount)}</span>
                  <span onClick={stop}>
                    <CategoryPicker value="" placeholder="Categorize…" excludeOther options={cats} groups={groups} suggested={t.suggested}
                      onChange={c => recategorize(t.merchant, c, { payee: t.payee, description: t.description, amount: t.amount })} onCreate={n => categorizeNew(t.merchant, n)} />
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Categories (half width) next to a Recent transactions square */}
          <div className="stack-mobile" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'start' }}>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <h2 style={{ fontSize: 15, fontWeight: 600 }}>Categories</h2>
              <button onClick={() => setManageOpen(o => !o)} style={{ background: 'transparent', color: 'var(--accent)', fontSize: 12 }}>
                {manageOpen ? 'Done' : '⚙ Manage categories'}
              </button>
            </div>
            {manageOpen && (
              <div style={{ background: 'var(--bg)', borderRadius: 8, padding: 12, marginBottom: 14 }}>
                <p style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 10 }}>Edit a name to rename it everywhere — the new label shows up across transactions, charts and the cash-flow Sankey.</p>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '2px 16px', marginBottom: 12 }}>
                  {groups.flatMap(g => g.categories).map(c => (
                    <div key={c.canonical ?? c.name} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0' }}>
                      <span style={{ width: 20, textAlign: 'center', flexShrink: 0 }}>{c.emoji}</span>
                      <input defaultValue={c.name}
                        onBlur={e => { const v = e.target.value.trim(); if (v && v !== c.name && c.canonical) renameCat(c.canonical, v); }}
                        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                        style={{ flex: 1, minWidth: 0, padding: '3px 6px', fontSize: 12, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)' }} />
                      {!PROTECTED.has(c.canonical ?? c.name) && (
                        <span onClick={() => removeCat(c.canonical ?? c.name)} title="Remove" style={{ cursor: 'pointer', color: 'var(--red)', fontWeight: 700, flexShrink: 0 }}>×</span>
                      )}
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input value={newCat} onChange={e => setNewCat(e.target.value)} placeholder="New category name"
                    onKeyDown={e => { if (e.key === 'Enter') addCat(); }} style={{ flex: 1, padding: '5px 8px', fontSize: 13 }} />
                  <button className="btn-primary" style={{ fontSize: 12 }} onClick={addCat}>+ Add</button>
                </div>
                <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>New categories get an auto-picked emoji. Removing one reassigns its transactions to Miscellaneous.</p>
              </div>
            )}
            {data.byCategory.map(c => (
              <CategoryRow key={c.category} cat={c} open={openCat === c.category}
                onToggle={() => setOpenCat(o => (o === c.category ? null : c.category))}
                txns={data.transactions.filter(t => t.category === c.category)}
                cats={cats} groups={groups} money={money} onRecategorize={recategorize} onCreateCategory={categorizeNew} onSaveTarget={saveTarget} />
            ))}
          </div>

          {/* Recent transactions square (other half) */}
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 20 }}>
            <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Recent transactions</h2>
            {data.recent.length === 0 && <p style={{ fontSize: 13, color: 'var(--muted)' }}>No transactions.</p>}
            {data.recent.map(t => (
              <div key={t.id} onClick={() => openTxnDetail(txnToDetail(t))} title="Click for details"
                style={{ display: 'grid', gridTemplateColumns: '44px 1fr auto', gap: 8, alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
                <span style={{ color: 'var(--muted)', fontSize: 12 }}>{shortDate(t.date)}</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <MerchantIcon merchant={t.merchant} label={t.payee} size={22} />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.payee}</span>
                    <span style={{ display: 'block', fontSize: 10, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.category}</span>
                  </span>
                </span>
                <span style={{ textAlign: 'right', fontSize: 13, color: t.amount > 0 ? 'var(--green)' : 'var(--text)' }}>{money(t.amount)}</span>
              </div>
            ))}
          </div>
          </div>

          {/* Imported data review / clear */}
          {data.importedCount > 0 && (
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 20, marginTop: 20 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <button onClick={toggleImported} style={{ background: 'transparent', color: 'var(--text)', fontSize: 15, fontWeight: 600 }}>
                  {importedOpen ? '▾' : '▸'} Imported transactions ({data.importedCount})
                </button>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }}
                    onClick={reconcile} title="Remove imported transactions that duplicate your connected bank/card data">⟲ Reconcile duplicates</button>
                  <button className="btn-danger" style={{ fontSize: 12, padding: '4px 10px' }}
                    onClick={() => { if (confirm('Remove all imported transactions?')) clearAllImported(); }}>Clear all</button>
                </div>
              </div>
              {importedOpen && (
                <div style={{ marginTop: 12, maxHeight: 360, overflowY: 'auto' }}>
                  {importedList.map(t => (
                    <div key={t.id} onClick={() => openTxnDetail({ payee: t.payee, amount: t.amount, category: t.category ?? undefined, importedCategory: t.category ?? undefined, account: t.account, date: t.date })} title="Click for details"
                      style={{ display: 'grid', gridTemplateColumns: '70px 1fr 120px 80px 26px', gap: 8, alignItems: 'center', fontSize: 12, padding: '5px 0', borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
                      <span style={{ color: 'var(--muted)' }}>{t.date}</span>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.payee}</span>
                      <span style={{ color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.account}</span>
                      <span style={{ textAlign: 'right' }}>{money(t.amount)}</span>
                      <span onClick={e => { stop(e); removeImported(t.id); }} title="Remove" style={{ cursor: 'pointer', color: 'var(--red)', textAlign: 'center' }}>×</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {subTab === 'recurring' && (
        <Recurring embedded onNavigate={onNavigate} privacy={privacy} onTogglePrivacy={onTogglePrivacy} />
      )}
    </div>
    </TransactionDetailProvider>
  );
}

function TransactionsView({ money, cats, groups, filter, setFilter, onRecategorize, onCreateCategory, version }: {
  money: (n: number) => string; cats: string[]; groups: PickerGroup[];
  filter: string; setFilter: (s: string) => void; onRecategorize: (m: string, c: string, ctx?: { payee: string; description: string; amount: number }) => void; onCreateCategory: (m: string, name: string) => void;
  version: number;
}) {
  // Self-contained: fetches its own list (all-time by default), independent of
  // the Overview month. Re-fetches when a categorization bumps `version`.
  const [range, setRange] = usePersistentState<string>('mon.txnRange', 'all');
  const [sortBy, setSortBy] = usePersistentState<'date' | 'amount'>('mon.txnSortBy', 'date');
  const [sortDir, setSortDir] = usePersistentState<'asc' | 'desc'>('mon.txnSortDir', 'desc');
  const { data: list, loading } = useApi<{ months: string[]; transactions: BudgetTxn[] }>(`/api/budget/transactions?range=${range}`, [range, version]);
  const months = list?.months ?? [];

  // Virtualize: with all-time selected there can be thousands of rows (each with
  // a category picker), so only render the slice in (and just around) the viewport.
  const ROW_H = 48, VIEW_H = 560, BUFFER = 6;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);

  const q = filter.trim().toLowerCase();
  const filtered = (list?.transactions ?? []).filter(t =>
    !q || `${t.payee} ${t.account} ${t.category}`.toLowerCase().includes(q));
  const dir = sortDir === 'asc' ? 1 : -1;
  const rows = [...filtered].sort((a, b) =>
    sortBy === 'amount' ? (a.amount - b.amount) * dir : (a.date.localeCompare(b.date) || (a.postedAt - b.postedAt)) * dir);
  // In / Out by sign (Transfers already excluded server-side).
  const inflow = filtered.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const outflow = filtered.filter(t => t.amount < 0).reduce((s, t) => s + -t.amount, 0);

  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - BUFFER);
  const end = Math.min(rows.length, Math.ceil((scrollTop + VIEW_H) / ROW_H) + BUFFER);
  const visible = rows.slice(start, end).map((t, i) => ({ t, idx: start + i }));

  function toggleSort(col: 'date' | 'amount') {
    if (sortBy === col) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortBy(col); setSortDir('desc'); }
  }
  const arrow = (col: 'date' | 'amount') => (sortBy === col ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '');
  const selStyle = { background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', fontSize: 13, padding: '5px 10px', cursor: 'pointer' };

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: 15, fontWeight: 600 }}>
          {range === 'all' ? 'All transactions' : fmtMonth(range)}
          <span style={{ color: 'var(--muted)', fontWeight: 400 }}> · {loading ? '…' : `${rows.length} transaction${rows.length === 1 ? '' : 's'}`}</span>
        </h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={range} onChange={e => setRange(e.target.value)} style={selStyle} title="Time period">
            <option value="all">All time</option>
            {months.map(m => <option key={m} value={m}>{fmtMonth(m)}</option>)}
          </select>
          <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter merchant / account / category"
            style={{ flex: '0 1 260px', padding: '5px 10px', fontSize: 13 }} />
        </div>
      </div>
      <p style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 10 }}>In {money(inflow)} · Out {money(outflow)}</p>
      <div style={{ display: 'grid', gridTemplateColumns: '70px 1fr 130px 140px 100px', gap: 8, fontSize: 11, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, paddingBottom: 6, borderBottom: '1px solid var(--border)' }}>
        <span onClick={() => toggleSort('date')} style={{ cursor: 'pointer', userSelect: 'none', color: sortBy === 'date' ? 'var(--text)' : undefined }} title="Sort by date">Date{arrow('date')}</span>
        <span>Merchant</span><span>Account</span><span>Category</span>
        <span onClick={() => toggleSort('amount')} style={{ textAlign: 'right', cursor: 'pointer', userSelect: 'none', color: sortBy === 'amount' ? 'var(--text)' : undefined }} title="Sort by amount">Amount{arrow('amount')}</span>
      </div>
      <div ref={scrollRef} onScroll={e => setScrollTop(e.currentTarget.scrollTop)} style={{ maxHeight: VIEW_H, overflowY: 'auto', position: 'relative' }}>
        <div style={{ height: rows.length * ROW_H, position: 'relative' }}>
          {visible.map(({ t, idx }) => {
            const excluded = t.category === 'Mortgage';
            return (
              <div key={t.id} onClick={() => openTxnDetail(txnToDetail(t))} title="Click for details"
                style={{ position: 'absolute', top: idx * ROW_H, left: 0, right: 0, height: ROW_H, boxSizing: 'border-box', display: 'grid', gridTemplateColumns: '70px 1fr 130px 140px 100px', gap: 8, alignItems: 'center', fontSize: 13, borderBottom: '1px solid var(--border)', opacity: excluded ? 0.5 : 1, cursor: 'pointer' }}>
                <span style={{ color: 'var(--muted)', fontSize: 12 }}>{shortDate(t.date)}</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <MerchantIcon merchant={t.merchant} label={t.payee} size={24} />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.payee}</span>
                      {excluded && <span style={{ flexShrink: 0, fontSize: 9, color: 'var(--muted)', border: '1px solid var(--border)', borderRadius: 9, padding: '0px 6px', textTransform: 'uppercase', letterSpacing: 0.4 }}>excluded</span>}
                    </span>
                    {t.description && t.description.toLowerCase() !== t.payee.toLowerCase() && (
                      <span style={{ display: 'block', fontSize: 10, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'ui-monospace, SFMono-Regular, monospace' }} title={t.description}>{t.description}</span>
                    )}
                  </span>
                </span>
                <span style={{ color: 'var(--muted)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.account}>{t.account}</span>
                <span onClick={stop}>
                  <CategoryPicker value={t.category} options={cats} groups={groups} suggested={t.suggested} compact
                    onChange={c => onRecategorize(t.merchant, c, { payee: t.payee, description: t.description, amount: t.amount })} onCreate={n => onCreateCategory(t.merchant, n)} />
                </span>
                <span style={{ textAlign: 'right', color: t.amount > 0 ? 'var(--green)' : 'var(--text)' }}>{money(t.amount)}</span>
              </div>
            );
          })}
        </div>
        {!loading && rows.length === 0 && <p style={{ color: 'var(--muted)', fontSize: 13, padding: '10px 0' }}>No transactions.</p>}
        {loading && <p style={{ color: 'var(--muted)', fontSize: 13, padding: '10px 0' }}>Loading…</p>}
      </div>
    </div>
  );
}

function CategoryRow({ cat, open, onToggle, txns, cats, groups, money, onRecategorize, onCreateCategory, onSaveTarget }: {
  cat: CatRow; open: boolean; onToggle: () => void; txns: BudgetTxn[]; cats: string[]; groups: PickerGroup[];
  money: (n: number) => string; onRecategorize: (m: string, c: string, ctx?: { payee: string; description: string; amount: number }) => void; onCreateCategory: (m: string, name: string) => void; onSaveTarget: (c: string, n: number, period: 'monthly' | 'annual') => void;
}) {
  const [targetDraft, setTargetDraft] = useState(String(cat.target || ''));
  const [period, setPeriod] = useState<'monthly' | 'annual'>(cat.period ?? 'monthly');
  const isAnnual = cat.period === 'annual';
  // Annual budgets track year-to-date spend; monthly budgets track the month.
  const periodSpent = isAnnual ? (cat.ytdSpent ?? 0) : cat.spent;
  const pct = cat.target ? Math.min(100, (periodSpent / cat.target) * 100) : 0;
  const excluded = !!cat.excluded;

  return (
    <div style={{ marginBottom: 12, opacity: excluded ? 0.55 : 1 }}>
      <div onClick={onToggle} style={{ cursor: 'pointer' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
          <span>
            <span style={{ display: 'inline-block', width: 12, opacity: 0.6 }}>{open ? '▾' : '▸'}</span>
            {cat.category} <span style={{ color: 'var(--muted)', fontSize: 11 }}>({cat.count})</span>
            {isAnnual && <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--accent)', border: '1px solid var(--accent)', borderRadius: 10, padding: '1px 7px', textTransform: 'uppercase', letterSpacing: 0.4 }}>annual</span>}
            {excluded && <span style={{ marginLeft: 8, fontSize: 10, color: 'var(--muted)', border: '1px solid var(--border)', borderRadius: 10, padding: '1px 7px', textTransform: 'uppercase', letterSpacing: 0.4 }}>excluded</span>}
          </span>
          <span style={{ color: 'var(--muted)' }}>
            {money(periodSpent)}{!excluded && cat.target ? ` / ${money(cat.target)}${isAnnual ? '/yr' : ''}` : ''}
            {/* Non-color cue: spell out budget usage so it doesn't rely on bar color alone. */}
            {!excluded && cat.target > 0 && (() => {
              const ratio = periodSpent / cat.target;
              const over = periodSpent > cat.target;
              return (
                <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 600, color: barColor(periodSpent, cat.target) }}>
                  {over ? `${Math.round((ratio - 1) * 100)}% over` : `${Math.round(ratio * 100)}% used`}
                </span>
              );
            })()}
          </span>
        </div>
        <div style={{ height: 7, background: 'var(--bg)', borderRadius: 4, overflow: 'hidden' }}>
          <div style={{ width: excluded || !cat.target ? '100%' : `${pct}%`, height: '100%', background: excluded ? 'var(--muted)' : barColor(periodSpent, cat.target), opacity: excluded || !cat.target ? 0.3 : 1 }} />
        </div>
      </div>
      {open && (
        <div style={{ margin: '8px 0 4px 18px', paddingLeft: 10, borderLeft: '2px solid var(--border)' }}>
          {excluded ? (
            <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
              Excluded from budgeting totals — shown for reference only.
            </p>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, fontSize: 12, flexWrap: 'wrap' }}>
              <span style={{ color: 'var(--muted)' }}>Budget:</span>
              <input value={targetDraft} onChange={e => setTargetDraft(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') onSaveTarget(cat.category, parseFloat(targetDraft) || 0, period); }}
                placeholder="0" style={{ width: 76, padding: '3px 6px', fontSize: 12 }} />
              <select value={period} onChange={e => setPeriod(e.target.value as 'monthly' | 'annual')}
                style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', fontSize: 12, padding: '3px 4px', cursor: 'pointer' }}>
                <option value="monthly">/ month</option>
                <option value="annual">/ year</option>
              </select>
              <button className="btn-primary" style={{ fontSize: 11, padding: '3px 8px' }}
                onClick={() => onSaveTarget(cat.category, parseFloat(targetDraft) || 0, period)}>Save</button>
            </div>
          )}
          {!excluded && isAnnual && cat.target > 0 && (
            <p style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8 }}>
              {money(cat.ytdSpent ?? 0)} spent this year · {money(cat.spent)} this month
            </p>
          )}
          {txns.length === 0 && <p style={{ fontSize: 12, color: 'var(--muted)' }}>No transactions.</p>}
          {txns.map(t => (
            <div key={t.id} onClick={() => openTxnDetail(txnToDetail(t))} title="Click for details"
              style={{ display: 'grid', gridTemplateColumns: '52px 1fr 80px 130px', gap: 8, alignItems: 'center', fontSize: 12, padding: '4px 0', cursor: 'pointer' }}>
              <span style={{ color: 'var(--muted)' }}>{t.date.slice(5)}</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }} title={t.account}>
                <MerchantIcon merchant={t.merchant} label={t.payee} size={20} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.payee}</span>
              </span>
              <span style={{ textAlign: 'right' }}>{money(t.amount)}</span>
              <span onClick={stop}>
                <CategoryPicker value={t.category} options={cats} groups={groups} suggested={t.suggested} compact
                  onChange={c => onRecategorize(t.merchant, c, { payee: t.payee, description: t.description, amount: t.amount })} onCreate={n => onCreateCategory(t.merchant, n)} />
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
