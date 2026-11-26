import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useApi } from '../hooks/useApi.ts';
import { usePersistentState } from '../hooks/usePersistentState.ts';
import { fmtMoney } from '../lib/format.ts';
import TopNav, { type View } from '../components/TopNav.tsx';
import PerformanceChart, { PERF_URL, type PerformanceData } from '../components/PerformanceChart.tsx';
import RiskQuestionnaire from '../components/RiskQuestionnaire.tsx';
import AccountTypesCard, { useFeeCheckup } from '../components/allocation/FeeCheckup.tsx';
import BondQuality, { type BondSummary } from '../components/allocation/BondQuality.tsx';
import AllocationCard from '../components/allocation/AllocationCard.tsx';
import ExposureCard from '../components/allocation/ExposureCard.tsx';
import HeadlineTiles from '../components/allocation/HeadlineTiles.tsx';
import PositionsCard, { idOf, type HoldingRow } from '../components/allocation/PositionsCard.tsx';
import { useAllocationTargets } from '../components/allocation/useAllocationTargets.ts';
import { useAllocationStatus, META_KEYS } from '../components/allocation/useAllocationStatus.ts';
import { CARD, SkeletonCard, SkeletonStyles } from '../components/allocation/ui.tsx';
import { RISK_PROFILES, type ProfileId } from '../lib/riskProfiles.ts';
import { DEFAULT_RANGE, type PerfRange } from '../lib/perfWindow.ts';
import { isCompleteTargets } from '../lib/allocationTargets.ts';
import {
  investedSummary, unrealizedGain, splitPositions, offTarget, migrateOrder, migrateWidths, cardWidth, cardsFillingRow, type CardWidth,
} from '../lib/investments.ts';

// The Investments page: headline figures, the performance chart, the
// allocation against your targets, what you own (regions / sectors / stocks),
// positions with their fees, and where your investments sit by account type.
// Everything below the chart is a card the user can rearrange and resize after
// pressing "Arrange"; the layout is saved (mon.allocOrder / mon.allocWidths)
// and a layout saved by the earlier page is migrated (lib/investments.ts).

interface Contributor { label: string; value: number }
interface Slice { name: string; value: number; pct: number; contributors: Contributor[]; code?: string }
interface StockExposure { symbol: string; name: string; value: number; pct: number; sources: Contributor[]; accounts: { name: string; value: number }[] }
interface RealEstateLot { id: number; address: string; equity: number; excluded: boolean }
interface AllocationData { total: number; holdings: HoldingRow[]; bySector: Slice[]; byStock: StockExposure[]; byCountry: Slice[]; byAssetClass: Slice[]; assetClasses: string[]; realEstate: RealEstateLot[]; lookThrough?: { issue: 'no-contact' | 'blocked'; detail: string }; bonds?: BondSummary }

type Money = (n: number) => string;

// PUT JSON and surface failures: fetch only rejects on network errors, so a 4xx/5xx
// would otherwise look like a successful save.
async function putJson(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); if (j?.error) msg = String(j.error); } catch { /* non-JSON body */ }
    throw new Error(msg);
  }
}

// Sections of the jump row, in page order. A card's anchor is its own id, so
// the links still land on it after the user rearranges the cards.
const JUMPS: [string, string][] = [
  ['inv-overview', 'Overview'], ['inv-allocation', 'Allocation'], ['inv-exposure', 'Exposure'],
  ['inv-positions', 'Positions'], ['inv-fees', 'Fees & taxes'],
];
const ANCHOR: Record<string, string> = { assets: 'inv-allocation', exposure: 'inv-exposure', positions: 'inv-positions', location: 'inv-fees' };
// Visually hidden but read by screen readers.
const SR_ONLY: React.CSSProperties = {
  position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0,
};
// Card names for the arrange handles ("Move Positions") and their announcements.
const CARD_NAME: Record<string, string> = {
  assets: 'Allocation', exposure: 'What you own', positions: 'Positions', location: 'Where your investments sit', bonds: 'Bond quality',
};

// Scroll to a section (below the sticky bar via .fc-anchor's scroll-margin) and
// move focus there, so keyboard users land on it too — as on the Forecast.
function jumpTo(id: string, e?: React.MouseEvent) {
  const el = document.getElementById(id);
  if (!el) return;
  e?.preventDefault();
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  el.focus({ preventScroll: true });
}

