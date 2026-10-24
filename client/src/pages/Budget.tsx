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
import RulesManager from '../components/RulesManager.tsx';
import ReviewWizard from '../components/ReviewWizard.tsx';
import RuleSuggestModal, { type RuleCtx } from '../components/RuleSuggestModal.tsx';
import { BUDGET_IMPORTED_EVENT } from '../components/DocImport.tsx';
import { parseNumOrNull } from '../lib/parseNum.ts';
import { TransactionDetailProvider, openTxnDetail, type TxnDetail } from '../components/TransactionDetail.tsx';
import { fmtMoney, fmtMoneyCompact, fmtMonth as fmtMonthShort } from '../lib/format.ts';
import { fmtTxnDate, rowProps } from '../lib/budgetUi.ts';

interface BudgetTxn { id: string; date: string; amount: number; payee: string; account: string; merchant: string; category: string; suggested: string; description: string; memo: string; postedAt: number; transactedAt: number | null; flipped?: boolean; amountEdited?: boolean; ruleId?: number | null; ruleSource?: 'merchant' | 'smart' | 'base' | 'import' | 'auto' }
interface CatRow { category: string; spent: number; count: number; target: number; period?: 'monthly' | 'annual'; ytdSpent?: number; excluded?: boolean }
// Property-derived housing carry (mirror of server RealEstateCarry). Informational —
// not counted in spending; the mortgage payment stays excluded.
interface PropertyCarry {
  id: number; address: string; value: number; balance: number; equity: number; rate: number | null;
  monthlyPI: number; annualInterest: number; annualPrincipal: number;
  propertyTaxAnnual: number; insuranceAnnual: number; hoaAnnual: number; rentalIncomeAnnual: number;
  monthlyCarry: number; payoffISO: string;
}
interface HousingCarry {
  properties: PropertyCarry[];
  totals: {
    value: number; balance: number; equity: number;
    monthlyPI: number; annualInterest: number; annualPrincipal: number;
    propertyTaxAnnual: number; insuranceAnnual: number; hoaAnnual: number; rentalIncomeAnnual: number; monthlyCarry: number;
  };
}
interface BudgetData {
  months: string[]; month: string; transactions: BudgetTxn[]; byCategory: CatRow[];
  needsReview: BudgetTxn[]; recent: BudgetTxn[]; income: number; spending: number; mortgage: number; housing?: HousingCarry; totalBudget: number; categories: string[]; groups: PickerGroup[];
  // For the in-progress month the comparisons are measured through the same day (asOfDay).
  comparison: { priorMonth: number | null; priorYearAvg: number | null; priorYears: number[] };
  asOfDay: number | null; daysInMonth: number;
  dailyCumulative: { day: number; current: number | null; prior: number | null }[];
  importedCount: number;
  importedPending: number;
}
interface ImportedTxn { id: string; date: string; amount: number; payee: string; account: string; category: string | null; accepted: boolean }

const PROTECTED = new Set(['Paychecks', 'Other Income', 'Dividends & Capital Gains', 'Transfers', 'Credit Card Payment', 'Mortgage', 'Miscellaneous']);

// Map a transaction row to the shared detail-popup shape.
const txnToDetail = (t: BudgetTxn): TxnDetail => ({
  id: t.id, amountEdited: t.amountEdited,
  payee: t.payee, merchant: t.merchant, amount: t.amount, category: t.category, account: t.account,
  date: t.date, postedAt: t.postedAt, transactedAt: t.transactedAt, description: t.description, memo: t.memo,
  suggested: t.suggested,
});
// Stop a click on an inner control (the category picker, a remove button) from
// also opening the row's detail popup.
const stop = (e: React.MouseEvent) => e.stopPropagation();

function monthLong(m: string) {
  return new Date(m + '-01T00:00:00').toLocaleString('en-US', { month: 'long', year: 'numeric' });
}
const monthName = (ym: string) => new Date(ym + '-01T00:00:00').toLocaleString('en-US', { month: 'short' });
const daysIn = (ym: string) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
const monthStart = (ym: string) => `${ym}-01`;
function addMonths(ym: string, delta: number) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
}
function barColor(spent: number, target: number) {
  if (!target) return 'var(--accent)';
  const r = spent / target;
  return r > 1 ? 'var(--red)' : r > 0.85 ? 'var(--amber)' : 'var(--green)';
}

