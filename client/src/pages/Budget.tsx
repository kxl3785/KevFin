import { useState, useRef, useEffect } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { useApi } from '../hooks/useApi.ts';
import { usePersistentState } from '../hooks/usePersistentState.ts';
import TopNav, { type View } from '../components/TopNav.tsx';
import Recurring from './Recurring.tsx';
import MerchantIcon from '../components/MerchantIcon.tsx';
import CategoryPicker, { type PickerGroup } from '../components/CategoryPicker.tsx';
import CashFlowSankey from '../components/CashFlowSankey.tsx';
import CashFlowTrend from '../components/CashFlowTrend.tsx';
import ReviewWizard from '../components/ReviewWizard.tsx';
import RuleSuggestModal, { type RuleCtx } from '../components/RuleSuggestModal.tsx';
import { TransactionDetailProvider, openTxnDetail, type TxnDetail } from '../components/TransactionDetail.tsx';

interface BudgetTxn { id: string; date: string; amount: number; payee: string; account: string; merchant: string; category: string; suggested: string; description: string; memo: string; postedAt: number; transactedAt: number | null; flipped?: boolean }
interface CatRow { category: string; spent: number; count: number; target: number; period?: 'monthly' | 'annual'; ytdSpent?: number; excluded?: boolean }
interface BudgetData {
  months: string[]; month: string; transactions: BudgetTxn[]; byCategory: CatRow[];
  needsReview: BudgetTxn[]; recent: BudgetTxn[]; income: number; spending: number; mortgage: number; totalBudget: number; categories: string[]; groups: PickerGroup[];
  comparison: { priorMonth: number | null; priorYearAvg: number | null };
  dailyCumulative: { day: number; current: number | null; prior: number | null }[];
  importedCount: number;
  importedPending: number;
}
interface ImportedTxn { id: string; date: string; amount: number; payee: string; account: string; category: string | null; accepted: boolean }

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
  const [subTab, setSubTab] = useState<'overview' | 'transactions' | 'recurring' | 'cashflow' | 'sankey'>('overview');
  const [txnFilter, setTxnFilter] = useState('');
  // The All-transactions period, lifted here so the overview's Spent / comparison
  // cards can deep-link straight to a given month's transactions.
  const [txnRange, setTxnRange] = usePersistentState<string>('mon.txnRange', 'all');
  // Jump to the transactions tab scoped to a specific month (clears any filter).
  function viewMonthTxns(m: string) { setTxnRange(m); setTxnFilter(''); setSubTab('transactions'); }
  const [openCat, setOpenCat] = useState<string | null>(null);
  const [compareMode, setCompareMode] = usePersistentState<'priorMonth' | 'priorYearAvg'>('mon.budgetCompareMode', 'priorMonth');
  const [manageOpen, setManageOpen] = useState(false);
  const [newCat, setNewCat] = useState('');
  // Snapshot of category state captured when the manage panel opens, so "Undo
  // changes" can roll back everything done while it was open. null = nothing to undo.
  const [catSnapshot, setCatSnapshot] = useState<unknown>(null);
  const [catBusy, setCatBusy] = useState(false);
  const [groupNames, setGroupNames] = useState<string[]>([]);
  // For budgeting we show the top categories only; the user can hide any of them
  // and insert others (incl. zero-spend ones). Persisted as display-name lists.
  const [hiddenCats, setHiddenCats] = usePersistentState<string[]>('mon.budgetHiddenCats', []);
  const [extraCats, setExtraCats] = usePersistentState<string[]>('mon.budgetExtraCats', []);
  const TOP_N = 10;
  const [reviewOpen, setReviewOpen] = useState(false);
  const [importMsg, setImportMsg] = useState('');
  const [importedOpen, setImportedOpen] = useState(false);
  const [importedList, setImportedList] = useState<ImportedTxn[]>([]);
  const [ruleMsg, setRuleMsg] = useState('');
  const ruleMsgTimer = useRef(0);
  const [backTo, setBackTo] = useState<View | null>(null); // set when arriving via a deep-link, for the "← Back" control
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
      const dl = JSON.parse(raw) as { tab?: typeof subTab; filter?: string; from?: View };
      if (dl.tab) setSubTab(dl.tab);
      if (dl.filter != null) setTxnFilter(dl.filter);
      if (dl.from) setBackTo(dl.from);
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

  // Reverse the +/- sign for a merchant (applies to past & future transactions),
  // e.g. a payment that posts as a positive credit but is really money out.
  async function flipSign(merchant: string, payee?: string) {
    const r = await fetch('/api/budget/sign', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ merchant }) });
    const d = await r.json().catch(() => ({} as { flipped?: boolean }));
    refetch();
    setRecatVersion(v => v + 1);
    toast(d?.flipped ? `↹ Reversed sign for ${payee || merchant} (past & future)` : `↹ Restored original sign for ${payee || merchant}`);
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
  // Open/close the manage panel. Opening snapshots the current category state so
  // edits made while open can be undone in one click, and loads the group list.
  async function openManage() {
    setManageOpen(true);
    try { setCatSnapshot(await (await fetch('/api/budget/categories/state')).json()); }
    catch { setCatSnapshot(null); }
    try { setGroupNames(await (await fetch('/api/budget/categories/groups')).json()); }
    catch { /* keep prior */ }
  }
  // Reclassify a category into another group, or reorder it within its group.
  async function setCatGroup(canonical: string, group: string) {
    await fetch(`/api/budget/category/${encodeURIComponent(canonical)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ group }) });
    refetch(); setRecatVersion(v => v + 1);
  }
  // Roll back every category change made since the panel was opened.
  async function undoCats() {
    if (catSnapshot == null) return;
    setCatBusy(true);
    try {
      await fetch('/api/budget/categories/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(catSnapshot) });
      refetch(); setRecatVersion(v => v + 1); toast('↩ Reverted category changes');
    } finally { setCatBusy(false); }
  }
  // Reset the whole taxonomy to the built-in defaults (still undoable via the snapshot).
  async function resetCats() {
    if (!confirm('Reset all categories, names and emojis to defaults? Custom categories will be removed (their transactions fall back to auto-categorization).')) return;
    setCatBusy(true);
    try {
      await fetch('/api/budget/categories/reset', { method: 'POST' });
      refetch(); setRecatVersion(v => v + 1); toast('⟲ Categories reset to defaults');
    } finally { setCatBusy(false); }
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
  // Recategorize a single imported row (updates the budget once merged).
  async function recatImported(id: string, category: string) {
    await fetch(`/api/budget/imported/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ category }) });
    setImportedList(l => l.map(t => (t.id === id ? { ...t, category } : t)));
    refetch(); setRecatVersion(v => v + 1);
  }
  // Mark imported rows reviewed — one by id, or all pending when omitted.
  async function acceptImported(id?: string) {
    await fetch('/api/budget/imported/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
    setImportedList(l => l.map(t => (!id || t.id === id ? { ...t, accepted: true } : t)));
    refetch(); // refresh importedPending so the panel can collapse once closed
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
  // Group options for the reclassify dropdown (server list, or names in use).
  const groupOpts = groupNames.length ? groupNames : groups.map(g => g.name);

  // The category rows to actually show for budgeting: the top N by spend (already
  // sorted server-side), minus any the user hid, plus any they explicitly inserted
  // (synthesised at $0 when they have no spend/target this month). Excluded rows
  // like Mortgage always tag along.
  const byCat = data?.byCategory ?? [];
  const ranked = byCat.filter(c => !c.excluded && !hiddenCats.includes(c.category));
  const topCats = ranked.slice(0, TOP_N);
  const shownNames = new Set(topCats.map(c => c.category));
  for (const name of extraCats) {
    if (shownNames.has(name) || hiddenCats.includes(name)) continue;
    const existing = byCat.find(c => c.category === name);
    topCats.push(existing ?? { category: name, spent: 0, count: 0, target: 0 });
    shownNames.add(name);
  }
  const excludedRows = byCat.filter(c => c.excluded && !hiddenCats.includes(c.category));
  for (const r of excludedRows) if (!shownNames.has(r.category)) { topCats.push(r); shownNames.add(r.category); }
  // Categories not currently shown (hidden or zero-spend), offered for insertion.
  const insertable = cats.filter(c => !shownNames.has(c));
  function hideCat(name: string) { setExtraCats(x => x.filter(c => c !== name)); setHiddenCats(h => (h.includes(name) ? h : [...h, name])); }
  function insertCat(name: string) { setHiddenCats(h => h.filter(c => c !== name)); setExtraCats(x => (x.includes(name) ? x : [...x, name])); }

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
      {backTo && (
        <button className="btn-ghost" onClick={() => onNavigate(backTo)} style={{ fontSize: 13, marginBottom: 12 }}
          title={`Return to the ${backTo} page where you were`}>
          ← Back to {backTo.charAt(0).toUpperCase() + backTo.slice(1)}
        </button>
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h1 style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.5px' }}>Budget</h1>
        {(subTab === 'overview' || subTab === 'transactions') && (
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
        {(['overview', 'transactions', 'recurring', 'cashflow', 'sankey'] as const).map(t => (
          <button key={t} onClick={() => setSubTab(t)}
            style={{ background: 'transparent', color: subTab === t ? 'var(--text)' : 'var(--muted)', fontWeight: subTab === t ? 600 : 400, fontSize: 14, padding: '6px 2px', borderBottom: subTab === t ? '2px solid var(--accent)' : '2px solid transparent' }}>
            {t === 'overview' ? 'Overview' : t === 'transactions' ? 'Transactions' : t === 'recurring' ? 'Recurring' : t === 'cashflow' ? 'Cash Flow' : 'Sankey'}
          </button>
        ))}
      </div>

      {(subTab === 'overview' || subTab === 'transactions') && loading && <p style={{ color: 'var(--muted)' }}>Loading…</p>}
      {(subTab === 'overview' || subTab === 'transactions') && error && <p style={{ color: 'var(--red)' }}>Failed to load: {error}</p>}

      {subTab === 'cashflow' && (
        <CashFlowTrend privacy={privacy} version={recatVersion} />
      )}

      {subTab === 'sankey' && (
        <CashFlowSankey privacy={privacy} cats={cats} groups={groups}
          onRecategorize={recategorize} onCreateCategory={categorizeNew} version={recatVersion} />
      )}

      {subTab === 'transactions' && (
        <TransactionsView money={money} cats={cats} groups={groups} filter={txnFilter} setFilter={setTxnFilter} range={txnRange} setRange={setTxnRange} onRecategorize={recategorize} onCreateCategory={categorizeNew} onFlipSign={flipSign} version={recatVersion} />
      )}

      {data && subTab === 'overview' && (
        <>
          {/* Summary: Spent vs a prior-period comparison */}
          <div className="stack-mobile" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
            <div onClick={() => viewMonthTxns(data.month)}
              title={`View ${fmtMonth(data.month)} transactions`}
              style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 18px', cursor: 'pointer' }}>
              <p style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 4 }}>Spent · {fmtMonth(data.month)}</p>
              <p style={{ fontSize: 22, fontWeight: 700, color: 'var(--amber)' }}>{money(data.spending)}</p>
              {data.mortgage > 0 && (
                <p style={{ color: 'var(--muted)', fontSize: 11, marginTop: 6 }}>
                  + {money(data.mortgage)} mortgage (excluded · see Recurring tab)
                </p>
              )}
            </div>
            <div
              onClick={() => { const tgt = compareMode === 'priorMonth' ? addMonths(data.month, -1) : addMonths(data.month, -12); if (data.months.includes(tgt)) viewMonthTxns(tgt); }}
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
              <button onClick={() => (manageOpen ? setManageOpen(false) : openManage())} style={{ background: 'transparent', color: 'var(--accent)', fontSize: 12 }}>
                {manageOpen ? '✓ Save' : '⚙ Manage categories'}
              </button>
            </div>
            {manageOpen && (
              <div style={{ background: 'var(--bg)', borderRadius: 8, padding: 12, marginBottom: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                  <p style={{ fontSize: 11, color: 'var(--muted)' }}>Grouped by area, sorted A–Z. Rename inline, pick a group to reclassify, or × to remove — changes apply across transactions, charts and the cash-flow Sankey.</p>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <button className="btn-ghost" disabled={catBusy || catSnapshot == null} onClick={undoCats}
                      title="Revert every change made since you opened this panel" style={{ fontSize: 11, padding: '4px 9px' }}>↩ Undo changes</button>
                    <button className="btn-ghost" disabled={catBusy} onClick={resetCats}
                      title="Restore the built-in categories, names and emojis" style={{ fontSize: 11, padding: '4px 9px' }}>⟲ Reset to default</button>
                  </div>
                </div>
                <div style={{ marginBottom: 12 }}>
                  {groups.map(g => (
                    <div key={g.name} style={{ marginBottom: 10 }}>
                      <p style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>
                        <span style={{ width: 8, height: 8, borderRadius: 2, background: g.color ?? 'var(--muted)', flexShrink: 0 }} />
                        {g.name}
                      </p>
                      <div style={{ paddingLeft: 14 }}>
                        {g.categories.map(c => {
                          const canon = c.canonical ?? c.name;
                          return (
                            <div key={canon} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '2px 0' }}>
                              <span style={{ width: 20, textAlign: 'center', flexShrink: 0 }}>{c.emoji}</span>
                              <input defaultValue={c.name}
                                onBlur={e => { const v = e.target.value.trim(); if (v && v !== c.name && c.canonical) renameCat(c.canonical, v); }}
                                onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                                style={{ flex: 1, minWidth: 0, padding: '3px 6px', fontSize: 12, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)' }} />
                              <select value={g.name} onChange={e => setCatGroup(canon, e.target.value)} title="Reclassify into another group"
                                style={{ flexShrink: 0, maxWidth: 104, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--muted)', fontSize: 11, padding: '3px 4px', cursor: 'pointer' }}>
                                {(groupOpts.includes(g.name) ? groupOpts : [g.name, ...groupOpts]).map(gn => <option key={gn} value={gn}>{gn}</option>)}
                              </select>
                              {!PROTECTED.has(canon) && (
                                <span onClick={() => removeCat(canon)} title="Remove" style={{ cursor: 'pointer', color: 'var(--red)', fontWeight: 700, flexShrink: 0 }}>×</span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input value={newCat} onChange={e => setNewCat(e.target.value)} placeholder="New category name"
                    onKeyDown={e => { if (e.key === 'Enter') addCat(); }} style={{ flex: 1, padding: '5px 8px', fontSize: 13 }} />
                  <button className="btn-primary" style={{ fontSize: 12 }} onClick={addCat}>+ Add</button>
                </div>
                <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>New categories get an auto-picked emoji. Removing one lets its transactions fall back to auto-categorization (re-add it any time).</p>
              </div>
            )}
            {topCats.length === 0 && <p style={{ fontSize: 13, color: 'var(--muted)' }}>No categories to show. Insert one below.</p>}
            {topCats.map(c => (
              <CategoryRow key={c.category} cat={c} open={openCat === c.category}
                onToggle={() => setOpenCat(o => (o === c.category ? null : c.category))}
                txns={data.transactions.filter(t => t.category === c.category)}
                cats={cats} groups={groups} money={money} onRecategorize={recategorize} onCreateCategory={categorizeNew} onSaveTarget={saveTarget}
                onHide={() => hideCat(c.category)} />
            ))}
            {/* Insert a category to budget (hidden ones, or any with no spend yet). */}
            {insertable.length > 0 && (
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, color: 'var(--muted)', flexShrink: 0 }}>Add category:</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <CategoryPicker value="" placeholder="Insert a category…" options={insertable} groups={groups}
                    onChange={insertCat} />
                </span>
              </div>
            )}
          </div>

          {/* Recent transactions square (other half) */}
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 20 }}>
            <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Recent transactions</h2>
            {data.recent.length === 0 && <p style={{ fontSize: 13, color: 'var(--muted)' }}>No transactions.</p>}
            {data.recent.map(t => (
              <div key={t.id} onClick={() => openTxnDetail(txnToDetail(t))} title="Click for details"
                style={{ display: 'grid', gridTemplateColumns: '40px 1fr 92px auto', gap: 6, alignItems: 'center', padding: '5px 0', borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
                <span style={{ color: 'var(--muted)', fontSize: 12 }}>{shortDate(t.date)}</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <MerchantIcon merchant={t.merchant} label={t.payee} size={22} />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.payee}</span>
                    {t.description && t.description.toLowerCase() !== t.payee.toLowerCase() && (
                      <span style={{ display: 'block', fontSize: 10, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'ui-monospace, SFMono-Regular, monospace' }} title={t.description}>{t.description}</span>
                    )}
                  </span>
                </span>
                <span onClick={stop} style={{ minWidth: 0 }}>
                  <CategoryPicker value={t.category} options={cats} groups={groups} suggested={t.suggested} compact
                    onChange={c => recategorize(t.merchant, c, { payee: t.payee, description: t.description, amount: t.amount })} onCreate={n => categorizeNew(t.merchant, n)} />
                </span>
                <span style={{ textAlign: 'right', fontSize: 13, color: t.amount > 0 ? 'var(--green)' : 'var(--text)' }}>{money(t.amount)}</span>
              </div>
            ))}
          </div>
          </div>

          {/* Imported data review / clear. Once everything's been accepted, the
              panel collapses to a quiet muted line (still expandable to manage). */}
          {data.importedCount > 0 && (data.importedPending === 0 && !importedOpen ? (
            <div style={{ marginTop: 16, textAlign: 'right' }}>
              <button onClick={toggleImported} title="All imported transactions reviewed — click to manage"
                style={{ background: 'transparent', color: 'var(--muted)', fontSize: 12 }}>
                ▸ {data.importedCount} imported transaction{data.importedCount === 1 ? '' : 's'} · all reviewed ✓
              </button>
            </div>
          ) : (
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 20, marginTop: 20 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <button onClick={toggleImported} style={{ background: 'transparent', color: 'var(--text)', fontSize: 15, fontWeight: 600 }}>
                  {importedOpen ? '▾' : '▸'} Imported transactions ({data.importedCount})
                </button>
                <div style={{ display: 'flex', gap: 8 }}>
                  {importedOpen && importedList.some(t => !t.accepted) && (
                    <button className="btn-primary" style={{ fontSize: 12, padding: '4px 10px' }}
                      onClick={() => acceptImported()} title="Mark every pending imported transaction reviewed">✓ Accept all</button>
                  )}
                  <button className="btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }}
                    onClick={reconcile} title="Remove imported transactions that duplicate your connected bank/card data">⟲ Reconcile duplicates</button>
                  <button className="btn-danger" style={{ fontSize: 12, padding: '4px 10px' }}
                    onClick={() => { if (confirm('Remove all imported transactions?')) clearAllImported(); }}>Clear all</button>
                </div>
              </div>
              {importedOpen && (
                <>
                  <p style={{ color: 'var(--muted)', fontSize: 12, margin: '10px 0 6px' }}>
                    Review the category on each row (fix it if needed), then accept to mark it reviewed.
                  </p>
                  <div style={{ display: 'grid', gridTemplateColumns: '68px 1fr 110px 78px 150px 70px 22px', gap: 8, fontSize: 11, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, paddingBottom: 6, borderBottom: '1px solid var(--border)' }}>
                    <span>Date</span><span>Merchant</span><span>Account</span><span style={{ textAlign: 'right' }}>Amount</span><span>Category</span><span /><span />
                  </div>
                  <div style={{ maxHeight: 360, overflowY: 'auto' }}>
                    {importedList.map(t => (
                      <div key={t.id} onClick={() => openTxnDetail({ payee: t.payee, amount: t.amount, category: t.category ?? undefined, importedCategory: t.category ?? undefined, account: t.account, date: t.date })} title="Click for details"
                        style={{ display: 'grid', gridTemplateColumns: '68px 1fr 110px 78px 150px 70px 22px', gap: 8, alignItems: 'center', fontSize: 12, padding: '5px 0', borderBottom: '1px solid var(--border)', cursor: 'pointer', opacity: t.accepted ? 0.5 : 1 }}>
                        <span style={{ color: 'var(--muted)' }}>{t.date}</span>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.payee}</span>
                        <span style={{ color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.account}</span>
                        <span style={{ textAlign: 'right' }}>{money(t.amount)}</span>
                        <span onClick={stop}>
                          <CategoryPicker value={t.category ?? ''} placeholder="Categorize…" options={cats} groups={groups} compact
                            onChange={c => recatImported(t.id, c)}
                            onCreate={async n => { const res = await fetch('/api/budget/category', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: n }) }); const d = await res.json().catch(() => ({} as { created?: string })); await recatImported(t.id, d?.created || n.trim()); }} />
                        </span>
                        {t.accepted
                          ? <span style={{ color: 'var(--green)', textAlign: 'center', fontSize: 11 }}>✓ Accepted</span>
                          : <button className="btn-ghost" onClick={e => { stop(e); acceptImported(t.id); }} title="Mark reviewed" style={{ fontSize: 11, padding: '3px 8px' }}>Accept</button>}
                        <span onClick={e => { stop(e); removeImported(t.id); }} title="Remove" style={{ cursor: 'pointer', color: 'var(--red)', textAlign: 'center' }}>×</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          ))}
        </>
      )}

      {subTab === 'recurring' && (
        <Recurring embedded onNavigate={onNavigate} privacy={privacy} onTogglePrivacy={onTogglePrivacy} />
      )}
    </div>
    </TransactionDetailProvider>
  );
}

function TransactionsView({ money, cats, groups, filter, setFilter, range, setRange, onRecategorize, onCreateCategory, onFlipSign, version }: {
  money: (n: number) => string; cats: string[]; groups: PickerGroup[];
  filter: string; setFilter: (s: string) => void; range: string; setRange: (s: string) => void;
  onRecategorize: (m: string, c: string, ctx?: { payee: string; description: string; amount: number }) => void; onCreateCategory: (m: string, name: string) => void;
  onFlipSign: (merchant: string, payee?: string) => void;
  version: number;
}) {
  // Period (`range`) is lifted to the parent so the Overview cards can deep-link to
  // a specific month. Re-fetches when a categorization bumps `version`.
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
          {range === 'all' ? 'Transactions' : fmtMonth(range)}
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
      <div style={{ display: 'grid', gridTemplateColumns: '70px 1fr 130px 140px 92px 26px', gap: 8, fontSize: 11, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, paddingBottom: 6, borderBottom: '1px solid var(--border)' }}>
        <span onClick={() => toggleSort('date')} style={{ cursor: 'pointer', userSelect: 'none', color: sortBy === 'date' ? 'var(--text)' : undefined }} title="Sort by date">Date{arrow('date')}</span>
        <span>Merchant</span><span>Account</span><span>Category</span>
        <span onClick={() => toggleSort('amount')} style={{ textAlign: 'right', cursor: 'pointer', userSelect: 'none', color: sortBy === 'amount' ? 'var(--text)' : undefined }} title="Sort by amount">Amount{arrow('amount')}</span>
        <span />
      </div>
      <div ref={scrollRef} onScroll={e => setScrollTop(e.currentTarget.scrollTop)} style={{ maxHeight: VIEW_H, overflowY: 'auto', position: 'relative' }}>
        <div style={{ height: rows.length * ROW_H, position: 'relative' }}>
          {visible.map(({ t, idx }) => {
            const excluded = t.category === 'Mortgage';
            return (
              <div key={t.id} onClick={() => openTxnDetail(txnToDetail(t))} title="Click for details"
                style={{ position: 'absolute', top: idx * ROW_H, left: 0, right: 0, height: ROW_H, boxSizing: 'border-box', display: 'grid', gridTemplateColumns: '70px 1fr 130px 140px 92px 26px', gap: 8, alignItems: 'center', fontSize: 13, borderBottom: '1px solid var(--border)', opacity: excluded ? 0.5 : 1, cursor: 'pointer' }}>
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
                <span onClick={e => { stop(e); onFlipSign(t.merchant, t.payee); }}
                  title={t.flipped ? 'Sign reversed for this merchant — click to restore' : 'Reverse +/- sign for this merchant (applies to past & future)'}
                  style={{ cursor: 'pointer', textAlign: 'center', fontSize: 13, lineHeight: 1, color: t.flipped ? 'var(--accent)' : 'var(--muted)', fontWeight: t.flipped ? 700 : 400 }}>⇄</span>
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

function CategoryRow({ cat, open, onToggle, txns, cats, groups, money, onRecategorize, onCreateCategory, onSaveTarget, onHide }: {
  cat: CatRow; open: boolean; onToggle: () => void; txns: BudgetTxn[]; cats: string[]; groups: PickerGroup[];
  money: (n: number) => string; onRecategorize: (m: string, c: string, ctx?: { payee: string; description: string; amount: number }) => void; onCreateCategory: (m: string, name: string) => void; onSaveTarget: (c: string, n: number, period: 'monthly' | 'annual') => void;
  onHide?: () => void;
}) {
  const [targetDraft, setTargetDraft] = useState(String(cat.target || ''));
  const [period, setPeriod] = useState<'monthly' | 'annual'>(cat.period ?? 'monthly');
  const isAnnual = cat.period === 'annual';
  // Annual budgets track year-to-date spend; monthly budgets track the month.
  const periodSpent = isAnnual ? (cat.ytdSpent ?? 0) : cat.spent;
  const pct = cat.target ? Math.min(100, (periodSpent / cat.target) * 100) : 0;
  const excluded = !!cat.excluded;

  return (
    <div style={{ marginBottom: 12, opacity: excluded ? 0.55 : 1 }} className="cat-row">
      <div onClick={onToggle} style={{ cursor: 'pointer' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, marginBottom: 4 }}>
          <span>
            <span style={{ display: 'inline-block', width: 12, opacity: 0.6 }}>{open ? '▾' : '▸'}</span>
            {cat.category} <span style={{ color: 'var(--muted)', fontSize: 11 }}>({cat.count})</span>
            {isAnnual && <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--accent)', border: '1px solid var(--accent)', borderRadius: 10, padding: '1px 7px', textTransform: 'uppercase', letterSpacing: 0.4 }}>annual</span>}
            {excluded && <span style={{ marginLeft: 8, fontSize: 10, color: 'var(--muted)', border: '1px solid var(--border)', borderRadius: 10, padding: '1px 7px', textTransform: 'uppercase', letterSpacing: 0.4 }}>excluded</span>}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--muted)' }}>
            <span>
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
            {onHide && (
              <span onClick={e => { e.stopPropagation(); onHide(); }} title="Hide from budget list" className="cat-hide"
                style={{ cursor: 'pointer', fontSize: 12, lineHeight: 1, padding: '0 2px' }}>🚫</span>
            )}
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
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.payee}</span>
                  {t.description && t.description.toLowerCase() !== t.payee.toLowerCase() && (
                    <span style={{ display: 'block', fontSize: 10, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'ui-monospace, SFMono-Regular, monospace' }} title={t.description}>{t.description}</span>
                  )}
                </span>
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
