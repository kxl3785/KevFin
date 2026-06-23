import { useMemo, useRef, useState, useEffect } from 'react';
import { ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Legend } from 'recharts';
import { useApi } from '../hooks/useApi.ts';
import { usePersistentState } from '../hooks/usePersistentState.ts';
import TopNav, { type View } from '../components/TopNav.tsx';
import { MONTE_CARLO_RUNS } from '../lib/forecastConfig.ts';

interface Snapshot { date: string; accounts_total: number; real_estate_total: number; net_worth: number }
interface Projection {
  months: { month: string; spending: number; income: number }[];
  monthsAnalyzed: number;
  avgMonthlySpending: number;
  avgMonthlyIncome: number;
  trendPctPerYear: number;
  byCategory: { category: string; avgMonthly: number }[];
}

type TaxBucket = 'taxable' | 'pretax' | 'roth' | 'hsa' | 'college';
interface TaxAccount { id: string; name: string; org_name: string; balance: number; bucket: TaxBucket }
interface TaxBucketsResp { buckets: TaxBucket[]; totals: Record<TaxBucket, number>; accounts: TaxAccount[] }

const BUCKET_META: Record<TaxBucket, { label: string; color: string; hint: string }> = {
  taxable: { label: 'Taxable', color: '#6c8fff', hint: 'Brokerage, checking, savings — withdraw first, no penalty.' },
  pretax: { label: 'Pre-tax', color: '#fbbf24', hint: '401(k)/403(b)/IRA — taxed on withdrawal, 10% penalty before 59½, RMDs at 73.' },
  roth: { label: 'Roth', color: '#4ade80', hint: 'Roth IRA/401(k) — tax-free growth & withdrawals.' },
  hsa: { label: 'HSA', color: '#f472b6', hint: 'Triple tax-advantaged — left to grow until needed last.' },
  college: { label: '529', color: '#a78bfa', hint: 'Education savings — spent first on college costs.' },
};

// Only one-time & recurring expenses (and income raises) live as draggable chips.
// Retirement is now per-earner (below), not a chip.
type EventType = 'oneTime' | 'recurring' | 'income';
interface LifeEvent { id: string; label: string; icon: string; type: EventType; age: number; amount: number; untilAge?: number }
const EVENT_TYPE_META: Record<EventType, { icon: string; label: string }> = {
  oneTime: { icon: '💸', label: 'One-time cost' },
  recurring: { icon: '🔁', label: 'Recurring expense / yr' },
  income: { icon: '📈', label: 'Income raise / yr' },
};

interface Earner {
  label: string;
  enabled: boolean;          // earner 0 is always on; this gates earner 1
  currentAge: number;        // earner 1's age (earner 0 uses Assumptions.currentAge)
  income: number;            // gross, today's $
  retireAge: number;
  pretax: number;            // employee 401k/403b deferral, today's $/yr
  employer: number;          // employer match/contribution, today's $/yr
  roth: number;              // Roth IRA/401k, today's $/yr
  hsa: number;               // HSA, today's $/yr
  ssEnabled: boolean; ssClaimAge: number; ssAnnual: number; // Social Security, today's $/yr
}

interface Assumptions {
  currentAge: number; endAge: number;
  investReturn: number; volatility: number; realEstateGrowth: number; inflation: number;
  annualSpending: number;
  costPerKid: number; kidIndependentAge: number;
  // taxes & contribution limits (today's $)
  effTaxRate: number; retireTaxRate: number;
  k401EmployeeMax: number; k401EmployerMax: number; iraMax: number; hsaMax: number;
  limitGrowth: number; // annual increase in IRS contribution limits
  // college
  collegeCostPerYear: number; collegeYears: number; collegeStartAge: number; eduInflation: number;
  // legacy (kept so old persisted state still parses; earner 0 income now lives in `earners`)
  annualIncome?: number;
}

const DEFAULT_ASSUMPTIONS: Assumptions = {
  currentAge: 40, endAge: 90, investReturn: 0.07, volatility: 0.15, realEstateGrowth: 0.04, inflation: 0.03,
  annualSpending: 70000, costPerKid: 18000, kidIndependentAge: 22,
  effTaxRate: 0.24, retireTaxRate: 0.15,
  k401EmployeeMax: 23500, k401EmployerMax: 46500, iraMax: 7000, hsaMax: 8550, limitGrowth: 0.02,
  collegeCostPerYear: 30000, collegeYears: 4, collegeStartAge: 18, eduInflation: 0.05,
};

const DEFAULT_EARNERS: Earner[] = [
  { label: 'You', enabled: true, currentAge: 40, income: 180000, retireAge: 65, pretax: 23500, employer: 12000, roth: 7000, hsa: 8550, ssEnabled: true, ssClaimAge: 67, ssAnnual: 36000 },
  { label: 'Partner', enabled: false, currentAge: 38, income: 120000, retireAge: 65, pretax: 23500, employer: 8000, roth: 7000, hsa: 0, ssEnabled: true, ssClaimAge: 67, ssAnnual: 30000 },
];

const DEFAULT_EVENTS: LifeEvent[] = [
  { id: 'home', label: 'Buy a home', icon: '🏠', type: 'oneTime', age: 44, amount: 150000 },
  { id: 'income', label: 'Income raise', icon: '📈', type: 'income', age: 50, amount: 40000 },
  { id: 'expense', label: 'New expense', icon: '💳', type: 'recurring', age: 55, amount: 12000 },
];

// Average US college sticker prices (today's $, ~2024). Tuition & fees vs the
// all-in cost including room & board, for public (in-state) vs private.
const COLLEGE_PRESETS: { label: string; value: number }[] = [
  { label: 'Public · tuition', value: 11000 },
  { label: 'Public · all-in', value: 28000 },
  { label: 'Private · tuition', value: 43000 },
  { label: 'Private · all-in', value: 62000 },
];
// Approx S&P 500 nominal annualized return & volatility over trailing windows,
// with matching CPI inflation and home-price growth. Rough, for quick scenarios.
const MARKET_PRESETS: { label: string; investReturn: number; volatility: number; inflation: number; realEstateGrowth: number }[] = [
  { label: 'Last 5y', investReturn: 0.14, volatility: 0.18, inflation: 0.04, realEstateGrowth: 0.06 },
  { label: 'Last 10y', investReturn: 0.125, volatility: 0.15, inflation: 0.03, realEstateGrowth: 0.05 },
  { label: 'Last 20y', investReturn: 0.10, volatility: 0.16, inflation: 0.025, realEstateGrowth: 0.05 },
];