// Labels that spell out exactly which periods the Overview compares. For the
// in-progress month both sides are measured through the same day ("Oct 1–24" vs
// "Sep 1–24"), so a partial month is never set against a whole one.
function periodLabels(d: BudgetData) {
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

// Monthly carry components for a property (or the aggregate), derived from the
// annual figures. `netCarry` is the total carry after any rental/income offset.
function carryFigures(c: {
  annualInterest: number; annualPrincipal: number; propertyTaxAnnual: number;
  insuranceAnnual: number; hoaAnnual: number; rentalIncomeAnnual: number; monthlyCarry: number;
}) {
  return {
    interestMo: c.annualInterest / 12, principalMo: c.annualPrincipal / 12,
    taxMo: c.propertyTaxAnnual / 12, insMo: c.insuranceAnnual / 12, hoaMo: c.hoaAnnual / 12,
    rentalMo: c.rentalIncomeAnnual / 12, netCarry: c.monthlyCarry - c.rentalIncomeAnnual / 12,
  };
}

// Informational housing-carry breakdown derived from the dashboard's real-estate
// data (loan terms + property tax/insurance/HOA). It does NOT change spending —
// the mortgage stays excluded — but it surfaces the true interest cost vs the
// principal that builds equity, plus the other carrying costs and payoff timing.
// With more than one holding the carry is broken out per property so each one's
// true cost is visible on its own.
function HousingCarryCard({ housing, money }: { housing: HousingCarry; money: (n: number) => string }) {
  const t = housing.totals;
  const total = carryFigures(t);
  const multi = housing.properties.length > 1;

  const row = (label: string, value: number, note?: string, color?: string) => value > 0 && (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 13, padding: '3px 0' }}>
      <span style={{ color: 'var(--muted)' }}>{label}{note && <span style={{ fontSize: 11, opacity: 0.7 }}> · {note}</span>}</span>
      <span style={{ fontWeight: 600, color: color ?? 'var(--text)' }}>{money(value)}/mo</span>
    </div>
  );
  // The shared interest/principal/tax/insurance/HOA/income rows for a carry shape.
  const breakdown = (c: ReturnType<typeof carryFigures>) => (
    <div>
      {row('Mortgage interest', c.interestMo, 'cost', 'var(--red)')}
      {row('Mortgage principal', c.principalMo, 'builds equity', 'var(--green)')}
      {row('Property tax', c.taxMo)}
      {row('Insurance', c.insMo)}
      {row('HOA', c.hoaMo)}
      {row('Rental / income', c.rentalMo, 'income', 'var(--green)')}
    </div>
  );
  const netLabel = (net: number) => (
    <span style={{ fontSize: 18, fontWeight: 700, color: net < 0 ? 'var(--green)' : 'var(--text)' }}>
      {net < 0 ? `+${money(-net)}` : money(net)}/mo{net < 0 ? ' net income' : ''}
    </span>
  );

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 20, marginBottom: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4, gap: 8, flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: 15, fontWeight: 600 }}>Housing carry{total.rentalMo > 0 ? ' (net of income)' : ''}</h2>
        {netLabel(total.netCarry)}
      </div>
      <p style={{ color: 'var(--muted)', fontSize: 11.5, marginBottom: 12 }}>
        Informational — not counted in spending. Of your mortgage payment, the <strong style={{ color: 'var(--red)' }}>interest</strong> is a true cost while the <strong style={{ color: 'var(--green)' }}>principal</strong> builds equity.{total.rentalMo > 0 ? ' Rental income offsets the carrying costs.' : ''}{multi ? ' Broken out per holding below.' : ''}
      </p>

      {multi ? (
        // One block per holding, each with its own breakdown and equity/payoff footer.
        housing.properties.map(p => {
          const f = carryFigures(p);
          const payoffYear = p.payoffISO ? p.payoffISO.slice(0, 4) : null;
          return (
            <div key={p.id} style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
                <span style={{ fontSize: 13.5, fontWeight: 600 }}>{p.address}</span>
                {netLabel(f.netCarry)}
              </div>
              {breakdown(f)}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
                <span>Equity {money(p.equity)} of {money(p.value)}</span>
                {payoffYear && <span>Mortgage payoff ~{payoffYear}</span>}
              </div>
            </div>
          );
        })
      ) : (
        <>
          {breakdown(total)}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 12, color: 'var(--muted)', marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
            <span>Equity {money(t.equity)} of {money(t.value)}</span>
            {(() => {
              const payoff = housing.properties.map(p => p.payoffISO).filter(Boolean).sort().pop();
              return payoff ? <span>Mortgage payoff ~{payoff.slice(0, 4)}</span> : null;
            })()}
          </div>
        </>
      )}
    </div>
  );
}