// Pop-out for manually setting a holding's asset class. Used everywhere a single
// asset is listed (positions table, treemap breakdown) so the behavior is the
// same across the page; on save it refetches so every panel reflects the change.
function ClassifyModal({ target, classes, onClose, onSaved }: {
  target: { id: string; symbol: string; name: string; currentClass: string; overridden: boolean };
  classes: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [choice, setChoice] = useState(target.overridden ? target.currentClass : 'auto');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      await putJson('/api/allocation/classification', { symbol: target.id, assetClass: choice });
      onSaved();
      onClose();
    } catch (e) {
      setErr(`Couldn't save: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 3500, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 20, width: 'min(420px, 100%)', boxShadow: '0 24px 70px rgba(0,0,0,0.6)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 4 }}>
          <p style={{ fontSize: 16, fontWeight: 700 }}>Classify asset</p>
          <button className="btn-ghost" onClick={onClose} title="Close (Esc)" style={{ fontSize: 16, lineHeight: 1, padding: '4px 10px' }}>×</button>
        </div>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16 }}>
          <strong style={{ color: 'var(--text)' }}>{target.symbol || target.name}</strong>
          {target.symbol && target.name && target.symbol !== target.name ? ` · ${target.name}` : ''}
        </p>
        <label style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Asset class</label>
        <select value={choice} onChange={e => setChoice(e.target.value)}
          style={{ width: '100%', marginTop: 6, marginBottom: 6, padding: '8px 10px', fontSize: 14, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text)' }}>
          <option value="auto">Auto (detect from security data)</option>
          {classes.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <p style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 18 }}>
          {choice === 'auto'
            ? 'Reverts to automatic classification.'
            : 'Counts this holding as the chosen class in every chart.'}
        </p>
        {err && <p role="alert" style={{ fontSize: 12, color: 'var(--red)', marginBottom: 12 }}>{err}</p>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn-ghost" onClick={onClose} disabled={saving} style={{ fontSize: 13 }}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={saving} style={{ fontSize: 13 }}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}

// Pop-out for entering/overriding a position's total cost basis. Used when the
// institution reports no basis (or a wrong one); on save it refetches so the
// gain/loss and portfolio total update everywhere.
function CostBasisModal({ target, money, privacy, onClose, onSaved }: {
  target: { id: string; symbol: string; name: string; value: number; costBasis: number | null; edited: boolean };
  money: Money;
  privacy: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  // Privacy mode masks every amount, so the editor opens empty rather than
  // pre-filled with the real basis (typing a new one still works).
  const [val, setVal] = useState(target.costBasis != null && !privacy ? String(Math.round(target.costBasis)) : '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const parsed = val.trim() === '' ? null : Number(val.replace(/[,$\s]/g, ''));
  const valid = parsed == null || (Number.isFinite(parsed) && parsed >= 0);
  const previewGain = parsed != null && parsed > 0 ? target.value - parsed : null;

  async function save(clear = false) {
    setSaving(true);
    setErr(null);
    try {
      await putJson('/api/allocation/cost-basis', { symbol: target.id, costBasis: clear ? null : parsed });
      onSaved();
      onClose();
    } catch (e) {
      setErr(`Couldn't save: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 3500, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 20, width: 'min(420px, 100%)', boxShadow: '0 24px 70px rgba(0,0,0,0.6)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 4 }}>
          <p style={{ fontSize: 16, fontWeight: 700 }}>Edit cost basis</p>
          <button className="btn-ghost" onClick={onClose} title="Close (Esc)" style={{ fontSize: 16, lineHeight: 1, padding: '4px 10px' }}>×</button>
        </div>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16 }}>
          <strong style={{ color: 'var(--text)' }}>{target.symbol || target.name}</strong>
          {target.symbol && target.name && target.symbol !== target.name ? ` · ${target.name}` : ''}
          {' · '}current value {money(target.value)}
        </p>
        <label style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Total cost basis ($)</label>
        <input
          value={val} onChange={e => setVal(e.target.value)} autoFocus inputMode="decimal"
          onKeyDown={e => { if (e.key === 'Enter' && valid && parsed != null) save(); }}
          placeholder="e.g. 12500"
          style={{ width: '100%', marginTop: 6, marginBottom: 6, padding: '8px 10px', fontSize: 14, background: 'var(--bg)', border: `1px solid ${valid ? 'var(--border)' : '#f87171'}`, borderRadius: 8, color: 'var(--text)', boxSizing: 'border-box' }}
        />
        {/* Privacy mode: no gain / loss direction or colour, only the masked amount. */}
        <p style={{ fontSize: 11, color: previewGain == null || privacy ? 'var(--muted)' : previewGain >= 0 ? 'var(--green)' : 'var(--red)', marginBottom: 18 }}>
          {!valid ? 'Enter a non-negative number.'
            : previewGain != null
              ? privacy ? `Unrealized gain / loss: ${money(Math.abs(previewGain))}`
                : `Unrealized ${previewGain >= 0 ? 'gain' : 'loss'}: ${previewGain >= 0 ? '+' : '−'}${money(Math.abs(previewGain))}`
              : 'Total amount paid for this position (across all lots). Overrides any reported/derived basis.'}
        </p>
        {err && <p role="alert" style={{ fontSize: 12, color: 'var(--red)', marginBottom: 12 }}>{err}</p>}
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
          <button className="btn-ghost" onClick={() => save(true)} disabled={saving || !target.edited}
            title={target.edited ? 'Remove the manual value and revert to the reported/derived basis' : 'No manual value to clear'}
            style={{ fontSize: 13, opacity: target.edited ? 1 : 0.4 }}>Clear override</button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn-ghost" onClick={onClose} disabled={saving} style={{ fontSize: 13 }}>Cancel</button>
            <button className="btn-primary" onClick={() => save()} disabled={saving || !valid || parsed == null} style={{ fontSize: 13 }}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Allocation({ onNavigate, privacy, onTogglePrivacy }: {
  onNavigate: (v: View) => void;
  privacy: boolean;
  onTogglePrivacy: () => void;
}) {
  // Opt-in: estimate a basis (shares × historical price) for positions that have
  // none. Off by default; appends ?estimate=1 so the server only does the work
  // (and historical-price fetches) when asked.
  const [estimateBasis, setEstimateBasis] = usePersistentState('mon.estimateBasis', false);
  const { data, loading, error, refetch } = useApi<AllocationData>('/api/allocation' + (estimateBasis ? '?estimate=1' : ''));
  // Fund fees and the account-type table: one request, shared by the fees tile,
  // the Positions fee columns and the "Where your investments sit" card.
  const fees = useFeeCheckup();
  // The performance history: one request for the chart and the "Return" tile.
  const perf = useApi<PerformanceData>(PERF_URL);
  const money: Money = n => (privacy ? '••••••' : fmtMoney(n));
  const [actionError, setActionError] = useState<string | null>(null);
  // After any save that can change a holding's class, value or basis: the fee
  // check-up is built on the same holdings (server: getFeeCheckup reads
  // getAllocation), so "Where your investments sit", the fee columns and the
  // fees tile refetch along with the allocation.
  const refreshAll = () => { refetch(); fees.refetch(); };

  // Include/exclude a home (e.g. primary residence) from the allocation. The
  // flag is stored per-property server-side, so it persists across browsers.
  async function toggleHome(id: number, excluded: boolean) {
    try {
      await putJson('/api/allocation/property-exclusion', { id, excluded });
      setActionError(null);
      refreshAll();
    } catch (e) {
      setActionError(`Couldn't update the home: ${(e as Error).message}`);
    }
  }
  const [classifyId, setClassifyId] = useState<string | null>(null);
  const [editBasisId, setEditBasisId] = useState<string | null>(null);
  // Asset class picked on the allocation card → filters Positions.
  const [selectedClass, setSelectedClass] = useState<string | null>(null);
  const [riskProfileId, setRiskProfileId] = usePersistentState<ProfileId | null>('mon.riskProfile', null);
  const [showRisk, setShowRisk] = useState(false);
  const riskProfile = riskProfileId ? RISK_PROFILES[riskProfileId] : null;
  const { pref: targetsPref, update: updateTargets } = useAllocationTargets();
  const customTargetsSaved = isCompleteTargets(targetsPref.custom);
  // The rebalance worksheet folds out of the allocation card. The key is the
  // earlier page's Mix / Rebalance switch, so "Rebalance" users find it open.
  const [allocViewPref, setAllocView] = usePersistentState<'mix' | 'rebalance'>('mon.allocView', 'mix');
  const worksheetOpen = allocViewPref === 'rebalance';
  // The chart's range, shared with the "Return" tile.
  const [perfRange, setPerfRange] = useState<PerfRange>(DEFAULT_RANGE);

  // Card layout. Saved values are cleaned on every read, so an order saved by
  // the earlier page (country / sector / stock cards) still shows every card.
  const [orderRaw, setOrder] = usePersistentState<string[]>('mon.allocOrder', []);
  const [widthsRaw, setWidths] = usePersistentState<Record<string, CardWidth>>('mon.allocWidths', {});
  const order = useMemo(() => migrateOrder(orderRaw), [orderRaw]);
  const widths = useMemo(() => migrateWidths(widthsRaw), [widthsRaw]);
  const [arranging, setArranging] = useState(false);
  const [dragOver, setDragOver] = useState<string | null>(null);
  // Keyboard arranging: each card's handle, the one to refocus after a move
  // (React can re-insert a moved card's node, which drops focus), and a line
  // for screen readers saying where it went.
  const handleRefs = useRef<Record<string, HTMLSpanElement | null>>({});
  const refocus = useRef<string | null>(null);
  const [moveNote, setMoveNote] = useState('');
  const isFull = (key: string) => cardWidth(widths, key) === 'full';
  function toggleWidth(key: string) {
    setWidths(prev => {
      const w = migrateWidths(prev);
      return { ...w, [key]: cardWidth(w, key) === 'full' ? 'half' : 'full' };
    });
  }
  // Reorder against the order on screen, then save that whole order.
  function reorder(from: string, to: string, shown: string[]) {
    const a = [...shown];
    const fi = a.indexOf(from), ti = a.indexOf(to);
    if (fi < 0 || ti < 0 || fi === ti) return;
    a.splice(fi, 1); a.splice(ti, 0, from);
    // Keep cards that aren't on screen right now (Bond quality for a portfolio
    // without bonds) in the saved order, after the ones that are.
    setOrder([...a, ...order.filter(k => !a.includes(k))]);
  }
  // Arrow keys on a handle move its card one place earlier / later (Home / End
  // to the first / last place), against the order on screen.
  function moveByKey(e: React.KeyboardEvent, key: string, shown: string[]) {
    const i = shown.indexOf(key);
    const j = e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? i - 1
      : e.key === 'ArrowDown' || e.key === 'ArrowRight' ? i + 1
      : e.key === 'Home' ? 0 : e.key === 'End' ? shown.length - 1 : null;
    if (j == null) return;
    e.preventDefault();
    if (i < 0 || j < 0 || j >= shown.length || j === i) return;
    refocus.current = key;
    reorder(key, shown[j], shown);
    setMoveNote(`${CARD_NAME[key] ?? key} moved to place ${j + 1} of ${shown.length}.`);
  }
  useEffect(() => {
    if (!refocus.current) return;
    handleRefs.current[refocus.current]?.focus();
    refocus.current = null;
  }, [order]);
  // Escape leaves arrange mode.
  useEffect(() => {
    if (!arranging) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setArranging(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [arranging]);

  const holdings = data?.holdings ?? [];
  const inv = investedSummary(holdings);
  const gain = useMemo(() => unrealizedGain(splitPositions(holdings).invested), [holdings]);
  const status = useAllocationStatus(data?.byAssetClass ?? [], riskProfile);
  const off = offTarget(status.result);
  // Manual assets (no account, not a home) classed into the targeted kinds:
  // the allocation bars count them although the "Invested" tile doesn't.
  const manualInKinds = useMemo(() => {
    const homes = new Set((data?.realEstate ?? []).map(r => r.address));
    return holdings.filter(h => h.accounts.length === 0 && !homes.has(h.name) && META_KEYS.includes(h.assetClass) && h.value > 0.5)
      .map(h => ({ name: h.symbol || h.name, value: h.value }));
  }, [holdings, data]);

  // Look up a holding by its override id, for the classify / cost-basis pop-outs.
  const holdingsById = new Map(holdings.map(h => [idOf(h.symbol, h.name), h]));
  const classifyHolding = classifyId ? holdingsById.get(classifyId) : undefined;
  const editBasisHolding = editBasisId ? holdingsById.get(editBasisId) : undefined;
  // Real-estate rows are non-editable for cost basis (their value is equity).
  const realEstateNames = useMemo(() => new Set((data?.realEstate ?? []).map(r => r.address)), [data]);
  const hasAccounts = holdings.some(h => h.accounts.length > 0);
  const showGrid = !!data && (holdings.length > 0 || data.realEstate.length > 0);
  const reserve = arranging ? 18 : 0;
  const handleHelpId = useId();

  const sectionNodes: Record<string, React.ReactNode> = !data || !showGrid ? {} : {
    assets: (
      <AllocationCard classes={data.byAssetClass} homes={data.realEstate} manualInKinds={manualInKinds} money={money} status={status}
        riskProfile={riskProfile} onOpenRiskProfile={() => setShowRisk(true)} onToggleHome={toggleHome}
        selectedClass={selectedClass} onSelectClass={setSelectedClass}
        worksheetOpen={worksheetOpen} onToggleWorksheet={() => setAllocView(worksheetOpen ? 'mix' : 'rebalance')}
        compact={!isFull('assets')} reserveRight={reserve} />
    ),
    exposure: (
      <ExposureCard byCountry={data.byCountry} bySector={data.bySector} byStock={data.byStock} money={money}
        lookThrough={data.lookThrough} onLookThroughSaved={refreshAll} reserveRight={reserve} />
    ),
    positions: (
      <PositionsCard holdings={holdings} realEstateNames={realEstateNames}
        selectedClass={selectedClass} onClearClass={() => setSelectedClass(null)}
        money={money} privacy={privacy} estimateBasis={estimateBasis} onEstimateBasis={setEstimateBasis}
        onClassify={setClassifyId} onEditBasis={setEditBasisId} onProfileSaved={refreshAll} fees={fees} reserveRight={reserve} />
    ),
    ...(hasAccounts ? { location: <AccountTypesCard fees={fees} money={money} reserveRight={reserve} /> } : {}),
    ...(data.bonds && data.bonds.value > 0 ? { bonds: <BondQuality bonds={data.bonds} money={money} reserveRight={reserve} /> } : {}),
  };
  const keys = order.filter(k => sectionNodes[k]);
  const fillsRow = cardsFillingRow(keys, isFull);
  const jumps = JUMPS.filter(([id]) => id === 'inv-overview' || keys.some(k => ANCHOR[k] === id));

  return (
    <div className="page inv-page" style={{ maxWidth: 1280, margin: '0 auto', padding: '32px 24px' }}>
      <TopNav view="allocation" onNavigate={onNavigate} privacy={privacy} onTogglePrivacy={onTogglePrivacy} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <div style={{ minWidth: 0 }}>
          <h1 style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.5px' }}>Investments</h1>
          <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 4 }}>
            {data ? `${money(inv.total)} invested across ${inv.accounts} account${inv.accounts === 1 ? '' : 's'}`
              : error ? 'Allocation unavailable.' : 'Analyzing holdings…'}
          </p>
        </div>
        {showGrid && (
          <button type="button" className={arranging ? 'btn-primary btn-sm' : 'btn-ghost btn-sm'} aria-pressed={arranging}
            onClick={() => setArranging(a => !a)} style={{ minHeight: 32 }}
            title={arranging ? 'Finish arranging (Esc)' : 'Show the handles to reorder and resize the cards'}>
            {arranging ? 'Done' : 'Arrange'}
          </button>
        )}
      </div>

      <nav className="fc-jump" aria-label="Investments sections">
        <div className="fc-jump-row">
          {jumps.map(([id, label]) => <a key={id} href={`#${id}`} className="fc-jump-link" onClick={e => jumpTo(id, e)}>{label}</a>)}
        </div>
      </nav>

      <section id="inv-overview" className="fc-anchor" tabIndex={-1} aria-label="Overview" style={{ outline: 'none', marginBottom: 20 }}>
        {data && hasAccounts && (
          <HeadlineTiles invested={inv.total} accounts={inv.accounts} gain={gain} off={off} band={status.band}
            hasTargets={!!status.model} customTargetsSaved={customTargetsSaved} fees={fees.data} feesLoading={fees.loading} money={money} privacy={privacy}
            perf={perf.data} perfRange={perfRange} onJump={id => jumpTo(id)} />
        )}
        <PerformanceChart perf={perf} privacy={privacy} sel={perfRange} onSel={setPerfRange} />
      </section>

      {/* Placeholders shaped like the card grid, so nothing jumps when it arrives. */}
      {loading && !data && (
        <div role="status" aria-busy="true" aria-label="Loading allocation (fetching security data)" className="stack-mobile"
          style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
          <SkeletonStyles />
          <SkeletonCard height={420} rows={5} />
          <SkeletonCard height={420} rows={5} />
          <div style={{ gridColumn: '1 / -1' }}><SkeletonCard height={360} rows={5} /></div>
        </div>
      )}
      {error && (
        <p role="alert" style={{ color: 'var(--red)', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          Failed to load allocation: {error}
          <button className="btn-ghost" onClick={() => refetch()} style={{ fontSize: 12, padding: '4px 12px' }}>Retry</button>
        </p>
      )}
      {actionError && <p role="alert" style={{ color: 'var(--red)', fontSize: 13, marginBottom: 12 }}>{actionError}</p>}
      {data && !showGrid && (
        <div style={{ ...CARD, color: 'var(--muted)', fontSize: 14 }}>
          Connect a brokerage account (Dashboard → Manage connections) to see your allocation.
        </div>
      )}

      {showGrid && (
        <div className={'stack-mobile' + (arranging ? ' inv-arranging' : '')} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, alignItems: 'stretch' }}>
          {arranging && (
            <p role="status" className="inv-callout" style={{ gridColumn: '1 / -1' }}>
              Drag ⠿ (or focus it and use the arrow keys) to rearrange · click ⤢ / ⤡ to resize a card · press Done (or Esc) when finished.
            </p>
          )}
          <p role="status" aria-live="polite" style={SR_ONLY}>{arranging ? moveNote : ''}</p>
          <span id={handleHelpId} hidden>Use the arrow keys to move this card earlier or later.</span>
          {keys.map(key => (
            <div key={key} id={ANCHOR[key]} className={'inv-cell' + (ANCHOR[key] ? ' fc-anchor' : '')} tabIndex={ANCHOR[key] ? -1 : undefined}
              onDragOver={arranging ? e => { e.preventDefault(); if (dragOver !== key) setDragOver(key); } : undefined}
              onDragLeave={arranging ? () => setDragOver(d => (d === key ? null : d)) : undefined}
              onDrop={arranging ? e => { e.preventDefault(); const from = e.dataTransfer.getData('text/plain'); setDragOver(null); if (from) reorder(from, key, keys); } : undefined}
              style={{
                position: 'relative', borderRadius: 12, minWidth: 0, outlineOffset: 4,
                // A jump-row link focuses the card; no ring for that (as on the Forecast).
                outline: dragOver === key ? '2px dashed var(--accent)' : arranging ? undefined : 'none',
                ...(isFull(key) || fillsRow.has(key) ? { gridColumn: '1 / -1' } : {}),
              }}
            >
              {/* Reorder / resize controls sit in the card's right padding strip,
                  so they're never clipped off-screen on narrow layouts. */}
              {arranging && (
                <div className="inv-handles">
                  {/* A focusable control (a span, not a <button>: some browsers
                      won't start a drag from a button), moved with the arrow keys. */}
                  <span ref={el => { handleRefs.current[key] = el; }} className="grab" role="button" tabIndex={0}
                    aria-label={`Move ${CARD_NAME[key] ?? key}`} aria-keyshortcuts="ArrowUp ArrowDown Home End"
                    aria-describedby={handleHelpId}
                    draggable onDragStart={e => e.dataTransfer.setData('text/plain', key)}
                    onKeyDown={e => moveByKey(e, key, keys)}
                    title="Drag, or use the arrow keys, to reorder">⠿</span>
                  <button type="button" onClick={() => toggleWidth(key)}
                    aria-label={isFull(key) ? 'Shrink to half width' : 'Expand to full width'}
                    title={isFull(key) ? 'Shrink to half width'
                      : fillsRow.has(key) ? 'Full width because nothing sits beside it. Click to keep it full width.'
                      : 'Expand to full width'}>
                    {isFull(key) ? '⤡' : '⤢'}
                  </button>
                </div>
              )}
              {sectionNodes[key]}
            </div>
          ))}
        </div>
      )}

      {showRisk && (
        <RiskQuestionnaire
          initialProfile={riskProfileId}
          onClose={() => setShowRisk(false)}
          onApply={id => { setRiskProfileId(id); if (targetsPref.mode === 'custom') updateTargets({ mode: 'profile' }); }}
          onClear={() => setRiskProfileId(null)}
        />
      )}

      {classifyHolding && data && (
        <ClassifyModal
          target={{ id: classifyId!, symbol: classifyHolding.symbol, name: classifyHolding.name, currentClass: classifyHolding.assetClass, overridden: classifyHolding.overridden }}
          classes={data.assetClasses}
          onClose={() => setClassifyId(null)}
          onSaved={refreshAll}
        />
      )}

      {editBasisHolding && (
        <CostBasisModal
          target={{
            id: editBasisId!, symbol: editBasisHolding.symbol, name: editBasisHolding.name,
            value: editBasisHolding.value, costBasis: editBasisHolding.costBasis, edited: editBasisHolding.costBasisSource === 'manual',
          }}
          money={money}
          privacy={privacy}
          onClose={() => setEditBasisId(null)}
          onSaved={refreshAll}
        />
      )}
    </div>
  );
}