// Which contribution-limit assumptions apply to each tax bucket (shown next to
// the bucket in the Accounts card). Taxable/529 have no federal contribution cap.
const BUCKET_LIMITS: Partial<Record<TaxBucket, { label: string; key: keyof Assumptions }[]>> = {
  pretax: [{ label: 'Employee', key: 'k401EmployeeMax' }, { label: 'Employer', key: 'k401EmployerMax' }],
  roth: [{ label: 'Max', key: 'iraMax' }],
  hsa: [{ label: 'Max', key: 'hsaMax' }],
};

const TABS = ['Net Worth', 'Cash Flow', 'Success %'] as const;
type Tab = typeof TABS[number];
const RUNS = MONTE_CARLO_RUNS;
const PLOT_LEFT = 60, PLOT_RIGHT = 16;

function randn() { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function pctile(sorted: number[], p: number) { return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))]; }
// IRS-style RMD: roughly 1/(remaining life expectancy). Kicks in at 73.
function rmdFactor(age: number) { return age >= 73 ? 1 / Math.max(2, 27.4 - (age - 73)) : 0; }

// Number input that keeps a blank field blank while editing (instead of snapping
// to 0). Commits only when the text parses to a number; the model keeps its last
// value while blank. Shows a "required" hint when blank and required.
function NumberInput({ value, onCommit, mul = 1, step, width = 100, required = true, prefix, suffix, title }: {
  value: number; onCommit: (n: number) => void; mul?: number; step?: number; width?: number;
  required?: boolean; prefix?: string; suffix?: string; title?: string;
}) {
  const fmt = (v: number) => String(Math.round(v * mul * 100) / 100);
  const [text, setText] = useState(() => fmt(value));
  const last = useRef(value);
  useEffect(() => {
    if (Math.abs(value - last.current) > 1e-9) { last.current = value; setText(fmt(value)); }
  }, [value, mul]); // eslint-disable-line react-hooks/exhaustive-deps
  const empty = text.trim() === '';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      {required && empty && <span style={{ fontSize: 10, color: 'var(--red)' }}>required</span>}
      {prefix && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{prefix}</span>}
      <input type="number" step={step} title={title} value={text}
        onChange={e => {
          const raw = e.target.value;
          setText(raw);
          if (raw.trim() === '') return; // leave blank — don't insert 0
          const n = parseFloat(raw);
          if (!isNaN(n)) { last.current = n / mul; onCommit(n / mul); }
        }}
        style={{ fontSize: 13, padding: '3px 6px', width, textAlign: 'right', borderColor: required && empty ? 'var(--red)' : undefined }} />
      {suffix && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{suffix}</span>}
    </span>
  );
}