export default function Budget({ onNavigate, privacy, onTogglePrivacy }: {
  onNavigate: (v: View) => void; privacy: boolean; onTogglePrivacy: () => void;
}) {
  const [month, setMonth] = useState('');
  const [subTab, setSubTab] = useState<'overview' | 'transactions' | 'recurring' | 'cashflow' | 'sankey' | 'rules'>('overview');
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
  // Totals read in whole dollars; individual transactions keep their cents. Negatives use "−$45".
  const money = (n: number) => (privacy ? '••••••' : fmtMoney(n));
  const moneyCents = (n: number) => (privacy ? '••••••' : fmtMoney(n, { cents: true }));

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
      ? `↹ Reversed sign for ${payee || merchant} — ${n} transaction${n === 1 ? '' : 's'}, including future ones`
      : `↹ Restored original sign for ${payee || merchant}`);
  }
  // Categorize just this merchant (scope 'one'), then offer smart rules to apply
  // the same category to other/future transactions (by merchant, amount or text).
  async function recategorize(merchant: string, category: string, ctx?: { payee: string; description: string; amount: number }) {
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
  async function addCat() {
    if (!newCat.trim()) return;
    await fetch('/api/budget/category', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: newCat.trim() }) });
    setNewCat(''); refetch();
  }
  async function removeCat(name: string, label: string) {
    if (!confirm(`Remove the “${label}” category? Its transactions fall back to auto-categorization (you can re-add it any time).`)) return;
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
  const lbl = data ? periodLabels(data) : null;
  const compLabel = lbl ? (compareMode === 'priorMonth' ? lbl.prevLabel : lbl.yearLabel) : '';

  return (
    <TransactionDetailProvider privacy={privacy} onChanged={() => { refetch(); setRecatVersion(v => v + 1); }}>
    <div className="page" style={{ maxWidth: 1280, margin: '0 auto', padding: '32px 24px' }}>
      {reviewOpen && (
        <ReviewWizard cats={cats} groups={groups} money={money} moneyCents={moneyCents}
          onClose={() => { setReviewOpen(false); refetch(); }}
          onCategorized={() => { refetch(); setRecatVersion(v => v + 1); }} />
      )}
      <RuleSuggestModal ctx={ruleCtx} onClose={() => setRuleCtx(null)}
        onApplied={m => { refetch(); setRecatVersion(v => v + 1); if (m > 0) toast(`✨ Categorized ${m} transaction${m === 1 ? '' : 's'}`); }} />
      {ruleMsg && (
        <div role="status" aria-live="polite" style={{
          position: 'fixed', left: '50%', bottom: 28, transform: 'translateX(-50%)', zIndex: 6000, maxWidth: '92vw',
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <h1 style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.5px' }}>Budget</h1>
        {(subTab === 'overview' || subTab === 'transactions') && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn-primary" onClick={() => setReviewOpen(true)} title="Categorize uncertain transactions (across all months) and confirm possible recurring costs">⚡ Quick review</button>
            {/* Transaction-CSV import lives in the single top-bar Import button now
                (DocImport routes CSVs here); results land in the review queue below. */}
            {/* The Overview month picker; the All-transactions tab has its own period control. */}
            {subTab === 'overview' && data && (
              <select value={month || data.month} onChange={e => setMonth(e.target.value)}
                style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', fontSize: 13, padding: '6px 10px' }}>
                {data.months.map(m => <option key={m} value={m}>{monthLong(m)}</option>)}
              </select>
            )}
          </div>
        )}
      </div>

      <div className="scroll-row" style={{ display: 'flex', gap: 16, marginBottom: 20, borderBottom: '1px solid var(--border)' }}>
        {(['overview', 'transactions', 'recurring', 'cashflow', 'sankey', 'rules'] as const).map(t => (
          <button key={t} onClick={() => setSubTab(t)}
            style={{ background: 'transparent', color: subTab === t ? 'var(--text)' : 'var(--muted)', fontWeight: subTab === t ? 600 : 400, fontSize: 14, padding: '6px 2px', borderBottom: subTab === t ? '2px solid var(--accent)' : '2px solid transparent', whiteSpace: 'nowrap', flexShrink: 0 }}>
            {t === 'overview' ? 'Overview' : t === 'transactions' ? 'Transactions' : t === 'recurring' ? 'Recurring' : t === 'cashflow' ? 'Cash Flow' : t === 'sankey' ? 'Sankey' : 'Rules'}
          </button>
        ))}
      </div>

      {(subTab === 'overview' || subTab === 'transactions') && loading && <p style={{ color: 'var(--muted)' }}>Loading…</p>}
      {(subTab === 'overview' || subTab === 'transactions') && error && <p style={{ color: 'var(--red)' }}>Failed to load: {error}</p>}

      {subTab === 'cashflow' && (
        <CashFlowTrend privacy={privacy} version={recatVersion} cats={cats} groups={groups}
          onRecategorize={recategorize} onCreateCategory={categorizeNew} />
      )}

      {subTab === 'sankey' && (
        <CashFlowSankey privacy={privacy} cats={cats} groups={groups}
          onRecategorize={recategorize} onCreateCategory={categorizeNew} version={recatVersion} />
      )}

      {subTab === 'rules' && (
        <RulesManager privacy={privacy} cats={cats} groups={groups}
          onChanged={() => { refetch(); setRecatVersion(v => v + 1); }} />
      )}

      {subTab === 'transactions' && (
        <TransactionsView money={money} moneyCents={moneyCents} cats={cats} groups={groups} filter={txnFilter} setFilter={setTxnFilter} range={txnRange} setRange={setTxnRange} onRecategorize={recategorize} onCreateCategory={categorizeNew} onFlipSign={flipSign} version={recatVersion} />
      )}

      {data && subTab === 'overview' && (
        <>
          {/* Summary: Spent vs a prior-period comparison */}
          <div className="stack-mobile" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
            <div {...rowProps(() => viewMonthTxns(data.month))}
              title={`View ${monthLong(data.month)} transactions`}
              style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 18px', cursor: 'pointer' }}>
              <p style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 4 }}>Spent · {lbl!.spent}</p>
              <p style={{ fontSize: 22, fontWeight: 700, color: 'var(--amber)' }}>{money(data.spending)}</p>
              {data.mortgage > 0 && (
                <p style={{ color: 'var(--muted)', fontSize: 11, marginTop: 6 }}>
                  + {money(data.mortgage)} mortgage (excluded · see Housing carry below)
                </p>
              )}
            </div>
            <div
              {...rowProps(() => { const tgt = compareMode === 'priorMonth' ? addMonths(data.month, -1) : addMonths(data.month, -12); if (data.months.includes(tgt)) viewMonthTxns(tgt); })}
              title="Click to view that period's transactions"
              style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 18px', cursor: 'pointer' }}>
              <select onClick={e => e.stopPropagation()} value={compareMode} onChange={e => setCompareMode(e.target.value as 'priorMonth' | 'priorYearAvg')}
                aria-label="Comparison period"
                style={{ background: 'transparent', border: 'none', color: 'var(--muted)', fontSize: 12, padding: 0, marginBottom: 4, cursor: 'pointer' }}>
                <option value="priorMonth">vs {lbl!.prevLabel}</option>
                <option value="priorYearAvg">vs {lbl!.yearLabel}</option>
              </select>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <p style={{ fontSize: 22, fontWeight: 700, color: 'var(--text)' }}>{compVal != null ? money(compVal) : '—'}</p>
                {delta != null && (
                  <span title={`${lbl!.spent} spending vs ${compLabel}`} style={{ fontSize: 13, fontWeight: 600, color: delta > 0 ? 'var(--red)' : 'var(--green)' }}>
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
            <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>
              {data.asOfDay != null ? 'Spending so far' : 'Cumulative spending'} · {lbl!.curName} vs {lbl!.prevName}
            </h2>
            <div style={{ width: '100%', height: 220, filter: privacy ? 'blur(8px)' : 'none' }}>
              <ResponsiveContainer>
                <LineChart data={data.dailyCumulative} margin={{ top: 6, right: 14, left: 6, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2a2d3a" />
                  <XAxis dataKey="day" tick={{ fill: '#7b7f95', fontSize: 11 }} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fill: '#7b7f95', fontSize: 11 }} tickLine={false} axisLine={false}
                    tickFormatter={fmtMoneyCompact} width={44} />
                  <Tooltip contentStyle={{ background: '#1a1d27', border: '1px solid #2a2d3a', borderRadius: 8 }}
                    labelFormatter={d => `Day ${d}`} formatter={(v: number) => fmtMoney(v)} />
                  <Legend wrapperStyle={{ fontSize: 12, color: '#7b7f95' }} />
                   <Line type="monotone" dataKey="prior" name={lbl!.prevName} stroke="#7b7f95" strokeWidth={2} strokeDasharray="5 4" dot={false} connectNulls />
                   <Line type="monotone" dataKey="current" name={lbl!.curName} stroke="#fbbf24" strokeWidth={2.5} dot={false} connectNulls />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Needs review — fast categorization */}
          {data.needsReview.length > 0 && (
            <div style={{ background: 'var(--surface)', border: '1px solid var(--amber)', borderRadius: 12, padding: 20, marginBottom: 20 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h2 style={{ fontSize: 15, fontWeight: 600 }}>
                  Needs review in {monthLong(data.month).split(' ')[0]} · {data.needsReview.length} transaction{data.needsReview.length === 1 ? '' : 's'} · {money(reviewTotal)}
                </h2>
                <button className="btn-primary" style={{ fontSize: 12, padding: '5px 12px' }} onClick={() => setReviewOpen(true)} title="Step through everything that needs review — covers all months, not just this one">⚡ Quick review (all months)</button>
              </div>
              <p style={{ color: 'var(--muted)', fontSize: 12, margin: '4px 0 12px' }}>Pick a category — it applies to every transaction from that merchant, now and in future.</p>
              {/* On a phone the fixed columns don't fit; scroll sideways within the
                  card rather than overlapping the merchant/date and the Categorize button. */}
              <div className="scroll-x"><div className="tbl-scroll" style={{ ['--tbl-min']: '560px' } as React.CSSProperties}>
              {data.needsReview.map(t => (
                <div key={t.id} {...rowProps(() => openTxnDetail(txnToDetail(t)))} title="Click for details"
                  style={{ display: 'grid', gridTemplateColumns: '76px 1fr 120px 84px 130px', gap: 10, alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
                  <span style={{ color: 'var(--muted)', fontSize: 12, whiteSpace: 'nowrap' }}>{fmtTxnDate(t.date)}</span>
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
                  <span style={{ textAlign: 'right', fontSize: 13 }}>{moneyCents(t.amount)}</span>
                  <span onClick={stop}>
                    <CategoryPicker value="" placeholder="Categorize…" excludeOther options={cats} groups={groups} suggested={t.suggested} applyHint={`Applies to every ${t.payee} transaction`}
                      onChange={c => recategorize(t.merchant, c, { payee: t.payee, description: t.description, amount: t.amount })} onCreate={n => categorizeNew(t.merchant, n)} />
                  </span>
                </div>
              ))}
              </div></div>
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
            {/* Budget progress, and — for the in-progress month — how far through it we are. */}
            {(data.totalBudget > 0 || data.asOfDay != null) && (
              <p style={{ color: 'var(--muted)', fontSize: 12, margin: '-6px 0 10px' }}
                title="All spending this month against the sum of every category budget (annual budgets count as 1/12 each)">
                {data.totalBudget > 0 && <>{money(data.spending)} of {money(data.totalBudget)} budgeted</>}
                {data.totalBudget > 0 && data.asOfDay != null && ' · '}
                {data.asOfDay != null && <>Day {data.asOfDay} of {data.daysInMonth}{data.totalBudget > 0 && ` (${Math.round((data.asOfDay / data.daysInMonth) * 100)}% of the month, ${Math.round((data.spending / data.totalBudget) * 100)}% of budget)`}</>}
              </p>
            )}
            {ranked.length > TOP_N && (
              <p style={{ color: 'var(--muted)', fontSize: 11.5, margin: '-4px 0 10px' }}>
                Showing the top {TOP_N} of {ranked.length} categories by spend — hide one or insert others below.
              </p>
            )}
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
                              <input key={`${canon}:${c.name}`} defaultValue={c.name}
                                onBlur={e => { const v = e.target.value.trim(); if (v && v !== c.name && c.canonical) renameCat(c.canonical, v); }}
                                onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                                style={{ flex: 1, minWidth: 0, padding: '3px 6px', fontSize: 12, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)' }} />
                              <select value={g.name} onChange={e => setCatGroup(canon, e.target.value)} title="Reclassify into another group"
                                style={{ flexShrink: 0, maxWidth: 104, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--muted)', fontSize: 11, padding: '3px 4px', cursor: 'pointer' }}>
                                {(groupOpts.includes(g.name) ? groupOpts : [g.name, ...groupOpts]).map(gn => <option key={gn} value={gn}>{gn}</option>)}
                              </select>
                              {!PROTECTED.has(canon) && (
                                <button type="button" onClick={() => removeCat(canon, c.name)} title="Remove category" aria-label={`Remove ${c.name}`}
                                  style={{ background: 'transparent', padding: 0, cursor: 'pointer', color: 'var(--red)', fontWeight: 700, flexShrink: 0 }}>×</button>
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
                cats={cats} groups={groups} money={money} moneyCents={moneyCents} month={data.month} onRecategorize={recategorize} onCreateCategory={categorizeNew} onSaveTarget={saveTarget}
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
            <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>
              Latest transactions <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 12 }}>(all months)</span>
            </h2>
            {data.recent.length === 0 && <p style={{ fontSize: 13, color: 'var(--muted)' }}>No transactions.</p>}
            {data.recent.map(t => (
              <div key={t.id} {...rowProps(() => openTxnDetail(txnToDetail(t)))} title="Click for details"
                style={{ display: 'grid', gridTemplateColumns: '76px 1fr 130px auto', gap: 8, alignItems: 'center', padding: '5px 0', borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
                <span style={{ color: 'var(--muted)', fontSize: 12, whiteSpace: 'nowrap' }}>{fmtTxnDate(t.date)}</span>
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
                  <CategoryPicker value={t.category} options={cats} groups={groups} suggested={t.suggested} compact applyHint={`Applies to every ${t.payee} transaction`}
                    onChange={c => recategorize(t.merchant, c, { payee: t.payee, description: t.description, amount: t.amount })} onCreate={n => categorizeNew(t.merchant, n)} />
                </span>
                <span style={{ textAlign: 'right', fontSize: 13, color: t.amount > 0 ? 'var(--green)' : 'var(--text)' }}>{moneyCents(t.amount)}</span>
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
                  <div className="scroll-x"><div className="tbl-scroll" style={{ ['--tbl-min']: '700px' } as React.CSSProperties}>
                  <div style={{ display: 'grid', gridTemplateColumns: '84px 1fr 110px 84px 150px 70px 22px', gap: 8, fontSize: 11, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, paddingBottom: 6, borderBottom: '1px solid var(--border)' }}>
                    <span>Date</span><span>Merchant</span><span>Account</span><span style={{ textAlign: 'right' }}>Amount</span><span>Category</span><span /><span />
                  </div>
                  <div style={{ maxHeight: 360, overflowY: 'auto' }}>
                    {importedList.map(t => (
                      <div key={t.id} {...rowProps(() => openTxnDetail({ payee: t.payee, amount: t.amount, category: t.category ?? undefined, importedCategory: t.category ?? undefined, account: t.account, date: t.date }))} title="Click for details"
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

          {/* Housing carry sits at the bottom: it's informational and rarely
              changes, so it stays out of the way of the month's activity. */}
          {data.housing && data.housing.totals.monthlyCarry > 0 && (
            <HousingCarryCard housing={data.housing} money={money} />
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

function TransactionsView({ money, moneyCents, cats, groups, filter, setFilter, range, setRange, onRecategorize, onCreateCategory, onFlipSign, version }: {
  money: (n: number) => string; moneyCents: (n: number) => string; cats: string[]; groups: PickerGroup[];
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
  // In / Out by sign (Transfers already excluded server-side). Mortgage payments are
  // listed but not counted, matching the Overview's "Spent" and the Cash Flow bars.
  // These are gross by sign: a refund counts as In rather than netting against Out.
  const counted = filtered.filter(t => t.category !== 'Mortgage');
  const mortgageOut = filtered.filter(t => t.category === 'Mortgage').reduce((s, t) => s + Math.abs(t.amount), 0);
  const inflow = counted.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const outflow = counted.filter(t => t.amount < 0).reduce((s, t) => s + -t.amount, 0);

  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - BUFFER);
  const end = Math.min(rows.length, Math.ceil((scrollTop + VIEW_H) / ROW_H) + BUFFER);
  const visible = rows.slice(start, end).map((t, i) => ({ t, idx: start + i }));

  function toggleSort(col: 'date' | 'amount') {
    if (sortBy === col) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortBy(col); setSortDir('desc'); }
  }
  const arrow = (col: 'date' | 'amount') => (sortBy === col ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '');
  const sortBtn: React.CSSProperties = { background: 'transparent', padding: 0, font: 'inherit', textTransform: 'inherit', letterSpacing: 'inherit', fontWeight: 'inherit', color: 'inherit', cursor: 'pointer', userSelect: 'none' };
  const selStyle = { background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', fontSize: 13, padding: '5px 10px', cursor: 'pointer' };

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: 15, fontWeight: 600 }}>
          {range === 'all' ? 'Transactions' : monthLong(range)}
          <span style={{ color: 'var(--muted)', fontWeight: 400 }}> · {loading ? '…' : `${rows.length} transaction${rows.length === 1 ? '' : 's'}`}</span>
        </h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={range} onChange={e => setRange(e.target.value)} style={selStyle} title="Time period">
            <option value="all">All time</option>
            {months.map(m => <option key={m} value={m}>{monthLong(m)}</option>)}
          </select>
          <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter merchant / account / category"
            style={{ flex: '0 1 260px', padding: '5px 10px', fontSize: 13 }} />
        </div>
      </div>
      <p style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 10 }}
        title="In and Out are summed by sign, so a refund counts as In. Mortgage payments are shown in the list but left out of the totals, as in the Overview.">
        In {money(inflow)} · Out {money(outflow)}
        {mortgageOut > 0 && ` · excludes ${money(mortgageOut)} mortgage`}
      </p>
      {/* On a phone the columns don't fit; scroll the table sideways within the
          card (min-width keeps the columns legible) rather than squashing them. */}
      <div className="scroll-x"><div className="tbl-scroll" style={{ ['--tbl-min']: '640px' } as React.CSSProperties}>
      <div style={{ display: 'grid', gridTemplateColumns: '84px 1fr 130px 140px 92px 26px', gap: 8, fontSize: 11, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, paddingBottom: 6, borderBottom: '1px solid var(--border)' }}>
        <button type="button" onClick={() => toggleSort('date')} aria-label={`Sort by date${sortBy === 'date' ? (sortDir === 'asc' ? ', ascending' : ', descending') : ''}`}
          style={{ ...sortBtn, textAlign: 'left', color: sortBy === 'date' ? 'var(--text)' : undefined }} title="Sort by date">Date{arrow('date')}</button>
        <span>Merchant</span><span>Account</span><span>Category</span>
        <button type="button" onClick={() => toggleSort('amount')} aria-label={`Sort by amount${sortBy === 'amount' ? (sortDir === 'asc' ? ', ascending' : ', descending') : ''}`}
          style={{ ...sortBtn, textAlign: 'right', color: sortBy === 'amount' ? 'var(--text)' : undefined }} title="Sort by amount">Amount{arrow('amount')}</button>
        <span />
      </div>
      <div ref={scrollRef} onScroll={e => setScrollTop(e.currentTarget.scrollTop)} style={{ maxHeight: VIEW_H, overflowY: 'auto', position: 'relative' }}>
        <div style={{ height: rows.length * ROW_H, position: 'relative' }}>
          {visible.map(({ t, idx }) => {
            const excluded = t.category === 'Mortgage';
            return (
              <div key={t.id} {...rowProps(() => openTxnDetail(txnToDetail(t)))} title="Click for details"
                style={{ position: 'absolute', top: idx * ROW_H, left: 0, right: 0, height: ROW_H, boxSizing: 'border-box', display: 'grid', gridTemplateColumns: '84px 1fr 130px 140px 92px 26px', gap: 8, alignItems: 'center', fontSize: 13, borderBottom: '1px solid var(--border)', opacity: excluded ? 0.5 : 1, cursor: 'pointer' }}>
                <span style={{ color: 'var(--muted)', fontSize: 12, whiteSpace: 'nowrap' }}>{fmtTxnDate(t.date)}</span>
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
                  <CategoryPicker value={t.category} options={cats} groups={groups} suggested={t.suggested} compact applyHint={`Applies to every ${t.payee} transaction`}
                    onChange={c => onRecategorize(t.merchant, c, { payee: t.payee, description: t.description, amount: t.amount })} onCreate={n => onCreateCategory(t.merchant, n)} />
                </span>
                <span style={{ textAlign: 'right', color: t.amount > 0 ? 'var(--green)' : 'var(--text)' }}>{moneyCents(t.amount)}</span>
                <button type="button" onClick={e => { stop(e); onFlipSign(t.merchant, t.payee); }}
                  aria-label={t.flipped ? `Restore original sign for ${t.payee}` : `Reverse +/- sign for ${t.payee}`} aria-pressed={!!t.flipped}
                  title={t.flipped ? 'Sign reversed for similar merchants — click to restore' : 'Reverse +/- sign — applies to similar merchants & future transactions'}
                  style={{ background: 'transparent', padding: 0, cursor: 'pointer', textAlign: 'center', fontSize: 13, lineHeight: 1, color: t.flipped ? 'var(--accent)' : 'var(--muted)', fontWeight: t.flipped ? 700 : 400 }}>⇄</button>
              </div>
            );
          })}
        </div>
        {!loading && rows.length === 0 && <p style={{ color: 'var(--muted)', fontSize: 13, padding: '10px 0' }}>No transactions.</p>}
        {loading && <p style={{ color: 'var(--muted)', fontSize: 13, padding: '10px 0' }}>Loading…</p>}
      </div>
      </div></div>
    </div>
  );
}

function CategoryRow({ cat, open, onToggle, txns, cats, groups, money, moneyCents, month, onRecategorize, onCreateCategory, onSaveTarget, onHide }: {
  cat: CatRow; open: boolean; onToggle: () => void; txns: BudgetTxn[]; cats: string[]; groups: PickerGroup[];
  money: (n: number) => string; moneyCents: (n: number) => string; month: string; onRecategorize: (m: string, c: string, ctx?: { payee: string; description: string; amount: number }) => void; onCreateCategory: (m: string, name: string) => void; onSaveTarget: (c: string, n: number, period: 'monthly' | 'annual') => void;
  onHide?: () => void;
}) {
  const [targetDraft, setTargetDraft] = useState(String(cat.target || ''));
  const [period, setPeriod] = useState<'monthly' | 'annual'>(cat.period ?? 'monthly');
  // Blank/unparseable input must not save (it used to send 0, which clears the target);
  // type 0 to clear one deliberately.
  const commitTarget = () => { const v = parseNumOrNull(targetDraft); if (v != null) onSaveTarget(cat.category, v, period); };
  const isAnnual = cat.period === 'annual';
  // Annual budgets track year-to-date spend; monthly budgets track the month.
  const periodSpent = isAnnual ? (cat.ytdSpent ?? 0) : cat.spent;
  const pct = cat.target ? Math.min(100, (periodSpent / cat.target) * 100) : 0;
  const excluded = !!cat.excluded;

  return (
    <div style={{ marginBottom: 12, opacity: excluded ? 0.55 : 1 }} className="cat-row">
      <div {...rowProps(onToggle)} aria-expanded={open} style={{ cursor: 'pointer' }}>
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
              <button type="button" onClick={e => { e.stopPropagation(); onHide(); }} title="Hide from budget list" aria-label={`Hide ${cat.category} from the budget list`} className="cat-hide"
                style={{ background: 'transparent', cursor: 'pointer', fontSize: 12, lineHeight: 1, padding: '0 2px' }}>🚫</button>
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
                onKeyDown={e => { if (e.key === 'Enter') commitTarget(); }}
                placeholder="0" style={{ width: 76, padding: '3px 6px', fontSize: 12 }} />
              <select value={period} onChange={e => setPeriod(e.target.value as 'monthly' | 'annual')}
                style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', fontSize: 12, padding: '3px 4px', cursor: 'pointer' }}>
                <option value="monthly">/ month</option>
                <option value="annual">/ year</option>
              </select>
              <button className="btn-primary" style={{ fontSize: 11, padding: '3px 8px' }}
                onClick={commitTarget}>Save</button>
            </div>
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
          <div className="scroll-x"><div className="tbl-scroll" style={{ ['--tbl-min']: '476px' } as React.CSSProperties}>
          {txns.map(t => (
            <div key={t.id} {...rowProps(() => openTxnDetail(txnToDetail(t)))} title="Click for details"
              style={{ display: 'grid', gridTemplateColumns: '84px 1fr 80px 130px', gap: 8, alignItems: 'center', fontSize: 12, padding: '4px 0', cursor: 'pointer' }}>
              <span style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>{fmtTxnDate(t.date)}</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }} title={t.account}>
                <MerchantIcon merchant={t.merchant} label={t.payee} size={20} />
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.payee}</span>
                  {t.description && t.description.toLowerCase() !== t.payee.toLowerCase() && (
                    <span style={{ display: 'block', fontSize: 10, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'ui-monospace, SFMono-Regular, monospace' }} title={t.description}>{t.description}</span>
                  )}
                </span>
              </span>
              <span style={{ textAlign: 'right' }}>{moneyCents(t.amount)}</span>
              <span onClick={stop}>
                <CategoryPicker value={t.category} options={cats} groups={groups} suggested={t.suggested} compact applyHint={`Applies to every ${t.payee} transaction`}
                  onChange={c => onRecategorize(t.merchant, c, { payee: t.payee, description: t.description, amount: t.amount })} onCreate={n => onCreateCategory(t.merchant, n)} />
              </span>
            </div>
          ))}
          </div></div>
        </div>
      )}
    </div>
  );
}
