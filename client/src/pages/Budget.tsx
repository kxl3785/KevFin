import { useState, useRef, useEffect } from 'react';
import { useApi } from '../hooks/useApi.ts';
import { usePersistentState } from '../hooks/usePersistentState.ts';
import TopNav, { type View } from '../components/TopNav.tsx';
import Recurring from './Recurring.tsx';
import MerchantIcon from '../components/MerchantIcon.tsx';
import CategoryPicker from '../components/CategoryPicker.tsx';
import CashFlowSankey from '../components/CashFlowSankey.tsx';
import CashFlowTrend from '../components/CashFlowTrend.tsx';
import RulesManager from '../components/RulesManager.tsx';
import ReviewWizard from '../components/ReviewWizard.tsx';
import RuleSuggestModal, { type RuleCtx } from '../components/RuleSuggestModal.tsx';
import { BUDGET_IMPORTED_EVENT } from '../components/DocImport.tsx';
import { TransactionDetailProvider, openTxnDetail } from '../components/TransactionDetail.tsx';
import MonthPicker from '../components/budget/MonthPicker.tsx';
import BudgetKpis, { type CompareMode, type PeriodLabels } from '../components/budget/BudgetKpis.tsx';
import SpendingPaceChart from '../components/budget/SpendingPaceChart.tsx';
import CategoryList from '../components/budget/CategoryList.tsx';
import LatestTransactions from '../components/budget/LatestTransactions.tsx';
import CategoryManager from '../components/budget/CategoryManager.tsx';
import TransactionsView from '../components/budget/TransactionsView.tsx';
import { txnToDetail, txnRowLabel, stop, type BudgetData, type RecatCtx } from '../components/budget/types.ts';
import { fmtMoney, fmtMonth as fmtMonthShort } from '../lib/format.ts';
import { fmtTxnDate, rowProps } from '../lib/budgetUi.ts';
import { monthLong, resolveBudgetTab, NO_FILTERS, type BudgetTab, type CashView, type TxnFilters } from '../lib/budgetView.ts';

interface ImportedTxn { id: string; date: string; amount: number; payee: string; account: string; category: string | null; accepted: boolean }

const monthName = (ym: string) => new Date(ym + '-01T00:00:00').toLocaleString('en-US', { month: 'short' });
const daysIn = (ym: string) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
const monthStart = (ym: string) => `${ym}-01`;
// The browser's local date (YYYY-MM-DD). Sent with the budget request so the
// server's "today" (pace, per-day figure, same-day comparisons) is the user's
// day, not the UTC one, which in a US evening is already tomorrow.
const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
function addMonths(ym: string, delta: number) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
}

// Labels that spell out exactly which periods the Overview compares. For the
// in-progress month both sides are measured through the same day ("Oct 1–24" vs
// "Sep 1–24"), so a partial month is never set against a whole one.
function periodLabels(d: BudgetData): PeriodLabels {
  const cur = d.month, prev = addMonths(cur, -1);
  const partial = d.asOfDay != null;
  const curRange = partial ? `${monthName(cur)} 1–${d.asOfDay}` : '';
  const spent = partial ? curRange : fmtMonthShort(monthStart(cur));
  const prevLabel = partial ? `${monthName(prev)} 1–${Math.min(d.asOfDay!, daysIn(prev))}` : fmtMonthShort(monthStart(prev));
  const yrs = d.comparison.priorYears;
  const span = yrs.length > 1 ? `${yrs[0]}–${yrs[yrs.length - 1]}` : String(yrs[0]);
  const when = partial ? `${curRange},` : monthName(cur);
  const yearLabel = !yrs.length ? 'prior years (no data)'
    : yrs.length === 1 ? `${when} ${span}`
    : `avg of ${when} ${span}`;
  return { spent, prevLabel, yearLabel, curName: fmtMonthShort(monthStart(cur)), prevName: fmtMonthShort(monthStart(prev)) };
}

const TABS: { key: BudgetTab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'transactions', label: 'Transactions' },
  { key: 'recurring', label: 'Recurring' },
  { key: 'cashflow', label: 'Cash flow' },
];