export default function Forecast({ onNavigate, privacy, onTogglePrivacy }: {
  onNavigate: (v: View) => void; privacy: boolean; onTogglePrivacy: () => void;
}) {
  const { data: hist } = useApi<Snapshot[]>('/api/net-worth/history?days=10000');
  const { data: projection } = useApi<Projection>('/api/budget/projection');
  const { data: taxData } = useApi<TaxBucketsResp>('/api/net-worth/tax-buckets');
  const latest = hist?.[0];
  const baseAccounts = latest?.accounts_total ?? 0;
  const baseRE = latest?.real_estate_total ?? 0;
  const currentNW = baseAccounts + baseRE;

  const [tab, setTab] = usePersistentState<Tab>('mon.fcTab', 'Net Worth');
  const [a, setA] = usePersistentState<Assumptions>('mon.fcAssumptions', DEFAULT_ASSUMPTIONS);
  const [earners, setEarners] = usePersistentState<Earner[]>('mon.fcEarners', DEFAULT_EARNERS);
  const [events, setEvents] = usePersistentState<LifeEvent[]>('mon.fcEvents', DEFAULT_EVENTS);
  const [kidAges, setKidAges] = usePersistentState<number[]>('mon.fcKidAges', []);
  const [bucketOverrides, setBucketOverrides] = usePersistentState<Record<string, TaxBucket>>('mon.fcBucketOverrides', {});
  const [hsaLast, setHsaLast] = usePersistentState('mon.fcHsaLast', true);
  const [maxContrib, setMaxContrib] = usePersistentState('mon.fcMaxContrib', false);
  const [collegeOn, setCollegeOn] = usePersistentState('mon.fcCollegeOn', true);
  const [seeded, setSeeded] = usePersistentState('mon.fcSeeded', false);
  const [showAccounts, setShowAccounts] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null); // open life-event editor

  // Backfill any assumption fields added after a user's state was persisted.
  const A = { ...DEFAULT_ASSUMPTIONS, ...a };
  const infl = A.inflation, costPerKid = A.costPerKid, kidIndependentAge = A.kidIndependentAge;
  // Timeline is driven by earner 0's current age (both earners now show the row).
  const currentAge0 = earners[0]?.currentAge ?? A.currentAge;

  // Drop any events persisted under the old schema (e.g. the retired 'retire'
  // type) so they don't render as dead chips. Runs once on mount.
  useEffect(() => {
    setEvents(prev => {
      const valid = prev.filter(e => e.type === 'oneTime' || e.type === 'recurring' || e.type === 'income');
      return valid.length === prev.length ? prev : valid;
    });
    // Earner 0's age used to live in Assumptions.currentAge — carry it over.
    if (a.currentAge != null) setEarners(prev => prev.map((e, i) => (i === 0 && e.currentAge !== a.currentAge ? { ...e, currentAge: a.currentAge } : e)));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Seed income/spending from real transaction data, once.
  useEffect(() => {
    if (projection && projection.monthsAnalyzed > 0 && !seeded) {
      setSeeded(true);
      if (projection.avgMonthlySpending > 0) setA(prev => ({ ...DEFAULT_ASSUMPTIONS, ...prev, annualSpending: projection.avgMonthlySpending * 12 }));
      if (projection.avgMonthlyIncome > 0) setEarners(prev => prev.map((e, i) => (i === 0 ? { ...e, income: projection.avgMonthlyIncome * 12 } : e)));
    }
  }, [projection, seeded, setA, setEarners, setSeeded]);

  const money = (n: number) => (privacy ? '••••••' : (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString());
  const moneyM = (n: number) => (privacy ? '•••' : '$' + (Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : Math.round(n / 1000) + 'k'));

  const bucketOf = (acc: TaxAccount): TaxBucket => bucketOverrides[acc.id] ?? acc.bucket;

  // Starting pool balances by tax bucket, scaled so their sum equals the
  // dashboard's accounts total (keeps the headline consistent).
  const pools0 = useMemo(() => {
    const raw: Record<TaxBucket, number> = { taxable: 0, pretax: 0, roth: 0, hsa: 0, college: 0 };
    for (const acc of taxData?.accounts ?? []) raw[bucketOf(acc)] += acc.balance;
    const sum = raw.taxable + raw.pretax + raw.roth + raw.hsa + raw.college;
    if (sum <= 0) return { taxable: baseAccounts, pretax: 0, roth: 0, hsa: 0, college: 0 };
    const scale = baseAccounts / sum;
    return { taxable: raw.taxable * scale, pretax: raw.pretax * scale, roth: raw.roth * scale, hsa: raw.hsa * scale, college: raw.college * scale };
  }, [taxData, bucketOverrides, baseAccounts]); // eslint-disable-line react-hooks/exhaustive-deps

  const sim = useMemo(() => {
    const years = Math.max(1, A.endAge - currentAge0 + 1);
    const kidDrop = (i: number) => kidAges.reduce((s, k) => s + (k < kidIndependentAge && k + i >= kidIndependentAge ? costPerKid : 0), 0);
    const recurringAt = (age0: number) => events.filter(e => e.type === 'recurring' && age0 >= e.age && age0 <= (e.untilAge ?? A.endAge)).reduce((t, e) => t + e.amount, 0);

    // --- Deterministic per-year flows (today's $ → nominal via inflation) ------
    // Income, contributions, taxes, spending and college are all deterministic;
    // only investment growth (and thus solvency) is random. Precompute once.
    const yr = Array.from({ length: years }, (_, i) => {
      const f = Math.pow(1 + infl, i);                          // general inflation
      const limF = Math.pow(1 + A.limitGrowth, i);              // IRS limit growth
      const age0 = currentAge0 + i;
      const raises = events.filter(e => e.type === 'income' && e.age <= age0).reduce((t, e) => t + e.amount, 0);
      // Contribution caps for this year, grown by the limit-increase rate.
      const preLim = A.k401EmployeeMax * limF, empLim = A.k401EmployerMax * limF, rothLim = A.iraMax * limF, hsaLim = A.hsaMax * limF;

      let grossN = 0, ssN = 0, preEmpN = 0, empN = 0, rothN = 0, hsaN = 0;
      earners.forEach((e, idx) => {
        const on = idx === 0 ? true : e.enabled;
        if (!on) return;
        const eAge = e.currentAge + i;
        if (eAge < e.retireAge) {
          grossN += (idx === 0 ? e.income + raises : e.income) * f;
          // "Contribute the max" caps each line at the (growing) limit; otherwise
          // the entered amount grows with inflation, still capped by the limit.
          preEmpN += maxContrib ? preLim : Math.min(e.pretax * f, preLim);
          rothN += maxContrib ? rothLim : Math.min(e.roth * f, rothLim);
          hsaN += maxContrib ? hsaLim : Math.min(e.hsa * f, hsaLim);
          empN += Math.min(e.employer * f, empLim);
        }
        if (e.ssEnabled && eAge >= e.ssClaimAge) ssN += e.ssAnnual * f;
      });
      // Can't contribute more than you earn (pre-tax + Roth + HSA come from pay).
      const empContrib = preEmpN + rothN + hsaN;
      if (grossN <= 0) { preEmpN = empN = rothN = hsaN = 0; }
      else if (empContrib > grossN) { const sc = grossN / empContrib; preEmpN *= sc; rothN *= sc; hsaN *= sc; }

      const spendN = (Math.max(0, A.annualSpending - kidDrop(i)) + recurringAt(age0)) * f;

      // College: each kid in [startAge, startAge+years). Grows at education inflation.
      let kidsInCollege = 0;
      if (collegeOn) for (const k of kidAges) { const kAge = k + i; if (kAge >= A.collegeStartAge && kAge < A.collegeStartAge + A.collegeYears) kidsInCollege++; }
      const collegeNom = kidsInCollege * A.collegeCostPerYear * Math.pow(1 + A.eduInflation, i);

      const taxableIncome = Math.max(0, grossN - preEmpN - hsaN + 0.85 * ssN);
      const tax = A.effTaxRate * taxableIncome;
      // Cash left after taxes, pre-tax & after-tax contributions and living costs.
      const net = grossN + ssN - tax - preEmpN - hsaN - rothN - spendN;
      return { f, age0, net, pretaxAdd: preEmpN + empN, rothAdd: rothN, hsaAdd: hsaN, collegeNom, grossN, ssN, spendN };
    });

    // --- Monte Carlo over investment returns ----------------------------------
    const nw: number[][] = Array.from({ length: years }, () => []);
    const invv: number[][] = Array.from({ length: years }, () => []);
    let successCount = 0;

    for (let s = 0; s < RUNS; s++) {
      let taxable = pools0.taxable, pretax = pools0.pretax, roth = pools0.roth, hsa = pools0.hsa, c529 = pools0.college;
      let re = baseRE, solvent = true;
      for (let i = 0; i < years; i++) {
        const d = yr[i];
        const ret = A.investReturn + A.volatility * randn();
        const g = 1 + ret;
        taxable *= g; pretax *= g; roth *= g; hsa *= g; c529 *= g; re *= (1 + A.realEstateGrowth);

        // Contributions in.
        pretax += d.pretaxAdd; roth += d.rothAdd; hsa += d.hsaAdd;

        // Required Minimum Distributions out of pre-tax (forced, taxed, to taxable).
        if (d.age0 >= 73 && pretax > 0) { const rmd = pretax * rmdFactor(d.age0); pretax -= rmd; taxable += rmd * (1 - A.retireTaxRate); }

        // College: 529 first, then add the remainder to this year's cash need.
        let net = d.net;
        if (d.collegeNom > 0) { const fromC529 = Math.min(c529, d.collegeNom); c529 -= fromC529; net -= (d.collegeNom - fromC529); }

        if (net >= 0) {
          taxable += net;
        } else {
          // Fund the shortfall in tax-efficient order. HSA reserved for last
          // (or moved up if "spend HSA last" is unchecked).
          let need = -net;
          const drawFlat = (bal: number) => { const t = Math.min(bal, need); need -= t; return bal - t; };
          const drawTaxed = (bal: number, rate: number) => { const grossNeed = need / (1 - rate); const t = Math.min(bal, grossNeed); need -= t * (1 - rate); return bal - t; };
          const penalty = d.age0 < 60 ? 0.10 : 0; // ~59½ early-withdrawal penalty
          taxable = drawFlat(taxable);
          if (!hsaLast && need > 0) hsa = drawFlat(hsa); // tax-free, used before pre-tax
          if (need > 0) pretax = drawTaxed(pretax, A.retireTaxRate + penalty);
          if (need > 0) roth = drawFlat(roth);
          if (hsaLast && need > 0) hsa = drawFlat(hsa);
          if (need > 1e-6) solvent = false; // ran out of money this year
        }

        const inv = Math.max(0, taxable) + Math.max(0, pretax) + Math.max(0, roth) + Math.max(0, hsa) + Math.max(0, c529);
        nw[i].push(inv + re); invv[i].push(inv);
      }
      if (solvent) successCount++;
    }

    const yearNow = new Date().getFullYear();
    const bands = nw.map((arr, i) => {
      const sNw = [...arr].sort((x, y) => x - y);
      const sInv = [...invv[i]].sort((x, y) => x - y);
      const p10 = pctile(sNw, 0.1), p90 = pctile(sNw, 0.9);
      const ip10 = pctile(sInv, 0.1), ip90 = pctile(sInv, 0.9);
      const d = yr[i];
      return {
        age: d.age0, year: yearNow + i,
        p10, p50: pctile(sNw, 0.5), band: Math.max(0, p90 - p10),
        invP10: ip10, invP50: pctile(sInv, 0.5), invBand: Math.max(0, ip90 - ip10),
        income: Math.round(d.grossN + d.ssN), spending: Math.round(d.spendN + d.collegeNom),
      };
    });
    return { bands, successPct: Math.round(successCount / RUNS * 100) };
  }, [A, currentAge0, infl, costPerKid, kidIndependentAge, kidAges, events, earners, pools0, baseRE, hsaLast, maxContrib, collegeOn]);

  const futureNW = sim.bands.length ? sim.bands[sim.bands.length - 1].p50 : currentNW;
  const deltaPct = currentNW ? ((futureNW - currentNW) / currentNW) * 100 : 0;
  const retireAge0 = earners[0]?.retireAge ?? 65;

  function updateEvent(id: string, patch: Partial<LifeEvent>) { setEvents(prev => prev.map(e => (e.id === id ? { ...e, ...patch } : e))); }
  function removeEvent(id: string) { setEvents(prev => prev.filter(e => e.id !== id)); }
  function updateEarner(idx: number, patch: Partial<Earner>) { setEarners(prev => prev.map((e, i) => (i === idx ? { ...e, ...patch } : e))); }
  const setNum = (key: keyof Assumptions, mul = 1) => (v: string) => setA(prev => ({ ...DEFAULT_ASSUMPTIONS, ...prev, [key]: (parseFloat(v) || 0) / mul }));

  // --- Draggable event markers over the chart ---
  const wrapRef = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(920);
  const dragId = useRef<string | null>(null);
  useEffect(() => {
    const el = wrapRef.current; if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el); setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const plotW = Math.max(1, w - PLOT_LEFT - PLOT_RIGHT);
  const ageToX = (age: number) => PLOT_LEFT + ((age - currentAge0) / Math.max(1, A.endAge - currentAge0)) * plotW;
  const xToAge = (clientX: number) => {
    if (!wrapRef.current) return currentAge0;
    const x = clientX - wrapRef.current.getBoundingClientRect().left;
    const age = Math.round(currentAge0 + ((x - PLOT_LEFT) / plotW) * (A.endAge - currentAge0));
    return Math.max(currentAge0, Math.min(A.endAge, age));
  };
  const dragMoved = useRef(false);
  useEffect(() => {
    function move(e: PointerEvent) {
      if (!dragId.current) return;
      dragMoved.current = true;
      updateEvent(dragId.current, { age: xToAge(e.clientX) });
    }
    function up() {
      // A press without movement is a click — open that marker's editor.
      if (dragId.current && !dragMoved.current) setEditingId(dragId.current);
      dragId.current = null; dragMoved.current = false;
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, [currentAge0, A.endAge, plotW]); // eslint-disable-line react-hooks/exhaustive-deps

  // Click empty chart area to insert a new event at that age, then edit it.
  function addEventAt(clientX: number) {
    const age = xToAge(clientX);
    const id = 'e' + Date.now();
    setEvents(prev => [...prev, { id, label: 'Event', icon: EVENT_TYPE_META.oneTime.icon, type: 'oneTime', age, amount: 10000 }]);
    setEditingId(id);
  }
  const editingEvent = events.find(e => e.id === editingId) ?? null;

  // Retirement reference ages (for chart markers).
  const retireMarks = earners.map((e, i) => (i === 0 || e.enabled ? e.retireAge : null)).filter((x): x is number => x != null);

  const numRow = (label: string, key: keyof Assumptions, step: number, mul: number, prefix?: string, suffix?: string) => (
    <div key={key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0' }}>
      <span style={{ fontSize: 13, color: 'var(--muted)' }}>{label}</span>
      <NumberInput value={A[key] as number} mul={mul} step={step} width={104} prefix={prefix} suffix={suffix}
        onCommit={n => setA(prev => ({ ...DEFAULT_ASSUMPTIONS, ...prev, [key]: n }))} />
    </div>
  );

  const card: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 20, marginBottom: 20 };

  return (
    <div style={{ maxWidth: 960, margin: '0 auto', padding: '32px 24px' }}>
      <TopNav view="forecast" onNavigate={onNavigate} privacy={privacy} onTogglePrivacy={onTogglePrivacy} />
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.5px' }}>Forecast</h1>
        <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 4 }}>Monte Carlo projection ({RUNS} runs) across tax-treatment buckets. Click the chart to add a life event; click a marker to edit or remove it, or drag it to move.</p>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {TABS.map(t => <button key={t} onClick={() => setTab(t)} className={tab === t ? 'btn-primary' : 'btn-ghost'} style={{ fontSize: 13 }}>{t}</button>)}
      </div>

      <div style={{ display: 'flex', gap: 40, marginBottom: 16, flexWrap: 'wrap' }}>
        <div><p style={{ color: 'var(--muted)', fontSize: 13 }}>Current net worth</p><p style={{ fontSize: 26, fontWeight: 700 }}>{money(currentNW)}</p></div>
        <div>
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>Median at age {A.endAge}</p>
          <p style={{ fontSize: 26, fontWeight: 700 }}>{money(futureNW)}</p>
          <p style={{ fontSize: 13, fontWeight: 600, color: deltaPct >= 0 ? 'var(--green)' : 'var(--red)' }}>{money(futureNW - currentNW)} ({deltaPct >= 0 ? '+' : ''}{Math.round(deltaPct)}%)</p>
        </div>
        <div>
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>Success probability</p>
          <p style={{ fontSize: 26, fontWeight: 700, color: sim.successPct >= 90 ? 'var(--green)' : sim.successPct >= 70 ? 'var(--amber)' : 'var(--red)' }}>{sim.successPct}%</p>
        </div>
      </div>

      {/* Chart with draggable markers */}
      <div style={card}>
        <div ref={wrapRef} style={{ position: 'relative' }}>
          <div onClick={e => addEventAt(e.clientX)} title="Click to add a life event"
            style={{ width: '100%', height: 360, filter: privacy ? 'blur(7px)' : 'none', cursor: 'crosshair' }}>
            <ResponsiveContainer>
              <ComposedChart data={sim.bands} margin={{ top: 34, right: PLOT_RIGHT, left: 8, bottom: 0 }}>
                <defs>
                  <linearGradient id="gBand" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#6c8fff" stopOpacity={0.18} />
                    <stop offset="100%" stopColor="#6c8fff" stopOpacity={0.04} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#2a2d3a" />
                <XAxis dataKey="age" tick={{ fill: '#7b7f95', fontSize: 11 }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fill: '#7b7f95', fontSize: 11 }} tickLine={false} axisLine={false} width={52} tickFormatter={moneyM} />
                <Tooltip contentStyle={{ background: '#1a1d27', border: '1px solid #2a2d3a', borderRadius: 8 }}
                  labelFormatter={age => `Age ${age}`} formatter={(v: number, n) => [money(v), n]} />
                <Legend wrapperStyle={{ fontSize: 12, color: '#7b7f95' }} />
                {events.map(e => <ReferenceLine key={e.id} x={e.age} stroke="#4a4d5a" strokeDasharray="2 4" />)}
                {retireMarks.map((age, i) => <ReferenceLine key={'r' + i} x={age} stroke="#f59e0b" strokeDasharray="4 3" />)}
                {tab === 'Net Worth' && <>
                  <Area dataKey="p10" stackId="nw" stroke="none" fill="transparent" name=" " legendType="none" />
                  <Area dataKey="band" stackId="nw" stroke="none" fill="url(#gBand)" name="10–90% range" />
                  <Line dataKey="p50" name="Median net worth" stroke="#6c8fff" strokeWidth={2.5} dot={false} />
                </>}
                {tab === 'Cash Flow' && <>
                  <Line dataKey="income" name="Income + SS" stroke="#4ade80" strokeWidth={2} dot={false} />
                  <Line dataKey="spending" name="Spending" stroke="#f87171" strokeWidth={2} dot={false} />
                </>}
                {tab === 'Success %' && <>
                  <Area dataKey="invP10" stackId="iv" stroke="none" fill="transparent" name=" " legendType="none" />
                  <Area dataKey="invBand" stackId="iv" stroke="none" fill="url(#gBand)" name="10–90% range" />
                  <Line dataKey="invP50" name="Median investable assets" stroke="#fbbf24" strokeWidth={2.5} dot={false} />
                  <ReferenceLine y={0} stroke="#f87171" strokeWidth={1.5} />
                </>}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          {/* Draggable event chips — click to edit, drag to move */}
          {events.map((e, i) => (
            <div key={e.id}
              onPointerDown={ev => { ev.preventDefault(); ev.stopPropagation(); dragId.current = e.id; dragMoved.current = false; }}
              title={`${e.label} · age ${e.age} — click to edit, drag to move`}
              style={{
                position: 'absolute', left: ageToX(e.age), top: 2 + (i % 3) * 24, transform: 'translateX(-50%)',
                display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap',
                background: editingId === e.id ? 'var(--accent)' : 'var(--bg)', border: '1px solid var(--border)', borderRadius: 14, padding: '2px 8px',
                fontSize: 11, cursor: 'grab', userSelect: 'none', touchAction: 'none', zIndex: 10,
                boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
              }}>
              <span>{e.icon}</span><span>{e.label}</span>
            </div>
          ))}
          {/* Inline editor popover for the selected event */}
          {editingEvent && (
            <div onClick={ev => ev.stopPropagation()}
              style={{
                position: 'absolute', left: Math.max(118, Math.min(w - 118, ageToX(editingEvent.age))), top: 86,
                transform: 'translateX(-50%)', width: 232, zIndex: 30,
                background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: 12,
                boxShadow: '0 10px 28px rgba(0,0,0,0.55)',
              }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>Life event · age {editingEvent.age}</span>
                <span onClick={() => setEditingId(null)} title="Close" style={{ cursor: 'pointer', color: 'var(--muted)', fontSize: 16, lineHeight: 1 }}>×</span>
              </div>
              <input value={editingEvent.label} onChange={ev => updateEvent(editingEvent.id, { label: ev.target.value })}
                placeholder="Label" style={{ fontSize: 13, padding: '4px 8px', width: '100%', marginBottom: 8 }} />
              <select value={editingEvent.type}
                onChange={ev => { const t = ev.target.value as EventType; updateEvent(editingEvent.id, { type: t, icon: EVENT_TYPE_META[t].icon }); }}
                style={{ fontSize: 13, padding: '4px 6px', width: '100%', marginBottom: 8 }}>
                {(Object.keys(EVENT_TYPE_META) as EventType[]).map(t => <option key={t} value={t}>{EVENT_TYPE_META[t].icon} {EVENT_TYPE_META[t].label}</option>)}
              </select>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: editingEvent.type === 'recurring' ? 8 : 10 }}>
                <span style={{ fontSize: 13, color: 'var(--muted)' }}>{editingEvent.type === 'income' ? 'Raise' : 'Amount'}</span>
                <NumberInput value={editingEvent.amount} prefix="$" required={false} onCommit={n => updateEvent(editingEvent.id, { amount: n })} />
              </div>
              {editingEvent.type === 'recurring' && (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <span style={{ fontSize: 13, color: 'var(--muted)' }}>Until age</span>
                  <NumberInput value={editingEvent.untilAge ?? A.endAge} required={false} onCommit={n => updateEvent(editingEvent.id, { untilAge: n })} />
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <button className="btn-ghost" style={{ fontSize: 12, color: 'var(--red)' }}
                  onClick={() => { removeEvent(editingEvent.id); setEditingId(null); }}>Remove</button>
                <button className="btn-primary" style={{ fontSize: 12 }} onClick={() => setEditingId(null)}>Done</button>
              </div>
            </div>
          )}
        </div>
        {tab === 'Success %' && (
          <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 8 }}>
            Success = share of {RUNS} simulated futures where your assets never hit $0 (returns sampled each year from {Math.round(A.investReturn * 100)}% ± {Math.round(A.volatility * 100)}%). Orange dashed lines mark retirement ages. The shaded band is the 10–90% outcome range.
          </p>
        )}
      </div>

      {/* Summary */}
      <div style={card}>
        <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>✦ Summary</p>
        <p style={{ fontSize: 14, lineHeight: 1.5 }}>{summarize(A, retireAge0, futureNW, currentNW, sim.successPct)}</p>
      </div>

      {/* Earners & retirement */}
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h2 style={{ fontSize: 15, fontWeight: 600 }}>Earners & retirement</h2>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--muted)', cursor: 'pointer' }}>
            <input type="checkbox" checked={earners[1]?.enabled ?? false} onChange={e => updateEarner(1, { enabled: e.target.checked })} style={{ width: 'auto' }} />
            Two earners
          </label>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: earners[1]?.enabled ? '1fr 1fr' : '1fr', gap: 20 }}>
          {earners.map((e, idx) => (idx === 0 || e.enabled) && (
            <div key={idx} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 14 }}>
              <input value={e.label} onChange={ev => updateEarner(idx, { label: ev.target.value })}
                style={{ fontSize: 14, fontWeight: 600, padding: '3px 6px', marginBottom: 8 }} />
              {([
                ['Current age', 'currentAge', ''],
                ['Gross income / yr', 'income', '$'],
                ['Retire at age', 'retireAge', ''],
              ] as [string, keyof Earner, string][]).map(([label, key, pre]) => (
                <div key={key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0' }}>
                  <span style={{ fontSize: 13, color: 'var(--muted)' }}>{label}</span>
                  <NumberInput value={e[key] as number} prefix={pre || undefined}
                    onCommit={n => updateEarner(idx, { [key]: n } as Partial<Earner>)} />
                </div>
              ))}
              {/* Expected annual contributions (capped lines lock to the max when enabled) */}
              <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.4, margin: '8px 0 2px' }}>Expected annual contributions</p>
              {([
                ['401(k) / 403(b) employee', 'pretax', 'k401EmployeeMax', true],
                ['Employer match', 'employer', null, false],
                ['Roth IRA', 'roth', 'iraMax', true],
                ['HSA', 'hsa', 'hsaMax', true],
              ] as [string, keyof Earner, keyof Assumptions | null, boolean][]).map(([label, key, capKey, capped]) => {
                const locked = capped && maxContrib;
                return (
                  <div key={key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0' }}>
                    <span style={{ fontSize: 13, color: 'var(--muted)' }}>{label}{locked && <span style={{ marginLeft: 4, fontSize: 10, color: 'var(--accent)' }}>MAX</span>}</span>
                    {locked && capKey
                      ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, opacity: 0.55 }}>
                          <span style={{ fontSize: 12, color: 'var(--muted)' }}>$</span>
                          <input type="number" value={A[capKey] as number} disabled style={{ fontSize: 13, padding: '3px 6px', width: 100, textAlign: 'right' }} />
                        </span>
                      : <NumberInput value={e[key] as number} prefix="$" required={false}
                          onCommit={n => updateEarner(idx, { [key]: n } as Partial<Earner>)} />}
                  </div>
                );
              })}
              {/* Social Security */}
              <div style={{ borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 8 }}>
                <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, color: 'var(--muted)', cursor: 'pointer', padding: '2px 0' }}>
                  <span>🏛️ Social Security</span>
                  <input type="checkbox" checked={e.ssEnabled} onChange={ev => updateEarner(idx, { ssEnabled: ev.target.checked })} style={{ width: 'auto' }} />
                </label>
                {e.ssEnabled && (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0' }}>
                      <span style={{ fontSize: 13, color: 'var(--muted)' }}>Claim at age</span>
                      <NumberInput value={e.ssClaimAge} onCommit={n => updateEarner(idx, { ssClaimAge: n })} />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0' }}>
                      <span style={{ fontSize: 13, color: 'var(--muted)' }}>Benefit / yr</span>
                      <NumberInput value={e.ssAnnual} prefix="$" required={false} onCommit={n => updateEarner(idx, { ssAnnual: n })} />
                    </div>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
        <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>Each earner's income stops at their retirement age. Contributions are capped by the limits below{maxContrib ? ' (currently maxed for every earner)' : ''} and grow with inflation. Today's dollars.</p>
      </div>

      {/* Accounts by tax treatment + contribution limits (merged) */}
      {taxData && (
        <div style={card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h2 style={{ fontSize: 15, fontWeight: 600 }}>Accounts & contributions</h2>
            {taxData.accounts.length > 0 && (
              <button className="btn-ghost" style={{ fontSize: 12 }} onClick={() => setShowAccounts(s => !s)}>{showAccounts ? 'Hide accounts' : 'Reassign accounts'}</button>
            )}
          </div>
          {/* Bucket totals bar */}
          {taxData.accounts.length > 0 && (
            <div style={{ display: 'flex', height: 12, borderRadius: 6, overflow: 'hidden', marginBottom: 12 }}>
              {(['taxable', 'pretax', 'roth', 'hsa', 'college'] as TaxBucket[]).map(b => {
                const pct = baseAccounts > 0 ? (pools0[b] / baseAccounts) * 100 : 0;
                return pct > 0 ? <div key={b} title={`${BUCKET_META[b].label}: ${money(pools0[b])}`} style={{ width: `${pct}%`, background: BUCKET_META[b].color }} /> : null;
              })}
            </div>
          )}
          {/* Per-bucket: balance + the contribution limit(s) that apply to it */}
          <div style={{ display: 'grid', gap: 2 }}>
            {(['taxable', 'pretax', 'roth', 'hsa', 'college'] as TaxBucket[]).map(b => (
              <div key={b} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', flexWrap: 'wrap' }}>
                <span title={BUCKET_META[b].hint} style={{ width: 9, height: 9, borderRadius: 2, background: BUCKET_META[b].color, display: 'inline-block', flex: '0 0 auto' }} />
                <span title={BUCKET_META[b].hint} style={{ fontSize: 13, color: 'var(--muted)', width: 64 }}>{BUCKET_META[b].label}</span>
                <span style={{ fontSize: 13, fontWeight: 600, width: 96, textAlign: 'right' }}>{taxData.accounts.length > 0 ? money(pools0[b]) : ''}</span>
                <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 12, alignItems: 'center' }}>
                  {(BUCKET_LIMITS[b] ?? []).map(lim => (
                    <span key={lim.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <span style={{ fontSize: 11, color: 'var(--muted)' }}>{lim.label}</span>
                      <NumberInput value={A[lim.key] as number} prefix="$" width={84} onCommit={n => setA(prev => ({ ...DEFAULT_ASSUMPTIONS, ...prev, [lim.key]: n }))} />
                    </span>
                  ))}
                </span>
              </div>
            ))}
          </div>
          {/* Global contribution settings */}
          <div style={{ borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 8 }}>
            {numRow('Contribution limit growth / yr %', 'limitGrowth', 0.5, 100, '', '%')}
            <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0 2px', fontSize: 13, color: 'var(--muted)', cursor: 'pointer' }}>
              <span>📈 Contribute the maximum each year</span>
              <input type="checkbox" checked={maxContrib} onChange={e => setMaxContrib(e.target.checked)} style={{ width: 'auto' }} />
            </label>
            <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0 2px', fontSize: 13, color: 'var(--muted)', cursor: 'pointer' }}>
              <span>💗 Spend HSA last (leave to grow)</span>
              <input type="checkbox" checked={hsaLast} onChange={e => setHsaLast(e.target.checked)} style={{ width: 'auto' }} />
            </label>
          </div>
          {showAccounts && taxData.accounts.length > 0 && (() => {
            // Group by institution, mirroring the dashboard's default grouping.
            const groups = new Map<string, TaxAccount[]>();
            for (const acc of taxData.accounts) { const g = groups.get(acc.org_name) ?? []; g.push(acc); groups.set(acc.org_name, g); }
            return (
              <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
                {[...groups.entries()].map(([org, accs]) => (
                  <div key={org} style={{ marginBottom: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '2px 0 4px' }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>{org}</span>
                      <span style={{ fontSize: 11, color: 'var(--muted)' }}>{money(accs.reduce((t, x) => t + x.balance, 0))}</span>
                    </div>
                    {accs.map(acc => (
                      <div key={acc.id} style={{ display: 'grid', gridTemplateColumns: '1fr 110px 130px', gap: 10, alignItems: 'center', padding: '3px 0 3px 10px', fontSize: 12 }}>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={acc.name}>{acc.name}</span>
                        <span style={{ textAlign: 'right', color: 'var(--muted)' }}>{money(acc.balance)}</span>
                        <select value={bucketOf(acc)} onChange={ev => setBucketOverrides(prev => ({ ...prev, [acc.id]: ev.target.value as TaxBucket }))}
                          style={{ fontSize: 12, padding: '2px 4px' }}>
                          {(['taxable', 'pretax', 'roth', 'hsa', 'college'] as TaxBucket[]).map(b => <option key={b} value={b}>{BUCKET_META[b].label}</option>)}
                        </select>
                      </div>
                    ))}
                  </div>
                ))}
                <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>Buckets are guessed from account names. Override any that are wrong — withdrawals draw taxable → pre-tax → Roth, with HSA reserved for last.</p>
              </div>
            );
          })()}
        </div>
      )}

      {/* Expense projection from real data */}
      {projection && projection.monthsAnalyzed > 0 && (
        <div style={card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
            <h2 style={{ fontSize: 15, fontWeight: 600 }}>Projected from your data</h2>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>{projection.monthsAnalyzed} month{projection.monthsAnalyzed === 1 ? '' : 's'} of transactions</span>
          </div>
          <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap', marginBottom: 14 }}>
            <div>
              <p style={{ color: 'var(--muted)', fontSize: 12 }}>Avg spending / yr</p>
              <p style={{ fontSize: 20, fontWeight: 700 }}>{money(projection.avgMonthlySpending * 12)}</p>
            </div>
            <div>
              <p style={{ color: 'var(--muted)', fontSize: 12 }}>Avg income / yr</p>
              <p style={{ fontSize: 20, fontWeight: 700 }}>{money(projection.avgMonthlyIncome * 12)}</p>
            </div>
            <div>
              <p style={{ color: 'var(--muted)', fontSize: 12 }}>Spending trend</p>
              <p style={{ fontSize: 20, fontWeight: 700, color: projection.trendPctPerYear > 0 ? 'var(--red)' : 'var(--green)' }}>
                {projection.trendPctPerYear >= 0 ? '+' : ''}{Math.round(projection.trendPctPerYear * 100)}%/yr
              </p>
            </div>
          </div>
          {projection.byCategory.length > 0 && (() => {
            const max = projection.byCategory[0].avgMonthly || 1;
            return (
              <div style={{ display: 'grid', gap: 6 }}>
                {projection.byCategory.slice(0, 8).map(c => (
                  <div key={c.category} style={{ display: 'grid', gridTemplateColumns: '130px 1fr 80px', gap: 10, alignItems: 'center', fontSize: 12 }}>
                    <span style={{ color: 'var(--muted)' }}>{c.category}</span>
                    <div style={{ height: 6, background: 'var(--bg)', borderRadius: 4, overflow: 'hidden' }}>
                      <div style={{ width: `${(c.avgMonthly / max) * 100}%`, height: '100%', background: '#6c8fff', borderRadius: 4 }} />
                    </div>
                    <span style={{ textAlign: 'right' }}>{money(c.avgMonthly)}/mo</span>
                  </div>
                ))}
              </div>
            );
          })()}
          <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
            <button className="btn-ghost" style={{ fontSize: 12 }}
              onClick={() => { setA(prev => ({ ...DEFAULT_ASSUMPTIONS, ...prev, annualSpending: projection.avgMonthlySpending * 12 })); updateEarner(0, { income: projection.avgMonthlyIncome * 12 }); }}>
              Use these as my income & spending
            </button>
            {projection.trendPctPerYear > 0 && (
              <button className="btn-ghost" style={{ fontSize: 12 }} onClick={() => setNum('inflation', 1)(String(projection.trendPctPerYear))}>
                Set inflation to my {Math.round(projection.trendPctPerYear * 100)}%/yr trend
              </button>
            )}
          </div>
        </div>
      )}

      {/* Editors */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        <div>
          {/* Market Assumptions */}
          <div style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
              <h2 style={{ fontSize: 15, fontWeight: 600 }}>Market Assumptions</h2>
              <div style={{ display: 'flex', gap: 6 }}>
                {MARKET_PRESETS.map(p => (
                  <button key={p.label} className="btn-ghost" style={{ fontSize: 11 }}
                    title={`S&P 500 ${p.label}: ${Math.round(p.investReturn * 100)}% return, ${Math.round(p.volatility * 100)}% vol, ${Math.round(p.inflation * 1000) / 10}% inflation`}
                    onClick={() => setA(prev => ({ ...DEFAULT_ASSUMPTIONS, ...prev, investReturn: p.investReturn, volatility: p.volatility, inflation: p.inflation, realEstateGrowth: p.realEstateGrowth }))}>
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
            {numRow('Investment return %', 'investReturn', 0.5, 100, '', '%')}
            {numRow('Return volatility %', 'volatility', 1, 100, '', '%')}
            {numRow('Real estate growth %', 'realEstateGrowth', 0.5, 100, '', '%')}
            {numRow('Inflation %', 'inflation', 0.5, 100, '', '%')}
            <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>Returns are nominal (before inflation). Everything grows with inflation, so the chart is in future dollars.</p>
          </div>

          {/* Taxes */}
          <div style={card}>
            <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Taxes</h2>
            {numRow('Tax rate while working %', 'effTaxRate', 1, 100, '', '%')}
            {numRow('Tax rate in retirement %', 'retireTaxRate', 1, 100, '', '%')}
            <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>Effective blended rates. Pre-tax withdrawals before age 60 add a 10% penalty; RMDs start at 73. Contribution limits live in “Accounts &amp; contributions” above.</p>
          </div>
        </div>

        <div>
          {/* Household: planning horizon, spending and kids */}
          <div style={card}>
            <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Household</h2>
            {numRow('Plan to age', 'endAge', 1, 1)}
            {numRow('Annual spending', 'annualSpending', 1000, 1, '$')}

            {/* Current kids — cost is already in spending; tapers off as each grows up */}
            <div style={{ borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 13, color: 'var(--muted)' }}>Current kids <span style={{ opacity: 0.6 }}>({kidAges.length})</span></span>
                <button className="btn-ghost" style={{ fontSize: 12 }} onClick={() => setKidAges(prev => [...prev, 0])}>+ Add kid</button>
              </div>
              {kidAges.length > 0 && (<>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '8px 0' }}>
                  {kidAges.map((k, idx) => (
                    <span key={idx} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 14, padding: '2px 6px 2px 8px', fontSize: 12 }}>
                      🧒
                      <NumberInput value={k} width={38} required={false} suffix="yo" title="Kid's current age"
                        onCommit={n => setKidAges(prev => prev.map((v, i2) => (i2 === idx ? n : v)))} />
                      <span onClick={() => setKidAges(prev => prev.filter((_, i2) => i2 !== idx))} title="Remove" style={{ cursor: 'pointer', color: 'var(--red)', marginLeft: 2 }}>×</span>
                    </span>
                  ))}
                </div>
                {numRow('Cost per kid / yr', 'costPerKid', 1000, 1, '$')}
                {numRow('Independent at age', 'kidIndependentAge', 1, 1)}
                <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>Already in your spending — it drops by the per-kid cost as each reaches independence (the empty-nest effect). College is modeled separately below.</p>
              </>)}
            </div>

            {/* College — compact; lives with kids since it depends on them */}
            <div style={{ borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 10 }}>
              <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}>
                <span style={{ fontSize: 13, color: 'var(--muted)' }}>🎓 College costs</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)' }}>
                  <input type="checkbox" checked={collegeOn} onChange={e => setCollegeOn(e.target.checked)} style={{ width: 'auto' }} /> Include
                </span>
              </label>
              {collegeOn && (<>
                {numRow("Cost / year (today's $)", 'collegeCostPerYear', 1000, 1, '$')}
                {numRow('Years', 'collegeYears', 1, 1)}
                {numRow('Starts at kid age', 'collegeStartAge', 1, 1)}
                {numRow('Education inflation %', 'eduInflation', 0.5, 100, '', '%')}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                  {COLLEGE_PRESETS.map(p => (
                    <button key={p.label} className="btn-ghost" style={{ fontSize: 11 }} title={`Set cost/year to $${p.value.toLocaleString()} (today's $)`}
                      onClick={() => setA(prev => ({ ...DEFAULT_ASSUMPTIONS, ...prev, collegeCostPerYear: p.value }))}>
                      {p.label} ${Math.round(p.value / 1000)}k
                    </button>
                  ))}
                </div>
                {/* Projected to each kid's actual college years (grown by education inflation) */}
                {kidAges.length > 0 && (
                  <div style={{ marginTop: 8, display: 'grid', gap: 3 }}>
                    {kidAges.map((k, idx) => {
                      if (k >= A.collegeStartAge + A.collegeYears) return <p key={idx} style={{ fontSize: 11, color: 'var(--muted)' }}>🧒 age {k}: past college age</p>;
                      const yearsUntil = Math.max(0, A.collegeStartAge - k);
                      const perYear0 = A.collegeCostPerYear * Math.pow(1 + A.eduInflation, yearsUntil);
                      let total = 0; for (let y = 0; y < A.collegeYears; y++) total += A.collegeCostPerYear * Math.pow(1 + A.eduInflation, yearsUntil + y);
                      return (
                        <p key={idx} style={{ fontSize: 11, color: 'var(--text)' }}>
                          🧒 age {k}: college in {yearsUntil}y → <strong>~{money(perYear0)}/yr</strong> · ~{money(total)} total
                        </p>
                      );
                    })}
                  </div>
                )}
                <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
                  {kidAges.length > 0
                    ? "Presets are today's national averages; each kid's cost is grown by education inflation to their college years. Funded from 529 first, then taxable."
                    : 'Add kids above to project and apply college costs.'}
                </p>
              </>)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function summarize(a: Assumptions, retireAge: number, future: number, current: number, success: number): string {
  if (!current) return 'Connect accounts to see a projection.';
  const growth = Math.round((future - current) / 1e6 * 10) / 10;
  const parts: string[] = [
    `Median path: $${Math.round(current).toLocaleString()} today → about $${(future / 1e6).toFixed(1)}M by age ${a.endAge} (+$${growth}M).`,
    `You retire at ${retireAge}, then draw down taxable → pre-tax → Roth (HSA last).`,
  ];
  parts.push(success >= 90
    ? `Across ${RUNS} simulations your plan succeeds ${success}% of the time — robust to market swings.`
    : `⚠️ Only ${success}% of simulations stay solvent — consider saving more, retiring later, or spending less.`);
  return parts.join(' ');
}