// The Budget page: one month picker in the header drives every sub-tab that
// shows a single month (Overview, Transactions, the by-month cash-flow chart and
// the flow diagram's "Month" range). Four sub-tabs plus "Categories & rules" for
// set-up; the pieces live in components/budget/*.
export default function Budget({ onNavigate, privacy, onTogglePrivacy }: {
  onNavigate: (v: View) => void; privacy: boolean; onTogglePrivacy: () => void;
}) {
  const [month, setMonthRaw] = useState(''); // '' → the latest month with data
  const [subTab, setSubTab] = useState<BudgetTab>('overview');
  // Cash flow's two views, and the flow diagram's span ('month' = the header month).
  const [cashView, setCashView] = usePersistentState<CashView>('mon.budgetCashView', 'month');
  const [flowRangeRaw, setFlowRange] = usePersistentState<string>('mon.cashflowRange', '12m');
  const flowRange = flowRangeRaw === '1m' ? 'month' : flowRangeRaw; // the old "This month" key
  const [setupView, setSetupView] = useState<'rules' | 'categories'>('rules');
  // Transactions follow the header month unless "All time" is on.
  const [txnAllTime, setTxnAllTime] = usePersistentState<boolean>('mon.txnAllTime', false);
  const [txnFilters, setTxnFilters] = useState<TxnFilters>(NO_FILTERS);
  // Picking a month anywhere (the header, a cash-flow bar, a tile) also brings
  // Transactions back from "All time" to that month.
  function setMonth(m: string) { setMonthRaw(m); setTxnAllTime(false); }
  // Jump to the transactions tab scoped to a specific month (clears any filter).
  function viewMonthTxns(m: string) { setMonth(m); setTxnFilters(NO_FILTERS); setSubTab('transactions'); }
  const [compareMode, setCompareMode] = usePersistentState<CompareMode>('mon.budgetCompareMode', 'priorMonth');
  // For budgeting we show the top categories only; the user can hide any of them
  // and insert others (incl. zero-spend ones). Persisted as display-name lists.
  const [hiddenCats, setHiddenCats] = usePersistentState<string[]>('mon.budgetHiddenCats', []);
  const [extraCats, setExtraCats] = usePersistentState<string[]>('mon.budgetExtraCats', []);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [importMsg, setImportMsg] = useState('');
  const [importedOpen, setImportedOpen] = useState(false);
  const [importedList, setImportedList] = useState<ImportedTxn[]>([]);
  const [ruleMsg, setRuleMsg] = useState('');
  const ruleMsgTimer = useRef(0);
  const catsRef = useRef<HTMLDivElement>(null);
  const [backTo, setBackTo] = useState<View | null>(null); // set when arriving via a deep-link, for the "← Back" control
  // After categorizing, offer smart rules (merchant / amount / text) to apply to
  // other and future transactions.
  const [ruleCtx, setRuleCtx] = useState<RuleCtx | null>(null);
  const [recatVersion, setRecatVersion] = useState(0); // bumps the Sankey to re-fetch after a categorization

  // Deep-link from another page (e.g. Forecast category rows): open a tab,
  // optionally with the transactions search pre-filled. Consumed once. Links
  // naming the old tabs (cashflow, sankey, rules) land on their new homes.
  // The category manager's undo point. Held here, not in the panel: the panel
  // unmounts whenever you switch to Rules or another sub-tab, and re-taking the
  // snapshot on its return made "Undo changes" quietly do nothing.
  const [catSnapshot, setCatSnapshot] = useState<unknown>(null);
  // On a phone the tab row scrolls sideways; keep the selected tab in view so
  // "Categories & rules" isn't selected off-screen with nothing looking active.
  const tabsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    tabsRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [subTab]);
  useEffect(() => {
    try {
      const raw = localStorage.getItem('mon.budgetDeepLink');
      if (!raw) return;
      localStorage.removeItem('mon.budgetDeepLink');
      const dl = JSON.parse(raw) as { tab?: string; filter?: string; from?: View };
      const to = resolveBudgetTab(dl.tab);
      if (to) {
        setSubTab(to.tab);
        if (to.cashView) setCashView(to.cashView);
        if (dl.tab === 'rules') setSetupView('rules');
      }
      // A filtered link names a category (the Forecast's spending breakdown) and
      // is about the long run, so it shows that category over all time. It must
      // be the category filter, not a text search: searching "Gas" also matched
      // "Gas & Electric" and every payee with "gas" in its name.
      if (dl.filter != null) { setTxnFilters({ ...NO_FILTERS, category: dl.filter }); setTxnAllTime(true); }
      if (dl.from) setBackTo(dl.from);
    } catch { /* ignore */ }
  }, []);
  const today = localToday();
  const { data: fresh, loading, error, refetch } = useApi<BudgetData>(`/api/budget?${month ? `month=${month}&` : ''}today=${today}`, [month, today]);
  // Keep showing the last month while the next one loads, so stepping the month
  // picker doesn't blank the page (and the picker itself) between months.
  const lastData = useRef<BudgetData | null>(null);
  if (fresh) lastData.current = fresh;
  const data = fresh ?? lastData.current;
  const stale = !fresh && !!data;
  const effMonth = month || data?.month || '';
  // Totals read in whole dollars; individual transactions keep their cents. Negatives use "−$45".
  const money = (n: number) => (privacy ? '••••••' : fmtMoney(n));
  const moneyCents = (n: number) => (privacy ? '••••••' : fmtMoney(n, { cents: true }));

  // Create a new category (server auto-picks an emoji), then assign it to the
  // merchant — used by the "+ Create" action in the category picker. `ctx` (the
  // row's payee, description and amount) feeds the toast and the rule modal, as
  // for a plain pick; callers that only know the merchant (the cash-flow views)
  // leave it out and the merchant key stands in.
  async function categorizeNew(merchant: string, name: string, ctx?: RecatCtx) {
    const res = await fetch('/api/budget/category', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    const d = await res.json().catch(() => ({} as { created?: string }));
    await recategorize(merchant, d?.created || name.trim(), ctx);
  }

  function toast(msg: string) {
    setRuleMsg(msg);
    window.clearTimeout(ruleMsgTimer.current);
    ruleMsgTimer.current = window.setTimeout(() => setRuleMsg(''), 5000);
  }

  // Reverse the +/- sign for a merchant — generalised to a rule matching similar
  // merchants (and future transactions), e.g. a payment that posts as a positive
  // credit but is really money out.
  async function flipSign(merchant: string, payee?: string) {
    const r = await fetch('/api/budget/sign', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ merchant }) });
    const d = await r.json().catch(() => ({} as { flipped?: boolean; matched?: number }));
    refetch();
    setRecatVersion(v => v + 1);
    const n = d?.matched ?? 0;
    toast(d?.flipped
      ? `⇄ Reversed sign for ${payee || merchant} — ${n} transaction${n === 1 ? '' : 's'}, including future ones`
      : `⇄ Restored original sign for ${payee || merchant}`);
  }
  // Categorize just this merchant (scope 'one'), then offer smart rules to apply
  // the same category to other/future transactions (by merchant, amount or text).
  async function recategorize(merchant: string, category: string, ctx?: RecatCtx) {
    try {
      const res = await fetch('/api/budget/rule', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ merchant, category }) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json().catch(() => ({} as { merchantTxns?: number }));
      refetch();
      setRecatVersion(v => v + 1);
      setRuleCtx({ merchant, payee: ctx?.payee ?? merchant, description: ctx?.description, amount: ctx?.amount ?? 0, category });
      // The pick is a merchant-wide rule, not a one-row edit — say how far it reached.
      const n: number = d?.merchantTxns ?? 0;
      const who = ctx?.payee ?? merchant;
      if (n > 0) toast(n === 1 ? `Moved 1 ${who} transaction to ${category}` : `Moved all ${n} ${who} transactions to ${category}`);
    } catch {
      toast('Couldn’t change the category — nothing was changed');
    }
  }
  async function saveTarget(category: string, limit: number, period: 'monthly' | 'annual' = 'monthly') {
    await fetch('/api/budget/target', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ category, limit, period }) });
    refetch();
  }
  // A transaction CSV imported via the top-bar Import button (DocImport) fires this
  // — pull fresh data and open the review queue so the new rows are right there.
  useEffect(() => {
    function onImported() { refetch(); loadImported(); setImportedOpen(true); }
    window.addEventListener(BUDGET_IMPORTED_EVENT, onImported);
    return () => window.removeEventListener(BUDGET_IMPORTED_EVENT, onImported);
  }, [refetch]);
  // Load the imported list (the panel renders from it, so opening without loading is empty).
  async function loadImported() {
    const r = await fetch('/api/budget/imported');
    if (r.ok) setImportedList(await r.json());
  }
  async function toggleImported() {
    if (!importedOpen) await loadImported();
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
  const incomeCats = new Set(groups.find(g => g.name === 'Income')?.categories.map(c => c.name) ?? []);
  const reviewTotal = (data?.needsReview ?? []).reduce((s, t) => s + Math.abs(t.amount), 0);
  const lbl = data ? periodLabels(data) : null;
  const changed = () => { refetch(); setRecatVersion(v => v + 1); };

  // The header month picker shows only where it changes what's on screen: not on
  // Recurring or set-up, and on the flow diagram only for its "Month" span.
  const showPicker = !!data && (subTab === 'overview' || subTab === 'transactions'
    || (subTab === 'cashflow' && (cashView === 'month' || flowRange === 'month')));
  const loadingMain = (subTab === 'overview' || subTab === 'transactions') && loading && !data;

  return (
    <TransactionDetailProvider privacy={privacy} onChanged={changed}>
    <div className="page" style={{ maxWidth: 1280, margin: '0 auto', padding: '32px 24px' }}>
      {reviewOpen && (
        <ReviewWizard cats={cats} groups={groups} money={money} moneyCents={moneyCents}
          onClose={() => { setReviewOpen(false); refetch(); }}
          onCategorized={changed} />
      )}
      <RuleSuggestModal ctx={ruleCtx} onClose={() => setRuleCtx(null)}
        onApplied={m => { changed(); if (m > 0) toast(`✨ Categorized ${m} transaction${m === 1 ? '' : 's'}`); }} />
      {ruleMsg && (
        <div role="status" aria-live="polite" style={{
          position: 'fixed', left: '50%', bottom: 28, transform: 'translateX(-50%)', zIndex: 6000, maxWidth: '92vw',
          background: 'var(--surface)', border: '1px solid var(--accent)', borderRadius: 10,
          padding: '10px 16px', fontSize: 13, color: 'var(--text)', boxShadow: 'var(--shadow-pop)',
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
      <div className="bud-header">
        <h1 style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.5px' }}>Budget</h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {showPicker && <MonthPicker months={data!.months} value={effMonth} onChange={setMonth} />}
          {(subTab === 'overview' || subTab === 'transactions') && (
            <button className="btn-primary" onClick={() => setReviewOpen(true)} title="Categorize uncertain transactions (across all months) and confirm possible recurring costs">⚡ Quick review</button>
          )}
          {/* Transaction-CSV import lives in the single top-bar Import button
              (DocImport routes CSVs here); results land in the review queue below. */}
        </div>
      </div>

      <div className="bud-tabs" role="tablist" aria-label="Budget sections" ref={tabsRef}>
        {TABS.map(t => (
          <button key={t.key} role="tab" aria-selected={subTab === t.key} onClick={() => setSubTab(t.key)}
            className={subTab === t.key ? 'on' : ''}>{t.label}</button>
        ))}
        <span className="bud-tabs-spacer" />
        <button role="tab" aria-selected={subTab === 'setup'} onClick={() => setSubTab('setup')}
          className={subTab === 'setup' ? 'on' : ''} title="Rename, regroup and add categories; review categorization rules">⚙ Categories &amp; rules</button>
      </div>

      {loadingMain && <p style={{ color: 'var(--muted)' }}>Loading…</p>}
      {(subTab === 'overview' || subTab === 'transactions') && error && <p style={{ color: 'var(--red)' }}>Failed to load: {error}</p>}

      {subTab === 'cashflow' && (
        <>
          <div className="bud-viewbar">
            <div className="seg" role="tablist" aria-label="Cash flow view">
              <button role="tab" aria-selected={cashView === 'month'} className={`seg-btn${cashView === 'month' ? ' active' : ''}`} onClick={() => setCashView('month')}>By month</button>
              <button role="tab" aria-selected={cashView === 'flow'} className={`seg-btn${cashView === 'flow' ? ' active' : ''}`} onClick={() => setCashView('flow')}>Where it goes</button>
            </div>
          </div>
          {cashView === 'month' ? (
            <CashFlowTrend privacy={privacy} version={recatVersion} cats={cats} groups={groups}
              onRecategorize={recategorize} onCreateCategory={categorizeNew}
              month={effMonth || undefined} onSelectMonth={setMonth} />
          ) : (
            <CashFlowSankey privacy={privacy} cats={cats} groups={groups}
              onRecategorize={recategorize} onCreateCategory={categorizeNew} version={recatVersion}
              range={flowRange} setRange={setFlowRange} month={effMonth || undefined} />
          )}
        </>
      )}

      {subTab === 'setup' && (
        <>
          <div className="bud-viewbar">
            <div className="seg" role="tablist" aria-label="Set-up">
              <button role="tab" aria-selected={setupView === 'rules'} className={`seg-btn${setupView === 'rules' ? ' active' : ''}`} onClick={() => setSetupView('rules')}>Rules</button>
              <button role="tab" aria-selected={setupView === 'categories'} className={`seg-btn${setupView === 'categories' ? ' active' : ''}`} onClick={() => setSetupView('categories')}>Categories</button>
            </div>
          </div>
          {setupView === 'rules'
            ? <RulesManager privacy={privacy} cats={cats} groups={groups} onChanged={changed} />
            : <CategoryManager groups={groups} onChanged={changed} toast={toast} snapshot={catSnapshot} onSnapshot={setCatSnapshot} />}
        </>
      )}

      {subTab === 'transactions' && (
        <TransactionsView money={money} moneyCents={moneyCents} cats={cats} groups={groups}
          month={effMonth} allTime={txnAllTime} setAllTime={setTxnAllTime}
          filters={txnFilters} setFilters={setTxnFilters}
          onRecategorize={recategorize} onCreateCategory={categorizeNew} onFlipSign={flipSign} version={recatVersion} />
      )}

      {data && subTab === 'overview' && (
        <div style={{ opacity: stale ? 0.6 : 1, transition: 'opacity 0.15s' }} aria-busy={stale}>
          <BudgetKpis data={data} lbl={lbl!} money={money} incomeCats={incomeCats}
            compareMode={compareMode} setCompareMode={setCompareMode} onViewMonth={viewMonthTxns}
            onSetBudgets={() => { catsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); catsRef.current?.focus({ preventScroll: true }); }} />

          {importMsg && <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: -8, marginBottom: 16 }}>{importMsg}</p>}

          <SpendingPaceChart data={data} lbl={lbl!} money={money} privacy={privacy} />

          {/* Needs review — fast categorization */}
          {data.needsReview.length > 0 && (
            <div style={{ background: 'var(--surface)', border: '1px solid var(--amber)', borderRadius: 12, padding: 20, marginBottom: 20 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                <h2 style={{ fontSize: 15, fontWeight: 600 }}>
                  Needs review in {monthLong(data.month).split(' ')[0]} · {data.needsReview.length} transaction{data.needsReview.length === 1 ? '' : 's'} · {money(reviewTotal)}
                </h2>
                <button className="btn-primary" style={{ fontSize: 12, padding: '5px 12px' }} onClick={() => setReviewOpen(true)} title="Step through everything that needs review — covers all months, not just this one">⚡ Quick review (all months)</button>
              </div>
              <p style={{ color: 'var(--muted)', fontSize: 12, margin: '4px 0 12px' }}>Pick a category — it applies to every transaction from that merchant, now and in future.</p>
              {/* Column grid in index.css (.bud-review-row): five columns on desktop;
                  on a phone two lines (merchant + amount, then date · account +
                  category), so the amount and Categorize chip stay on screen. */}
              {data.needsReview.map(t => (
                <div key={t.id} {...rowProps(() => openTxnDetail(txnToDetail(t)))} title="Click for details" aria-label={txnRowLabel(t, moneyCents)}
                  className="bud-review-row">
                  <span className="rv-date" style={{ color: 'var(--muted)', fontSize: 12, whiteSpace: 'nowrap' }}>{fmtTxnDate(t.date)}</span>
                  <span className="rv-merchant" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, minWidth: 0 }}>
                    <MerchantIcon merchant={t.merchant} label={t.payee} size={22} />
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.payee}</span>
                      {t.description && t.description.toLowerCase() !== t.payee.toLowerCase() && (
                        <span style={{ display: 'block', fontSize: 10, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'ui-monospace, SFMono-Regular, monospace' }} title={t.description}>{t.description}</span>
                      )}
                    </span>
                  </span>
                  <span className="rv-acct" style={{ fontSize: 11, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.account}>{t.account}</span>
                  <span className="rv-amt" style={{ textAlign: 'right', fontSize: 13, whiteSpace: 'nowrap' }}>{moneyCents(t.amount)}</span>
                  <span className="rv-cat" onClick={stop} style={{ minWidth: 0 }}>
                    <CategoryPicker chip value="" excludeOther options={cats} groups={groups} suggested={t.suggested} applyHint={`Applies to every ${t.payee} transaction`}
                      onChange={c => recategorize(t.merchant, c, { payee: t.payee, description: t.description, amount: t.amount })} onCreate={n => categorizeNew(t.merchant, n, { payee: t.payee, description: t.description, amount: t.amount })} />
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Categories next to the latest transactions. Side by side only when
              each column gets ~440px: narrower, the transactions' merchant column
              shrank to nothing. */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 440px), 1fr))', gap: 16, alignItems: 'start' }}>
            <CategoryList ref={catsRef} data={data} cats={cats} groups={groups} money={money} moneyCents={moneyCents}
              hiddenCats={hiddenCats} setHiddenCats={setHiddenCats} extraCats={extraCats} setExtraCats={setExtraCats}
              onRecategorize={recategorize} onCreateCategory={categorizeNew} onSaveTarget={saveTarget}
              onManage={() => { setSetupView('categories'); setSubTab('setup'); }} />
            <LatestTransactions txns={data.recent} cats={cats} groups={groups} moneyCents={moneyCents}
              onRecategorize={recategorize} onCreateCategory={categorizeNew}
              onSeeAll={() => { setTxnAllTime(true); setTxnFilters(NO_FILTERS); setSubTab('transactions'); }} />
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
                  <div className="scroll-x"><div className="tbl-scroll" style={{ ['--tbl-min']: '700px' } as React.CSSProperties}>
                  <div style={{ display: 'grid', gridTemplateColumns: '84px 1fr 110px 84px 150px 70px 22px', gap: 8, fontSize: 11, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, paddingBottom: 6, borderBottom: '1px solid var(--border)' }}>
                    <span>Date</span><span>Merchant</span><span>Account</span><span style={{ textAlign: 'right' }}>Amount</span><span>Category</span><span /><span />
                  </div>
                  <div style={{ maxHeight: 360, overflowY: 'auto' }}>
                    {importedList.map(t => (
                      <div key={t.id} {...rowProps(() => openTxnDetail({ payee: t.payee, amount: t.amount, category: t.category ?? undefined, importedCategory: t.category ?? undefined, account: t.account, date: t.date }))} title="Click for details" aria-label={txnRowLabel(t, moneyCents)}
                        style={{ display: 'grid', gridTemplateColumns: '84px 1fr 110px 84px 150px 70px 22px', gap: 8, alignItems: 'center', fontSize: 12, padding: '5px 0', borderBottom: '1px solid var(--border)', cursor: 'pointer', opacity: t.accepted ? 0.5 : 1 }}>
                        <span style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>{fmtTxnDate(t.date)}</span>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.payee}</span>
                        <span style={{ color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.account}</span>
                        <span style={{ textAlign: 'right' }}>{moneyCents(t.amount)}</span>
                        <span onClick={stop}>
                          <CategoryPicker value={t.category ?? ''} placeholder="Categorize…" options={cats} groups={groups} compact
                            onChange={c => recatImported(t.id, c)}
                            onCreate={async n => { const res = await fetch('/api/budget/category', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: n }) }); const d = await res.json().catch(() => ({} as { created?: string })); await recatImported(t.id, d?.created || n.trim()); }} />
                        </span>
                        {t.accepted
                          ? <span style={{ color: 'var(--green)', textAlign: 'center', fontSize: 11 }}>✓ Accepted</span>
                          : <button className="btn-ghost" onClick={e => { stop(e); acceptImported(t.id); }} title="Mark reviewed" style={{ fontSize: 11, padding: '3px 8px' }}>Accept</button>}
                        <button type="button" onClick={e => { stop(e); removeImported(t.id); }} title="Remove" aria-label={`Remove imported ${t.payee}`}
                          style={{ background: 'transparent', padding: 0, cursor: 'pointer', color: 'var(--red)', textAlign: 'center' }}>×</button>
                      </div>
                    ))}
                  </div>
                  </div></div>
                </>
              )}
            </div>
          ))}

        </div>
      )}

      {subTab === 'recurring' && (
        <Recurring embedded onNavigate={onNavigate} privacy={privacy} onTogglePrivacy={onTogglePrivacy} />
      )}
    </div>
    </TransactionDetailProvider>
  );
}
