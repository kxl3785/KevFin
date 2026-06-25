import { useMemo, useRef, useState, useEffect } from 'react';
import { ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Legend } from 'recharts';
import { useApi } from '../hooks/useApi.ts';
import { usePersistentState, writePersistent } from '../hooks/usePersistentState.ts';
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

// Life events live as draggable chips on the chart. Retirement is per-earner (below).
//   oneTime        — a one-off cost / big purchase at `age` (e.g. a home, a car)
//   recurring      — an annual expense from `age` to `untilAge`
//   recurringEvery — a repeat purchase every `everyYears` (e.g. a new car every 8y)
//   income         — an income change at `age`; `amount` is $/yr, or a % if `isPct`
//   kid            — a (future) child born when earner 0 is `age`; feeds the kid model
type EventType = 'oneTime' | 'recurring' | 'recurringEvery' | 'income' | 'kid';
interface LifeEvent {
  id: string; label: string; icon: string; type: EventType; age: number; amount: number;
  untilAge?: number;   // recurring / recurringEvery end age
  everyYears?: number; // recurringEvery period
  isPct?: boolean;     // income: amount is a % raise rather than $/yr
}
const EVENT_TYPE_META: Record<EventType, { icon: string; label: string }> = {
  oneTime: { icon: '💸', label: 'Big purchase / one-time cost' },
  recurring: { icon: '🔁', label: 'Recurring expense / yr' },
  recurringEvery: { icon: '🚗', label: 'Repeat purchase every N yrs' },
  income: { icon: '📈', label: 'Income change' },
  kid: { icon: '🧒', label: 'Have a kid' },
};
// Quick icon palette so a "big purchase" can be a home, car, trip, etc.
const ICON_CHOICES = ['💸', '🏠', '🚗', '✈️', '💍', '🛠️', '🏥', '🎓', '📈', '💼', '🧒', '🎉'];

interface Earner {
  label: string;
  enabled: boolean;          // earner 0 is always on; this gates earner 1
  currentAge: number;        // earner 1's age (earner 0 uses Assumptions.currentAge)
  income: number;            // gross, today's $
  raisePct: number;          // annual real raise (above inflation), e.g. 0.02 = +2%/yr
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
  // taxes (today's $)
  effTaxRate: number; retireTaxRate: number;
  // Annual growth applied to IRS contribution limits for years past the latest
  // year in IRS_LIMITS_BY_YEAR (the known years use exact published figures).
  limitGrowth: number;
  // college
  collegeCostPerYear: number; collegeYears: number; collegeStartAge: number; eduInflation: number;
  // grad school (optional, after college); gradCoverage = fraction of cost the family pays
  gradCostPerYear: number; gradYears: number; gradStartAge: number; gradCoverage: number;
  // legacy (kept so old persisted state still parses; earner 0 income now lives in `earners`)
  annualIncome?: number;
}

const DEFAULT_ASSUMPTIONS: Assumptions = {
  currentAge: 40, endAge: 90, investReturn: 0.07, volatility: 0.15, realEstateGrowth: 0.04, inflation: 0.03,
  annualSpending: 70000, costPerKid: 18000, kidIndependentAge: 22,
  effTaxRate: 0.24, retireTaxRate: 0.15,
  limitGrowth: 0.02,
  collegeCostPerYear: 30000, collegeYears: 4, collegeStartAge: 18, eduInflation: 0.05,
  gradCostPerYear: 40000, gradYears: 2, gradStartAge: 22, gradCoverage: 0.5,
};

const DEFAULT_EARNERS: Earner[] = [
  { label: 'You', enabled: true, currentAge: 40, income: 180000, raisePct: 0.02, retireAge: 65, pretax: 23500, employer: 12000, roth: 7000, hsa: 8550, ssEnabled: true, ssClaimAge: 67, ssAnnual: 36000 },
  { label: 'Partner', enabled: false, currentAge: 38, income: 120000, raisePct: 0.02, retireAge: 65, pretax: 23500, employer: 8000, roth: 7000, hsa: 0, ssEnabled: true, ssClaimAge: 67, ssAnnual: 30000 },
];

// A tax return tells us how many dependent children there are, but not their
// ages. New kid chips from an import seed at this placeholder (and are flagged so
// the user knows to set the real age).
const IMPORTED_KID_AGE = 8;

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

// Official IRS contribution limits by calendar year (today's $). Refreshed
// yearly by .github/workflows/update-irs-limits.yml after the IRS publishes its
// COLA adjustments — retirement limits drop in late Oct/Nov, HSA limits the
// prior May. (Edit by hand too if needed.)
//   k401Employee — 402(g) employee elective-deferral cap (401(k)/403(b))
//   k401Total    — 415(c) overall cap (employee + employer), excl. catch-up
//   ira          — Traditional/Roth IRA cap
//   hsaFamily    — HSA family-coverage cap (self-only is ~half)
// Sources: IRS Notice 2025-67 (retirement) & Rev. Proc. 2025-19 (HSA).
interface IrsLimits { k401Employee: number; k401Total: number; ira: number; hsaFamily: number }
const IRS_LIMITS_BY_YEAR: Record<number, IrsLimits> = {
  2024: { k401Employee: 23000, k401Total: 69000, ira: 7000, hsaFamily: 8300 },
  2025: { k401Employee: 23500, k401Total: 70000, ira: 7000, hsaFamily: 8550 },
  2026: { k401Employee: 24500, k401Total: 72000, ira: 7500, hsaFamily: 8750 },
};
// Limits for `year`: exact if known; for future years grow the latest known
// values by `growth` and round to the IRS's typical step so the buttons still
// show sensible round numbers until the table is updated.
function irsLimitsFor(year: number, growth: number): IrsLimits {
  const known = Object.keys(IRS_LIMITS_BY_YEAR).map(Number).sort((a, b) => a - b);
  if (IRS_LIMITS_BY_YEAR[year]) return IRS_LIMITS_BY_YEAR[year];
  if (year <= known[0]) return IRS_LIMITS_BY_YEAR[known[0]];
  const last = known[known.length - 1];
  if (year < last) return IRS_LIMITS_BY_YEAR[last]; // gap in table — use latest
  const base = IRS_LIMITS_BY_YEAR[last], n = year - last;
  const grow = (v: number, step: number) => Math.round(v * Math.pow(1 + growth, n) / step) * step;
  return { k401Employee: grow(base.k401Employee, 500), k401Total: grow(base.k401Total, 1000), ira: grow(base.ira, 500), hsaFamily: grow(base.hsaFamily, 50) };
}

// A child's education cost reported in the dollars of the years they attend
// (nominal — grown by education inflation from today's cost), so the figures
// match what the sim actually spends rather than today's sticker price.
//   ageNow   — the child's age today (negative if not yet born)
//   coverage — fraction the family pays (1 for college, gradCoverage for grad)
// Returns the first attended year (years from now), that year's cost, and the
// nominal total — or null if the child is already past this stage.
function eduCost(ageNow: number, startAge: number, years: number, costToday: number, eduInfl: number, coverage = 1):
  { startsIn: number; perYear0: number; total: number } | null {
  const lastI = startAge - ageNow + years - 1;        // last attended year, from now
  if (lastI < 0) return null;                          // entirely in the past
  const firstI = Math.max(0, startAge - ageNow);
  let total = 0;
  for (let i = firstI; i <= lastI; i++) total += costToday * coverage * Math.pow(1 + eduInfl, i);
  return { startsIn: startAge - ageNow, perYear0: costToday * coverage * Math.pow(1 + eduInfl, firstI), total };
}

// Ages at which an event lands on the chart. Repeat-purchase events (e.g. a new
// car every N years) recur from `age` to `untilAge`; everything else is a single
// point at `age`.
function eventOccurrences(e: LifeEvent, endAge: number): number[] {
  if (e.type !== 'recurringEvery' || !(e.everyYears && e.everyYears > 0)) return [e.age];
  const until = e.untilAge ?? endAge;
  const out: number[] = [];
  for (let a = e.age; a <= until; a += e.everyYears) out.push(a);
  return out;
}

const TABS = ['Net Worth', 'Cash Flow', 'Success %'] as const;
type Tab = typeof TABS[number];
const RUNS = MONTE_CARLO_RUNS;
const PLOT_LEFT = 60, PLOT_RIGHT = 16;

// Deterministic PRNG so the Monte Carlo is reproducible: the same inputs always
// yield the same bands/success %. Without this, every recompute (e.g. a tab
// switch re-rendering the page) would redraw fresh randoms and the headline
// numbers would visibly wiggle.
function mulberry32(seed: number) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randn(rand: () => number) { let u = 0, v = 0; while (!u) u = rand(); while (!v) v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function pctile(sorted: number[], p: number) { return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))]; }
// IRS-style RMD: roughly 1/(remaining life expectancy). Kicks in at 73.
function rmdFactor(age: number) { return age >= 73 ? 1 / Math.max(2, 27.4 - (age - 73)) : 0; }

// Number input that keeps a blank field blank while editing (instead of snapping
// to 0). Commits only when the text parses to a number; the model keeps its last
// value while blank. Shows a "required" hint when blank and required.
function NumberInput({ value, onCommit, mul = 1, step, width = 100, required = true, prefix, suffix, title, imported = false }: {
  value: number; onCommit: (n: number) => void; mul?: number; step?: number; width?: number;
  required?: boolean; prefix?: string; suffix?: string; title?: string;
  imported?: boolean; // value came from a document import — tint it so it stands out
}) {
  const fmt = (v: number) => String(Math.round(v * mul * 100) / 100);
  const [text, setText] = useState(() => fmt(value));
  const last = useRef(value);
  useEffect(() => {
    if (Math.abs(value - last.current) > 1e-9) { last.current = value; setText(fmt(value)); }
  }, [value, mul]); // eslint-disable-line react-hooks/exhaustive-deps
  // "Saved" feedback lives on the box itself: the field flashes green with a ✓
  // once you click off it (on blur) after an edit — not on every keystroke, which
  // was distracting. `dirty` tracks whether the value changed during this focus.
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<number | undefined>(undefined);
  const dirty = useRef(false);
  const flashSaved = () => {
    setSaved(true);
    window.clearTimeout(savedTimer.current);
    savedTimer.current = window.setTimeout(() => setSaved(false), 1200);
  };
  useEffect(() => () => window.clearTimeout(savedTimer.current), []);
  const empty = text.trim() === '';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      {required && empty && <span style={{ fontSize: 10, color: 'var(--red)' }}>required</span>}
      {imported && !saved && <span title="Imported from a document" style={{ fontSize: 10, color: 'var(--imported)' }}>●</span>}
      {prefix && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{prefix}</span>}
      <input type="number" step={step} title={imported ? (title ? title + ' · ' : '') + 'Imported from a document' : title} value={text}
        onChange={e => {
          const raw = e.target.value;
          setText(raw);
          if (raw.trim() === '') return; // leave blank — don't insert 0
          const n = parseFloat(raw);
          if (!isNaN(n)) { last.current = n / mul; onCommit(n / mul); dirty.current = true; }
        }}
        onBlur={() => {
          // Don't leave the box blank on the way out. An emptied optional field
          // means zero — autofill and commit it. A required field instead snaps
          // back to its last value (0 would be nonsensical for an age or rate).
          if (text.trim() === '') {
            if (required) { setText(fmt(last.current)); }
            else { setText(fmt(0)); last.current = 0; onCommit(0); dirty.current = true; }
          }
          if (dirty.current) { dirty.current = false; flashSaved(); }
        }}
        style={{
          fontSize: 13, padding: '3px 6px', width, textAlign: 'right',
          borderColor: saved ? 'var(--green)' : imported ? 'var(--imported)' : required && empty ? 'var(--red)' : undefined,
          background: saved ? 'rgba(74,222,128,0.12)' : imported ? 'var(--imported-dim)' : undefined,
          transition: 'border-color 0.3s ease, background-color 0.3s ease',
        }} />
      {suffix && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{suffix}</span>}
      {/* Reserved slot so the ✓ never shifts layout when it appears. */}
      <span title="Saved" style={{ width: 12, fontSize: 12, fontWeight: 700, color: 'var(--green)', opacity: saved ? 1 : 0, transition: 'opacity 0.3s ease', pointerEvents: 'none' }}>✓</span>
    </span>
  );
}

// Text counterpart to NumberInput: commits on every keystroke and flashes the
// same green "✓ saved" on blur, so renaming an earner gives the same persistence
// feedback the numeric fields do.
function TextInput({ value, onCommit, placeholder, style }: {
  value: string; onCommit: (s: string) => void; placeholder?: string; style?: React.CSSProperties;
}) {
  const [text, setText] = useState(value);
  const last = useRef(value);
  useEffect(() => { if (value !== last.current) { last.current = value; setText(value); } }, [value]);
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<number | undefined>(undefined);
  const dirty = useRef(false);
  useEffect(() => () => window.clearTimeout(savedTimer.current), []);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <input value={text} placeholder={placeholder}
        onChange={e => { setText(e.target.value); last.current = e.target.value; onCommit(e.target.value); dirty.current = true; }}
        onBlur={() => {
          if (!dirty.current) return;
          dirty.current = false; setSaved(true);
          window.clearTimeout(savedTimer.current);
          savedTimer.current = window.setTimeout(() => setSaved(false), 1200);
        }}
        style={{
          ...style,
          borderColor: saved ? 'var(--green)' : (style?.borderColor),
          background: saved ? 'rgba(74,222,128,0.12)' : (style?.background),
          transition: 'border-color 0.3s ease, background-color 0.3s ease',
        }} />
      <span title="Saved" style={{ width: 12, fontSize: 12, fontWeight: 700, color: 'var(--green)', opacity: saved ? 1 : 0, transition: 'opacity 0.3s ease', pointerEvents: 'none' }}>✓</span>
    </span>
  );
}

// --- Social Security estimate (US, simplified) -----------------------------
// Benefit factor vs Full Retirement Age (67): early-claim reduction to age 62,
// delayed-retirement credits (+8%/yr) to age 70.
function ssFactor(age: number): number {
  const FRA = 67;
  if (age <= 62) return 0.70;
  if (age >= 70) return 1.24;
  if (age < FRA) {
    const m = (FRA - age) * 12, m1 = Math.min(m, 36), m2 = Math.max(0, m - 36);
    return 1 - (m1 * 5 / 900 + m2 * 5 / 1200);
  }
  return 1 + (age - FRA) * 0.08;
}
// PIA from current gross income (proxy for the 35-yr indexed average), via the
// 2025 wage base and bend points; scaled to the claim age. Returns today's $/yr.
function ssAnnualBenefit(income: number, claimAge: number): number {
  const WAGE_BASE = 176100, B1 = 1226, B2 = 7391;
  const aime = Math.min(Math.max(0, income), WAGE_BASE) / 12;
  const pia = 0.9 * Math.min(aime, B1) + 0.32 * Math.max(0, Math.min(aime, B2) - B1) + 0.15 * Math.max(0, aime - B2);
  return Math.round(pia * ssFactor(claimAge) * 12 / 100) * 100;
}
// Claim age that maximizes lifetime benefit given the plan-to (longevity) age,
// plus the contiguous range within 2% of that maximum.
function ssOptimal(income: number, endAge: number): { best: number; lo: number; hi: number; annual: number } {
  const life = Math.max(endAge, 71);
  const vals: Record<number, number> = {};
  let best = 67, bestVal = -1;
  for (let c = 62; c <= 70; c++) { const v = ssFactor(c) * Math.max(0, life - c); vals[c] = v; if (v > bestVal) { bestVal = v; best = c; } }
  let lo = best, hi = best;
  for (let c = best - 1; c >= 62; c--) { if (vals[c] >= bestVal * 0.98) lo = c; else break; }
  for (let c = best + 1; c <= 70; c++) { if (vals[c] >= bestVal * 0.98) hi = c; else break; }
  return { best, lo, hi, annual: ssAnnualBenefit(income, best) };
}

// A headline stat whose supporting detail is tucked into a hover popover, so the
// stat row stays uncluttered. Hovering the label/value reveals the breakdown.
function Stat({ label, value, color, detail }: {
  label: string; value: string; color?: string; detail?: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div style={{ position: 'relative' }}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <p style={{ color: 'var(--muted)', fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 4, cursor: detail ? 'help' : 'default' }}>
        {label}{detail && <span style={{ fontSize: 10, opacity: 0.55 }}>ⓘ</span>}
      </p>
      <p style={{ fontSize: 26, fontWeight: 700, color }}>{value}</p>
      {detail && hover && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, marginTop: 6, zIndex: 40,
          background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px',
          boxShadow: '0 8px 24px rgba(0,0,0,0.5)', minWidth: 210, maxWidth: 300,
          fontSize: 12, lineHeight: 1.5, color: 'var(--muted)',
        }}>
          {detail}
        </div>
      )}
    </div>
  );
}

// A small "ⓘ" affordance whose text appears in a hover popover. The native
// `title` tooltip was unreliable (often never showed), so this renders its own.
function InfoTip({ text, width = 250 }: { text: string; width?: number }) {
  const [hover, setHover] = useState(false);
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <span style={{ fontSize: 11, color: 'var(--muted)', cursor: 'help', border: '1px solid var(--border)', borderRadius: '50%', width: 15, height: 15, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1, textTransform: 'none' }}>i</span>
      {hover && (
        <span style={{
          position: 'absolute', top: '100%', left: '50%', transform: 'translateX(-50%)', marginTop: 6, zIndex: 50,
          background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px',
          boxShadow: '0 8px 24px rgba(0,0,0,0.5)', width, fontSize: 11, lineHeight: 1.5, color: 'var(--muted)',
          textTransform: 'none', letterSpacing: 0, fontWeight: 400, whiteSpace: 'normal',
        }}>
          {text}
        </span>
      )}
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
  // Fields populated by a document import (keys like 'earner0.income',
  // 'assumptions.effTaxRate'), so they can be rendered in the imported colour.
  const [importedSet, setImported] = usePersistentState<Record<string, boolean>>('mon.fcImported', {});
  // A queued import (e.g. from a tax return) handed over by the document importer.
  // Applied here — where the earner/assumption setters live — then cleared.
  const [pendingImport, setPendingImport] = usePersistentState<{
    fields: { annualIncome?: number; spouseIncome?: number; effTaxRate?: number; filingStatus?: string; dependents?: number };
    at: number;
  } | null>('mon.fcPendingImport', null);
  const clearImported = (k: string) => setImported(prev => { if (!prev[k]) return prev; const c = { ...prev }; delete c[k]; return c; });

  // Apply a queued import (e.g. a tax return) into the earner/household inputs and
  // flag the touched fields so they render highlighted. Runs whenever the importer
  // queues one (persisted state syncs across components live), even from another page.
  useEffect(() => {
    if (!pendingImport) return;
    const f = pendingImport.fields ?? {};
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const marks: Record<string, boolean> = {};

    const income = num(f.annualIncome);
    if (income != null) {
      setEarners(prev => prev.map((e, i) => (i === 0 ? { ...e, income } : e)));
      marks['earner0.income'] = true;
    }
    // A joint return (or any spouse wages) implies a two-earner household: turn on
    // the partner earner and fill their income.
    const spouse = num(f.spouseIncome);
    const married = f.filingStatus === 'married';
    if (spouse != null || married) {
      setEarners(prev => prev.map((e, i) => (i === 1
        ? { ...e, enabled: true, ...(spouse != null ? { income: spouse } : {}) }
        : e)));
      if (spouse != null) marks['earner1.income'] = true;
    }
    const eff = num(f.effTaxRate);
    if (eff != null) {
      // Accept a percent (e.g. 24) or an already-fractional rate (0.24).
      const frac = eff > 1 ? eff / 100 : eff;
      setA(prev => ({ ...DEFAULT_ASSUMPTIONS, ...prev, effTaxRate: frac }));
      marks['assumptions.effTaxRate'] = true;
    }
    // Dependents (qualifying children) → kid chips, only when none are set yet so
    // we never clobber ages the user already entered. Ages aren't on a return, so
    // they seed at a placeholder and are highlighted for the user to correct.
    const deps = num(f.dependents);
    if (deps != null && deps > 0 && kidAges.length === 0) {
      setKidAges(Array.from({ length: Math.min(Math.round(deps), 8) }, () => IMPORTED_KID_AGE));
      marks['kids'] = true;
    }

    if (Object.keys(marks).length) setImported(prev => ({ ...prev, ...marks }));
    setPendingImport(null);
  }, [pendingImport, kidAges, setEarners, setA, setKidAges, setImported, setPendingImport]);
  const [accountContribs, setAccountContribs] = usePersistentState<Record<string, number>>('mon.fcAccountContribs', {}); // annual $/yr per account id
  const [hsaLast, setHsaLast] = usePersistentState('mon.fcHsaLast', true);
  const [collegeOn, setCollegeOn] = usePersistentState('mon.fcCollegeOn', true);
  const [gradOn, setGradOn] = usePersistentState('mon.fcGradOn', false);
  const [seeded, setSeeded] = usePersistentState('mon.fcSeeded', false);
  const [projAnnual, setProjAnnual] = usePersistentState('mon.fcProjAnnual', true); // "Projected from your data": show amounts per year vs per month
  const [showKey, setShowKey] = usePersistentState('mon.fcShowKey', true); // collapse the unified "Key Assumptions" box
  const [showMarket, setShowMarket] = usePersistentState('mon.fcShowMarket', true); // hide market assumptions inside Accounts
  const [showContribs, setShowContribs] = usePersistentState('mon.fcShowContribs', true); // collapse the "Accounts & contributions" box
  const [showSpending, setShowSpending] = usePersistentState('mon.fcShowSpending', true); // collapse the "Annual spending & income" box
  const [showTable, setShowTable] = usePersistentState('mon.fcShowTable', false); // collapse the year-by-year forecast table
  const [tableInterval, setTableInterval] = usePersistentState('mon.fcTableInterval', 5); // table row spacing in years
  const [showAccounts, setShowAccounts] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null); // open life-event editor
  const [addMode, setAddMode] = useState(false); // arm chart click-to-add so stray clicks don't spawn events

  // Restore the planning inputs to their defaults. Account bucket/contribution
  // settings are intentionally preserved (they reflect the user's real accounts);
  // clearing `seeded` lets income/spending re-seed from transaction data.
  function resetAll() {
    if (!confirm('Reset forecast assumptions, earners, and life events to defaults? Your account buckets and per-account contributions are kept.')) return;
    setA(DEFAULT_ASSUMPTIONS);
    setEarners(DEFAULT_EARNERS);
    setEvents(DEFAULT_EVENTS);
    setKidAges([]);
    setSeeded(false);
    setAddMode(false);
    setImported({});
    setPendingImport(null);
  }
  const [prevApplied, setPrevApplied] = usePersistentState<{ income: number; spending: number } | null>('mon.fcPrevApplied', null); // undo for "use my actual"
  const [spendingAdjust, setSpendingAdjust] = usePersistentState('mon.fcSpendingAdjust', 1); // what-if spending multiplier

  // Backfill any assumption fields added after a user's state was persisted.
  // Memoized so it keeps a stable reference across renders — otherwise the
  // expensive `sim` useMemo below (which lists A as a dependency) would re-run
  // on every render, e.g. when switching tabs.
  const A = useMemo(() => ({ ...DEFAULT_ASSUMPTIONS, ...a }), [a]);
  const infl = A.inflation, costPerKid = A.costPerKid, kidIndependentAge = A.kidIndependentAge;
  // Current-year IRS contribution limits, used by the per-account "max" buttons.
  const limitYear = new Date().getFullYear();
  const irs = useMemo(() => irsLimitsFor(limitYear, A.limitGrowth), [limitYear, A.limitGrowth]);
  // Timeline is driven by earner 0's current age (both earners now show the row).
  const currentAge0 = earners[0]?.currentAge ?? A.currentAge;
  const yearNow = new Date().getFullYear(); // for the chart's age→year axis labels

  // Drop any events persisted under the old schema (e.g. the retired 'retire'
  // type) so they don't render as dead chips. Runs once on mount.
  useEffect(() => {
    setEvents(prev => {
      const validTypes: EventType[] = ['oneTime', 'recurring', 'recurringEvery', 'income', 'kid'];
      const valid = prev.filter(e => validTypes.includes(e.type));
      return valid.length === prev.length ? prev : valid;
    });
    // Earner 0's age used to live in Assumptions.currentAge. Carry it over once
    // for users migrating from that schema — but ONLY while earner 0's age is
    // still the untouched default. Never overwrite an age the user has set, or
    // it silently reverts on every remount (the legacy field is frozen now).
    if (a.currentAge != null) setEarners(prev => prev.map((e, i) =>
      (i === 0 && e.currentAge === DEFAULT_EARNERS[0].currentAge && a.currentAge !== e.currentAge)
        ? { ...e, currentAge: a.currentAge! } : e));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Seed income/spending from real transaction data, once. A value imported from
  // a document (e.g. income from a tax return) is an explicit choice and wins, so
  // don't overwrite a field the user has imported.
  useEffect(() => {
    if (projection && projection.monthsAnalyzed > 0 && !seeded) {
      setSeeded(true);
      if (projection.avgMonthlySpending > 0) setA(prev => ({ ...DEFAULT_ASSUMPTIONS, ...prev, annualSpending: projection.avgMonthlySpending * 12 }));
      if (projection.avgMonthlyIncome > 0 && !importedSet['earner0.income']) setEarners(prev => prev.map((e, i) => (i === 0 ? { ...e, income: projection.avgMonthlyIncome * 12 } : e)));
    }
  }, [projection, seeded, importedSet, setA, setEarners, setSeeded]);

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

  // Annual contributions (today's $) summed per bucket from each account's amount.
  const contribByBucket = useMemo(() => {
    const r: Record<TaxBucket, number> = { taxable: 0, pretax: 0, roth: 0, hsa: 0, college: 0 };
    for (const acc of taxData?.accounts ?? []) r[bucketOf(acc)] += accountContribs[acc.id] || 0;
    return r;
  }, [taxData, accountContribs, bucketOverrides]); // eslint-disable-line react-hooks/exhaustive-deps

  const sim = useMemo(() => {
    const years = Math.max(1, A.endAge - currentAge0 + 1);
    // Existing kids' costs are already baked into observed spending, so we only
    // model the *drop* as each ages out (empty-nest). Future "have a kid" events
    // instead *add* the per-kid cost while the child is dependent.
    const kidDrop = (i: number) => kidAges.reduce((s, k) => s + (k < kidIndependentAge && k + i >= kidIndependentAge ? costPerKid : 0), 0);
    const recurringAt = (age0: number) => events.filter(e => e.type === 'recurring' && age0 >= e.age && age0 <= (e.untilAge ?? A.endAge)).reduce((t, e) => t + e.amount, 0);
    // Repeat purchases: hit every `everyYears` from `age` to `untilAge` (e.g. a car).
    const repeatAt = (age0: number) => events.filter(e => e.type === 'recurringEvery' && (e.everyYears ?? 0) > 0
      && age0 >= e.age && age0 <= (e.untilAge ?? A.endAge) && (age0 - e.age) % (e.everyYears as number) === 0)
      .reduce((t, e) => t + e.amount, 0);
    // One-off costs / big purchases land in the single year they occur.
    const oneTimeAt = (age0: number) => events.filter(e => e.type === 'oneTime' && e.age === age0).reduce((t, e) => t + e.amount, 0);
    // A future kid's current age in projection year i (negative until born).
    const futureKidAgeAt = (e: LifeEvent, i: number) => (currentAge0 + i) - e.age;

    // --- Deterministic per-year flows (today's $ → nominal via inflation) ------
    // Income, contributions, taxes, spending and education are all deterministic;
    // only investment growth (and thus solvency) is random. Precompute once.
    const yr = Array.from({ length: years }, (_, i) => {
      const f = Math.pow(1 + infl, i);                          // general inflation
      const age0 = currentAge0 + i;
      // Income changes: % raises compound on base income; $ raises add on top.
      const incomeEvents = events.filter(e => e.type === 'income' && e.age <= age0);
      const pctMult = incomeEvents.filter(e => e.isPct).reduce((m, e) => m * (1 + e.amount / 100), 1);
      const dollarRaises = incomeEvents.filter(e => !e.isPct).reduce((t, e) => t + e.amount, 0);

      let grossN = 0, ssN = 0, anyWorking = false;
      earners.forEach((e, idx) => {
        const on = idx === 0 ? true : e.enabled;
        if (!on) return;
        const eAge = e.currentAge + i;
        // Income grows at its OWN raise rate, independent of inflation — for
        // fields without cost-of-living adjustments, wages can lag prices. (Spending
        // still inflates, so real take-home erodes unless the raise keeps up.)
        const raise = Math.pow(1 + (e.raisePct ?? 0.02), i);
        if (eAge < e.retireAge) { grossN += (idx === 0 ? e.income * raise * pctMult + dollarRaises : e.income * raise); anyWorking = true; }
        // Social Security keeps its inflation COLA.
        if (e.ssEnabled && eAge >= e.ssClaimAge) ssN += e.ssAnnual * f;
      });

      // Per-account contributions (today's $ → nominal), only while someone earns.
      const cf = anyWorking ? f : 0;
      let preN = contribByBucket.pretax * cf, rothN = contribByBucket.roth * cf, hsaN = contribByBucket.hsa * cf,
        c529N = contribByBucket.college * cf, taxN = contribByBucket.taxable * cf;
      // Can't contribute more than you earn.
      const totalContrib = preN + rothN + hsaN + c529N + taxN;
      if (grossN <= 0) { preN = rothN = hsaN = c529N = taxN = 0; }
      else if (totalContrib > grossN) { const sc = grossN / totalContrib; preN *= sc; rothN *= sc; hsaN *= sc; c529N *= sc; taxN *= sc; }

      // Added cost of future kids while they're dependent (not in baseline spending).
      const futureKidCost = events.filter(e => e.type === 'kid').reduce((s, e) => {
        const a = futureKidAgeAt(e, i); return s + (a >= 0 && a < kidIndependentAge ? costPerKid : 0);
      }, 0);
      const spendN = (Math.max(0, A.annualSpending * spendingAdjust - kidDrop(i)) + futureKidCost + recurringAt(age0)) * f;
      const oneTimeN = (oneTimeAt(age0) + repeatAt(age0)) * f;

      // Education for every child — current kids plus future-kid events.
      const kidAgesNow = [...kidAges.map(k => k + i), ...events.filter(e => e.type === 'kid').map(e => futureKidAgeAt(e, i))];
      let eduReal = 0;
      for (const a of kidAgesNow) {
        if (collegeOn && a >= A.collegeStartAge && a < A.collegeStartAge + A.collegeYears) eduReal += A.collegeCostPerYear;
        if (gradOn && a >= A.gradStartAge && a < A.gradStartAge + A.gradYears) eduReal += A.gradCostPerYear * A.gradCoverage;
      }
      const collegeNom = eduReal * Math.pow(1 + A.eduInflation, i);

      // Pre-tax & HSA contributions are deductible; Roth/taxable/529 come from take-home.
      const taxableIncome = Math.max(0, grossN - preN - hsaN + 0.85 * ssN);
      const tax = A.effTaxRate * taxableIncome;
      const net = grossN + ssN - tax - (preN + hsaN + rothN + c529N + taxN) - spendN - oneTimeN;
      return { f, age0, net, pretaxAdd: preN, rothAdd: rothN, hsaAdd: hsaN, c529Add: c529N, taxableAdd: taxN, collegeNom, oneTimeN, grossN, ssN, spendN };
    });

    // --- Monte Carlo over investment returns ----------------------------------
    const nw: number[][] = Array.from({ length: years }, () => []);
    const invv: number[][] = Array.from({ length: years }, () => []);
    let successCount = 0;

    // Fixed seed → reproducible draws, so the result depends only on the inputs.
    const rand = mulberry32(0x9e3779b9);
    for (let s = 0; s < RUNS; s++) {
      let taxable = pools0.taxable, pretax = pools0.pretax, roth = pools0.roth, hsa = pools0.hsa, c529 = pools0.college;
      let re = baseRE, solvent = true;
      for (let i = 0; i < years; i++) {
        const d = yr[i];
        const ret = A.investReturn + A.volatility * randn(rand);
        const g = 1 + ret;
        taxable *= g; pretax *= g; roth *= g; hsa *= g; c529 *= g; re *= (1 + A.realEstateGrowth);

        // Contributions in (each account's amount lands in its bucket).
        pretax += d.pretaxAdd; roth += d.rothAdd; hsa += d.hsaAdd; c529 += d.c529Add; taxable += d.taxableAdd;

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
        // Real estate grows deterministically, so it's the same across all runs.
        re: Math.round(baseRE * Math.pow(1 + A.realEstateGrowth, i + 1)),
        income: Math.round(d.grossN + d.ssN), spending: Math.round(d.spendN + d.collegeNom + d.oneTimeN),
      };
    });
    return { bands, successPct: Math.round(successCount / RUNS * 100) };
  }, [A, currentAge0, infl, costPerKid, kidIndependentAge, kidAges, events, earners, pools0, contribByBucket, baseRE, hsaLast, collegeOn, gradOn, spendingAdjust]);

  const finalBand = sim.bands.length ? sim.bands[sim.bands.length - 1] : null;
  const futureNW = finalBand ? finalBand.p50 : currentNW;
  // 10th–90th percentile of the final-year outcomes = an 80% confidence interval.
  const futureLo = finalBand ? finalBand.p10 : currentNW;
  const futureHi = finalBand ? finalBand.p10 + finalBand.band : currentNW;
  const deltaPct = currentNW ? ((futureNW - currentNW) / currentNW) * 100 : 0;
  const retireAge0 = earners[0]?.retireAge ?? 65;

  // Persist a compact summary of the (client-side) Monte Carlo so the AI assistant
  // can answer planning questions ("am I on track to retire?") with the actual
  // projected numbers — it can't run the simulation itself. Keyed for the assistant
  // to ship with each chat (see AiAssistant). Reflects the last Forecast render.
  useEffect(() => {
    writePersistent('mon.fcSummary', {
      currentNetWorth: Math.round(currentNW),
      currentAge: currentAge0,
      planToAge: A.endAge,
      medianNetWorthAtPlanEnd: Math.round(futureNW),
      range80pct: [Math.round(futureLo), Math.round(futureHi)],
      successProbabilityPct: sim.successPct,
      changeVsTodayPct: Math.round(deltaPct),
      retirement: earners
        .map((e, i) => (i === 0 || e.enabled ? { earner: e.label, retireAge: e.retireAge } : null))
        .filter(Boolean),
      computedAt: new Date().toISOString(),
    });
  }, [currentNW, currentAge0, A.endAge, futureNW, futureLo, futureHi, sim.successPct, deltaPct, earners]);

  function updateEvent(id: string, patch: Partial<LifeEvent>) { setEvents(prev => prev.map(e => (e.id === id ? { ...e, ...patch } : e))); }
  function removeEvent(id: string) { setEvents(prev => prev.filter(e => e.id !== id)); }
  function updateEarner(idx: number, patch: Partial<Earner>) { setEarners(prev => prev.map((e, i) => (i === idx ? { ...e, ...patch } : e))); }
  const setNum = (key: keyof Assumptions, mul = 1) => (v: string) => setA(prev => ({ ...DEFAULT_ASSUMPTIONS, ...prev, [key]: (parseFloat(v) || 0) / mul }));

  // Deep-link a spending category to the Budget page's filtered transactions list.
  function viewCategoryTxns(category: string) {
    try {
      // `from` lets Budget show a "← Back to Forecast" control; the return flag
      // lets us scroll back to this spending box when the user comes back.
      localStorage.setItem('mon.budgetDeepLink', JSON.stringify({ tab: 'transactions', filter: category, from: 'forecast' }));
      localStorage.setItem('mon.forecastReturn', '1');
    } catch { /* ignore */ }
    onNavigate('budget');
  }

  // When returning from a category deep-link, scroll back to the spending box the
  // user was looking at (once the projection data has rendered it).
  const spendingRef = useRef<HTMLDivElement>(null);
  const returnDone = useRef(false);
  useEffect(() => {
    if (returnDone.current) return;
    let want = false;
    try { want = localStorage.getItem('mon.forecastReturn') === '1'; } catch { /* ignore */ }
    if (!want) { returnDone.current = true; return; }
    if (projection && spendingRef.current) {
      returnDone.current = true;
      try { localStorage.removeItem('mon.forecastReturn'); } catch { /* ignore */ }
      spendingRef.current.scrollIntoView({ block: 'start' });
    }
  }, [projection]);

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
  // Derived 🎓 markers: the age (earner 0's) at which each child — current kids
  // plus any "have a kid" events — starts college. Auto-updates as kids change.
  const collegeMarks = collegeOn
    ? [...kidAges.map(k => currentAge0 + (A.collegeStartAge - k)), ...events.filter(e => e.type === 'kid').map(e => e.age + A.collegeStartAge)]
        .filter(age => age > currentAge0 && age <= A.endAge)
        .sort((a, b) => a - b)
    : [];

  // Every child we model — current kids plus planned future-kid events — with the
  // child's age today (negative until born) and a label. Drives the education
  // cost projections, which are reported in the dollars of the years attended.
  const eduChildren: { key: string; label: string; ageNow: number }[] = [
    ...kidAges.map((k, i) => ({ key: 'k' + i, label: `age ${k}`, ageNow: k })),
    ...events.filter(e => e.type === 'kid').map(e => ({
      key: e.id,
      label: e.age > currentAge0 ? `born in ${e.age - currentAge0}y` : `age ${currentAge0 - e.age}`,
      ageNow: currentAge0 - e.age,
    })),
  ];
  // Planned future kids (the "+ Plan future kid" life events), shown as chips
  // alongside the current kids in Household.
  const futureKids = events.filter(e => e.type === 'kid');

  const numRow = (label: string, key: keyof Assumptions, step: number, mul: number, prefix?: string, suffix?: string) => {
    const impKey = `assumptions.${key}`;
    return (
    <div key={key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0' }}>
      <span style={{ fontSize: 13, color: 'var(--muted)' }}>{label}</span>
      <NumberInput value={A[key] as number} mul={mul} step={step} width={104} prefix={prefix} suffix={suffix} imported={!!importedSet[impKey]}
        onCommit={n => { setA(prev => ({ ...DEFAULT_ASSUMPTIONS, ...prev, [key]: n })); clearImported(impKey); }} />
    </div>
  );};

  const card: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 20, marginBottom: 20 };
  // Sub-section heading used inside the unified boxes (Key Assumptions, etc.).
  const subHead: React.CSSProperties = { fontSize: 12, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5 };

  return (
    <div className="page" style={{ maxWidth: 960, margin: '0 auto', padding: '32px 24px' }}>
      <TopNav view="forecast" onNavigate={onNavigate} privacy={privacy} onTogglePrivacy={onTogglePrivacy} />
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h1 style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.5px' }}>Forecast</h1>
          <InfoTip width={320} text={
            'How this forecast works. Your starting point is your latest tracked net worth from Net Worth — investable accounts plus real estate — with accounts sorted into tax buckets (taxable, pre-tax, Roth, HSA, 529). Income and spending are seeded from your budget history, and document imports (e.g. a tax return) can fill in income, filing status, dependents, and your effective tax rate. You then refine the assumptions, account contributions, and life events below. From there it runs a Monte Carlo simulation — thousands of randomized market paths — growing each bucket while applying your raises, inflation, taxes, contributions, and life events, then charts the median outcome and the range around it.'
          } />
        </div>
        <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 4 }}>Monte Carlo projection ({RUNS} runs) across tax-treatment buckets. Use “＋ Add life event” to place a marker; click a marker to edit or remove it, or drag it to move.</p>
      </div>

      <div style={{ display: 'flex', gap: 40, marginBottom: 16, flexWrap: 'wrap' }}>
        <Stat label="Current net worth" value={money(currentNW)} detail={
          <>
            <p style={{ margin: 0 }}>Your latest tracked total across all accounts and real estate.</p>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
              <span>Investable accounts</span><span style={{ fontWeight: 600, color: 'var(--text)' }}>{money(baseAccounts)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
              <span>Real estate</span><span style={{ fontWeight: 600, color: 'var(--text)' }}>{money(baseRE)}</span>
            </div>
          </>
        } />
        <Stat label={`Median at age ${A.endAge}`} value={money(futureNW)} detail={
          <>
            <p style={{ margin: 0 }}>The midpoint (50th percentile) of {RUNS} simulated futures, in nominal dollars.</p>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
              <span>vs. today</span>
              <span style={{ fontWeight: 600, color: deltaPct >= 0 ? 'var(--green)' : 'var(--red)' }}>{money(futureNW - currentNW)} ({deltaPct >= 0 ? '+' : ''}{Math.round(deltaPct)}%)</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
              <span title="10th–90th percentile of simulated outcomes">80% CI</span>
              <span style={{ fontWeight: 600, color: 'var(--text)' }}>{money(futureLo)} – {money(futureHi)}</span>
            </div>
          </>
        } />
        <Stat label="Success probability"
          value={`${sim.successPct}%`}
          color={sim.successPct >= 90 ? 'var(--green)' : sim.successPct >= 70 ? 'var(--amber)' : 'var(--red)'}
          detail={
            <p style={{ margin: 0 }}>Share of {RUNS} simulated futures where your money never runs out before age {A.endAge}. Higher is safer — aim for 90%+.</p>
          } />
      </div>

      {Object.keys(importedSet).length > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16,
          padding: '8px 12px', borderRadius: 10,
          background: 'var(--imported-dim)', border: '1px solid var(--imported)',
          fontSize: 12.5, color: 'var(--text)',
        }}>
          <span style={{ color: 'var(--imported)', fontSize: 13 }}>●</span>
          <span>Highlighted fields were imported from a document. Edit any field to clear its highlight.</span>
          <button className="btn-ghost" style={{ fontSize: 11, padding: '3px 8px', marginLeft: 'auto' }}
            onClick={() => setImported({})} title="Clear all import highlights">Clear highlights</button>
        </div>
      )}

      {/* Chart with draggable markers */}
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 6 }}>
            {TABS.map(t => <button key={t} onClick={() => setTab(t)} className={tab === t ? 'btn-primary' : 'btn-ghost'} style={{ fontSize: 13 }}>{t}</button>)}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className={addMode ? 'btn-primary' : 'btn-ghost'} style={{ fontSize: 12 }}
              onClick={() => setAddMode(m => !m)}
              title="Then click the chart at the age where the event happens">
              {addMode ? '✕ Cancel placing' : '＋ Add life event'}
            </button>
            <button className="btn-ghost" style={{ fontSize: 12 }} onClick={resetAll}
              title="Restore default assumptions, earners, and life events (account contributions are kept)">↺ Reset to defaults</button>
          </div>
        </div>
        <div ref={wrapRef} style={{ position: 'relative' }}>
          <div onClick={e => { if (addMode) { addEventAt(e.clientX); setAddMode(false); } }}
            title={addMode ? 'Click to place the event at this age' : undefined}
            style={{ width: '100%', height: 360, filter: privacy ? 'blur(7px)' : 'none', cursor: addMode ? 'crosshair' : 'default' }}>
            <ResponsiveContainer>
              <ComposedChart data={sim.bands} margin={{ top: 34, right: PLOT_RIGHT, left: 8, bottom: 0 }}>
                <defs>
                  <linearGradient id="gBand" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#6c8fff" stopOpacity={0.18} />
                    <stop offset="100%" stopColor="#6c8fff" stopOpacity={0.04} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#2a2d3a" />
                <XAxis dataKey="age" tickLine={false} axisLine={false} height={38}
                  tick={({ x, y, payload }: { x: number; y: number; payload: { value: number } }) => (
                    <g transform={`translate(${x},${y})`}>
                      <text x={0} y={0} dy={12} textAnchor="middle" fill="#7b7f95" fontSize={11}>{payload.value}</text>
                      <text x={0} y={0} dy={25} textAnchor="middle" fill="#5a5e70" fontSize={10}>{yearNow + (payload.value - currentAge0)}</text>
                    </g>
                  )} />
                <YAxis tick={{ fill: '#7b7f95', fontSize: 11 }} tickLine={false} axisLine={false} width={52} tickFormatter={moneyM} />
                <Tooltip contentStyle={{ background: '#1a1d27', border: '1px solid #2a2d3a', borderRadius: 8 }}
                  labelFormatter={age => `Age ${age} · ${yearNow + ((age as number) - currentAge0)}`} formatter={(v: number, n) => [money(v), n]} />
                <Legend wrapperStyle={{ fontSize: 12, color: '#7b7f95' }} />
                {events.flatMap(e => eventOccurrences(e, A.endAge).map((a, j) =>
                  <ReferenceLine key={e.id + '@' + j} x={a} stroke="#4a4d5a" strokeDasharray="2 4" />))}
                {retireMarks.map((age, i) => <ReferenceLine key={'r' + i} x={age} stroke="#f59e0b" strokeDasharray="4 3" />)}
                {collegeMarks.map((age, i) => <ReferenceLine key={'c' + i} x={age} stroke="#a78bfa" strokeDasharray="2 4"
                  label={{ value: '🎓', position: 'insideTop', fontSize: 12, fill: '#a78bfa' }} />)}
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
          {/* Repeat-purchase events (e.g. a new car every N years): a linked icon at
              each recurrence after the first. Clicking edits the same event; the
              series moves with the primary chip when you drag it. */}
          {events.flatMap((e, i) => {
            if (e.type !== 'recurringEvery' || !(e.everyYears && e.everyYears > 0)) return [];
            const top = 2 + (i % 3) * 24;
            return eventOccurrences(e, A.endAge).slice(1).map(a => (
              <div key={e.id + '@' + a}
                onClick={ev => { ev.stopPropagation(); setEditingId(e.id); }}
                title={`${e.label} · age ${a} — repeats every ${e.everyYears}y (click to edit)`}
                style={{
                  position: 'absolute', left: ageToX(a), top, transform: 'translateX(-50%)',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 22, height: 22, borderRadius: '50%',
                  background: editingId === e.id ? 'var(--accent)' : 'var(--bg)',
                  border: '1px dashed var(--border)', fontSize: 12, lineHeight: 1,
                  cursor: 'pointer', userSelect: 'none', zIndex: 9, boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
                }}>
                {e.icon}
              </div>
            ));
          })}
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
              {/* Icon picker — a big purchase can be a home, car, trip… (kids stay 🧒) */}
              {editingEvent.type !== 'kid' && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
                  {ICON_CHOICES.map(ic => (
                    <button key={ic} onClick={() => updateEvent(editingEvent.id, { icon: ic })} title="Use this icon"
                      style={{ fontSize: 14, lineHeight: 1, padding: '3px 5px', borderRadius: 6, cursor: 'pointer',
                        background: editingEvent.icon === ic ? 'var(--accent)' : 'var(--bg)',
                        border: '1px solid ' + (editingEvent.icon === ic ? 'var(--accent)' : 'var(--border)') }}>{ic}</button>
                  ))}
                </div>
              )}
              {editingEvent.type === 'kid' ? (
                <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10, lineHeight: 1.4 }}>
                  A child born when you're {editingEvent.age} ({editingEvent.age <= currentAge0 ? `age ${currentAge0 - editingEvent.age} today` : `in ${editingEvent.age - currentAge0}y`}). Adds your per-kid cost while dependent, plus college{gradOn ? ' & grad school' : ''}.
                </p>
              ) : (<>
                {/* Income: choose $ amount or % change */}
                {editingEvent.type === 'income' && (
                  <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                    {([['$ amount', false], ['% change', true]] as [string, boolean][]).map(([lbl, v]) => (
                      <button key={lbl} onClick={() => updateEvent(editingEvent.id, { isPct: v })}
                        className={(editingEvent.isPct ?? false) === v ? 'btn-primary' : 'btn-ghost'} style={{ fontSize: 11 }}>{lbl}</button>
                    ))}
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <span style={{ fontSize: 13, color: 'var(--muted)' }}>{editingEvent.type === 'income' ? (editingEvent.isPct ? 'Raise %' : 'Raise / yr') : editingEvent.type === 'recurringEvery' ? 'Each time' : 'Amount'}</span>
                  <NumberInput value={editingEvent.amount} required={false}
                    prefix={editingEvent.type === 'income' && editingEvent.isPct ? undefined : '$'}
                    suffix={editingEvent.type === 'income' && editingEvent.isPct ? '%' : undefined}
                    onCommit={n => updateEvent(editingEvent.id, { amount: n })} />
                </div>
                {editingEvent.type === 'recurringEvery' && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <span style={{ fontSize: 13, color: 'var(--muted)' }}>Every</span>
                    <NumberInput value={editingEvent.everyYears ?? 5} suffix="yrs" required={false}
                      onCommit={n => updateEvent(editingEvent.id, { everyYears: Math.max(1, Math.round(n)) })} />
                  </div>
                )}
                {(editingEvent.type === 'recurring' || editingEvent.type === 'recurringEvery') && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                    <span style={{ fontSize: 13, color: 'var(--muted)' }}>Until age</span>
                    <NumberInput value={editingEvent.untilAge ?? A.endAge} required={false} onCommit={n => updateEvent(editingEvent.id, { untilAge: n })} />
                  </div>
                )}
              </>)}
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

      {/* Key Assumptions: earners & retirement, household, and taxes — unified + collapsible */}
      <div style={card}>
        <div onClick={() => setShowKey(s => !s)} title={showKey ? 'Collapse' : 'Expand'}
          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}>
          <h2 style={{ fontSize: 15, fontWeight: 600 }}>Key Assumptions</h2>
          <span style={{ fontSize: 13, color: 'var(--muted)', userSelect: 'none' }}>{showKey ? '▾ Hide' : '▸ Show'}</span>
        </div>
        {showKey && (<>
        {/* — Earners & retirement — */}
        <div style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <h3 style={subHead}>Earners &amp; retirement</h3>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--muted)', cursor: 'pointer' }}>
            <input type="checkbox" checked={earners[1]?.enabled ?? false} onChange={e => updateEarner(1, { enabled: e.target.checked })} style={{ width: 'auto' }} />
            Two earners
          </label>
        </div>
        <div className="stack-mobile" style={{ display: 'grid', gridTemplateColumns: earners[1]?.enabled ? '1fr 1fr' : '1fr', gap: 20 }}>
          {earners.map((e, idx) => {
            if (!(idx === 0 || e.enabled)) return null;
            const ssOpt = ssOptimal(e.income, A.endAge);
            return (
            <div key={idx} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 14 }}>
              <div style={{ marginBottom: 8 }}>
                <TextInput value={e.label} placeholder="Name" onCommit={v => updateEarner(idx, { label: v })}
                  style={{ fontSize: 14, fontWeight: 600, padding: '3px 6px' }} />
              </div>
              {([
                ['Current age', 'currentAge', ''],
                ['Gross income / yr', 'income', '$'],
              ] as [string, keyof Earner, string][]).map(([label, key, pre]) => {
                const impKey = `earner${idx}.${key}`;
                return (
                <div key={key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0' }}>
                  <span style={{ fontSize: 13, color: 'var(--muted)' }}>{label}</span>
                  <NumberInput value={e[key] as number} prefix={pre || undefined} imported={!!importedSet[impKey]}
                    onCommit={n => { updateEarner(idx, { [key]: n } as Partial<Earner>); clearImported(impKey); }} />
                </div>
              );})}
              {/* Annual raise: the income's own growth rate, independent of inflation. */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0' }}>
                <span style={{ fontSize: 13, color: 'var(--muted)' }} title="Your income's own annual growth, compounded each working year. Independent of inflation — set 0% for a field with no cost-of-living raises.">
                  Annual raise / yr
                </span>
                <NumberInput value={e.raisePct ?? 0.02} mul={100} step={0.5} suffix="%" required={false}
                  onCommit={n => updateEarner(idx, { raisePct: n })} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0' }}>
                <span style={{ fontSize: 13, color: 'var(--muted)' }}>Retire at age</span>
                <NumberInput value={e.retireAge} onCommit={n => updateEarner(idx, { retireAge: n })} />
              </div>
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
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginTop: 2 }}>
                      <span style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.3 }}
                        title={`Estimated from this income. Claiming earlier pays less per year but for more years; delaying pays more per year. Claiming at ${ssOpt.best} collects the most total Social Security if you live to ${A.endAge}${ssOpt.hi > ssOpt.lo ? ` — though ages ${ssOpt.lo}–${ssOpt.hi} come within ~2% of it` : ''}. “Apply estimate” sets your claim age and benefit (today's $).`}>
                        Best to claim at <strong>{ssOpt.best}</strong> if you live to {A.endAge} → ~{money(ssOpt.annual)}/yr{ssOpt.hi > ssOpt.lo ? ` (${ssOpt.lo}–${ssOpt.hi} ≈ equal)` : ''}
                      </span>
                      <button className="btn-ghost" style={{ fontSize: 11, whiteSpace: 'nowrap' }}
                        title={`Set claim age to ${ssOpt.best} and benefit to ${money(ssOpt.annual)}/yr (today's $)`}
                        onClick={() => updateEarner(idx, { ssClaimAge: ssOpt.best, ssAnnual: ssOpt.annual })}>Apply estimate</button>
                    </div>
                  </>
                )}
              </div>
            </div>
          );})}
        </div>
        <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>Each earner's income grows by its <strong>annual raise</strong> each year until retirement, then stops. This rate is independent of inflation — set it to 0% if your field has no cost-of-living adjustments. Set how much you contribute per account in “Accounts &amp; contributions” below.</p>
        </div>

        {/* — Household & Taxes — */}
        <div className="stack-mobile" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, borderTop: '1px solid var(--border)', marginTop: 16, paddingTop: 14 }}>
          <div>
            <h3 style={{ ...subHead, marginBottom: 10 }}>Household</h3>
            {numRow('Plan to age', 'endAge', 1, 1)}
            {/* Annual spending lives in “Annual spending & income, from your data” above when
                transaction data exists; shown here only as a fallback otherwise. */}
            {!(projection && projection.monthsAnalyzed > 0) && numRow('Annual spending', 'annualSpending', 1000, 1, '$')}

            {/* Current kids — cost is already in spending; tapers off as each grows up */}
            <div style={{ borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, color: 'var(--muted)' }}>Current kids <span style={{ opacity: 0.6 }}>({kidAges.length}{futureKids.length ? ` · ${futureKids.length} planned` : ''})</span></span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn-ghost" style={{ fontSize: 12 }} onClick={() => setKidAges(prev => [...prev, 0])}>+ Add kid</button>
                  <button className="btn-ghost" style={{ fontSize: 12 }}
                    title="Adds a draggable 🧒 marker to the chart for a child born in a future year"
                    onClick={() => { const id = 'k' + Date.now(); setEvents(prev => [...prev, { id, label: 'New kid', icon: '🧒', type: 'kid', age: Math.min(A.endAge, currentAge0 + 2), amount: 0 }]); setEditingId(id); }}>
                    + Plan future kid
                  </button>
                </div>
              </div>
              {(kidAges.length > 0 || futureKids.length > 0) && (<>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '8px 0' }}>
                  {kidAges.map((k, idx) => (
                    <span key={idx} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 14, padding: '2px 6px 2px 8px', fontSize: 12 }}>
                      🧒
                      <NumberInput value={k} width={38} required={false} suffix="yo" title="Kid's current age" imported={!!importedSet['kids']}
                        onCommit={n => { setKidAges(prev => prev.map((v, i2) => (i2 === idx ? n : v))); clearImported('kids'); }} />
                      <span onClick={() => setKidAges(prev => prev.filter((_, i2) => i2 !== idx))} title="Remove" style={{ cursor: 'pointer', color: 'var(--red)', marginLeft: 2 }}>×</span>
                    </span>
                  ))}
                  {/* Planned future kids — dashed chip, editable "born in N years"; mirrors the chart 🧒 marker. */}
                  {futureKids.map(e => (
                    <span key={e.id} title="Planned future child — set the years until they're born, or drag the 🧒 on the chart"
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 3, background: 'var(--bg)', border: '1px dashed var(--border)', borderRadius: 14, padding: '2px 6px 2px 8px', fontSize: 12 }}>
                      🧒
                      <span style={{ fontSize: 11, color: 'var(--muted)' }}>in</span>
                      <NumberInput value={e.age - currentAge0} width={30} required={false} suffix="y" title="Years until this child is born"
                        onCommit={n => updateEvent(e.id, { age: Math.round(currentAge0 + Math.max(0, n)) })} />
                      <span onClick={() => removeEvent(e.id)} title="Remove planned kid" style={{ cursor: 'pointer', color: 'var(--red)', marginLeft: 2 }}>×</span>
                    </span>
                  ))}
                </div>
                {numRow('Cost per kid / yr', 'costPerKid', 1000, 1, '$')}
                {numRow('Independent at age', 'kidIndependentAge', 1, 1)}
                {/* Show each kid's actual effect on the projection so it's clearly not a dead-end field. */}
                {kidAges.length > 0 && (<>
                  <div style={{ marginTop: 8, display: 'grid', gap: 3 }}>
                    {kidAges.map((k, idx) => {
                      const yearsToIndep = kidIndependentAge - k;
                      return yearsToIndep <= 0
                        ? <p key={idx} style={{ fontSize: 11, color: 'var(--muted)' }}>🧒 age {k}: already independent — no spending effect</p>
                        : <p key={idx} style={{ fontSize: 11, color: 'var(--text)' }}>🧒 age {k}: independent in {yearsToIndep}y → spending <strong>−{money(costPerKid)}/yr</strong> after</p>;
                    })}
                  </div>
                  <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>Current kids are already in your spending — it drops by the per-kid cost as each reaches independence (the empty-nest effect). College is modeled separately below.</p>
                </>)}
                {futureKids.length > 0 && (
                  <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>Planned kids <strong>add</strong> the per-kid cost while dependent (from birth to the independence age), plus college.</p>
                )}
              </>)}
            </div>

          </div>

          <div>
            <h3 style={{ ...subHead, marginBottom: 10 }}>Taxes</h3>
            {numRow('Tax rate while working %', 'effTaxRate', 1, 100, '', '%')}
            {numRow('Tax rate in retirement %', 'retireTaxRate', 1, 100, '', '%')}
            <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>Effective blended rates. Pre-tax withdrawals before age 60 add a 10% penalty; RMDs start at 73. Contribution limits live in “Accounts &amp; contributions” above.</p>
          </div>
        </div>

        {/* — Education — college & grad school, side by side (both depend on kids) */}
        <div style={{ borderTop: '1px solid var(--border)', marginTop: 16, paddingTop: 14 }}>
          <h3 style={{ ...subHead, marginBottom: 4 }}>Education</h3>
          <p style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 12 }}>
            Modeled per child{eduChildren.length === 0 ? ' — add kids in Household to project costs' : ''}. Funded from 529 first, then taxable. Cost / year is entered in today's dollars but <strong>reported in the dollars of the years attended</strong> (grown by education inflation).
          </p>
          <div className="stack-mobile" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
            {/* College */}
            <div>
              <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', marginBottom: collegeOn ? 4 : 0 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>🎓 College</span>
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
                {/* Reported in the dollars of the years attended (grown by education inflation). */}
                {eduChildren.length > 0 && (
                  <div style={{ marginTop: 8, display: 'grid', gap: 3 }}>
                    {eduChildren.map(c => {
                      const p = eduCost(c.ageNow, A.collegeStartAge, A.collegeYears, A.collegeCostPerYear, A.eduInflation);
                      if (!p) return <p key={c.key} style={{ fontSize: 11, color: 'var(--muted)' }}>🧒 {c.label}: past college age</p>;
                      const when = p.startsIn > 0 ? `in ${p.startsIn}y` : 'now';
                      return (
                        <p key={c.key} style={{ fontSize: 11, color: 'var(--text)' }}>
                          🧒 {c.label}: college {when} → <strong>~{money(p.perYear0)}/yr</strong> · ~{money(p.total)} total <span style={{ color: 'var(--muted)' }}>(at college)</span>
                        </p>
                      );
                    })}
                  </div>
                )}
              </>)}
            </div>

            {/* Grad school */}
            <div>
              <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', marginBottom: gradOn ? 4 : 0 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>📚 Grad school</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)' }}>
                  <input type="checkbox" checked={gradOn} onChange={e => setGradOn(e.target.checked)} style={{ width: 'auto' }} /> Include
                </span>
              </label>
              {gradOn && (<>
                {numRow("Cost / year (today's $)", 'gradCostPerYear', 1000, 1, '$')}
                {numRow('Years', 'gradYears', 1, 1)}
                {numRow('Starts at kid age', 'gradStartAge', 1, 1)}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0' }}>
                  <span style={{ fontSize: 13, color: 'var(--muted)' }}>You cover</span>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    {([['Full', 1], ['Partial', 0.5]] as [string, number][]).map(([lbl, v]) => {
                      const active = lbl === 'Full' ? A.gradCoverage >= 1 : A.gradCoverage < 1;
                      return <button key={lbl} className={active ? 'btn-primary' : 'btn-ghost'} style={{ fontSize: 11 }}
                        onClick={() => setA(prev => ({ ...DEFAULT_ASSUMPTIONS, ...prev, gradCoverage: v }))}>{lbl}</button>;
                    })}
                    {A.gradCoverage < 1 && <NumberInput value={A.gradCoverage * 100} suffix="%" width={58} required={false}
                      onCommit={n => setA(prev => ({ ...DEFAULT_ASSUMPTIONS, ...prev, gradCoverage: Math.max(0, Math.min(1, n / 100)) }))} />}
                  </div>
                </div>
                <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
                  You cover <strong>{Math.round(A.gradCoverage * 100)}%</strong> of grad school for each child, reported below in the dollars of the years attended.
                </p>
                {/* Reported in the dollars of the years attended (grown by education inflation). */}
                {eduChildren.length > 0 && (
                  <div style={{ marginTop: 8, display: 'grid', gap: 3 }}>
                    {eduChildren.map(c => {
                      const p = eduCost(c.ageNow, A.gradStartAge, A.gradYears, A.gradCostPerYear, A.eduInflation, A.gradCoverage);
                      if (!p) return <p key={c.key} style={{ fontSize: 11, color: 'var(--muted)' }}>🧒 {c.label}: past grad-school age</p>;
                      const when = p.startsIn > 0 ? `in ${p.startsIn}y` : 'now';
                      return (
                        <p key={c.key} style={{ fontSize: 11, color: 'var(--text)' }}>
                          🧒 {c.label}: grad school {when} → <strong>~{money(p.perYear0)}/yr</strong> · ~{money(p.total)} total <span style={{ color: 'var(--muted)' }}>(at grad school)</span>
                        </p>
                      );
                    })}
                  </div>
                )}
              </>)}
            </div>
          </div>
        </div>
        </>)}
      </div>

      {/* Accounts by tax treatment + contributions, with market assumptions tucked in */}
      <div style={card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: showContribs ? 12 : 0 }}>
            <div onClick={() => setShowContribs(s => !s)} title={showContribs ? 'Collapse' : 'Expand'}
              style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <h2 style={{ fontSize: 15, fontWeight: 600 }}>Accounts & contributions</h2>
              <span style={{ fontSize: 13, color: 'var(--muted)', userSelect: 'none' }}>{showContribs ? '▾ Hide' : '▸ Show'}</span>
            </div>
            {showContribs && taxData && taxData.accounts.length > 0 && (
              <button className="btn-ghost" style={{ fontSize: 12 }} onClick={() => setShowAccounts(s => !s)}>{showAccounts ? 'Hide accounts' : 'Edit accounts'}</button>
            )}
          </div>
          {showContribs && (<>
          {taxData ? (<>
          {/* Bucket totals bar */}
          {taxData.accounts.length > 0 && (
            <div style={{ display: 'flex', height: 12, borderRadius: 6, overflow: 'hidden', marginBottom: 12 }}>
              {(['taxable', 'pretax', 'roth', 'hsa', 'college'] as TaxBucket[]).map(b => {
                const pct = baseAccounts > 0 ? (pools0[b] / baseAccounts) * 100 : 0;
                return pct > 0 ? <div key={b} title={`${BUCKET_META[b].label}: ${money(pools0[b])}`} style={{ width: `${pct}%`, background: BUCKET_META[b].color }} /> : null;
              })}
            </div>
          )}
          {/* Per-bucket: starting balance + total annual contribution flowing in */}
          <div style={{ display: 'grid', gap: 2 }}>
            {(['taxable', 'pretax', 'roth', 'hsa', 'college'] as TaxBucket[]).map(b => (
              <div key={b} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0' }}>
                <span title={BUCKET_META[b].hint} style={{ width: 9, height: 9, borderRadius: 2, background: BUCKET_META[b].color, display: 'inline-block', flex: '0 0 auto' }} />
                <span title={BUCKET_META[b].hint} style={{ fontSize: 13, color: 'var(--muted)', width: 64 }}>{BUCKET_META[b].label}</span>
                <span style={{ fontSize: 13, fontWeight: 600, width: 110, textAlign: 'right' }}>{taxData.accounts.length > 0 ? money(pools0[b]) : ''}</span>
                <span style={{ marginLeft: 'auto', fontSize: 12, color: contribByBucket[b] > 0 ? 'var(--green)' : 'var(--muted)' }}>
                  {contribByBucket[b] > 0 ? `+${money(contribByBucket[b])}/yr` : '—'}
                </span>
              </div>
            ))}
            {/* Totals across all buckets */}
            {taxData.accounts.length > 0 && (() => {
              const totalBal = pools0.taxable + pools0.pretax + pools0.roth + pools0.hsa + pools0.college;
              const totalContribAnnual = contribByBucket.taxable + contribByBucket.pretax + contribByBucket.roth + contribByBucket.hsa + contribByBucket.college;
              return (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0 0', marginTop: 2, borderTop: '1px solid var(--border)' }}>
                  <span style={{ width: 9, flex: '0 0 auto' }} />
                  <span style={{ fontSize: 13, fontWeight: 600, width: 64 }}>Total</span>
                  <span style={{ fontSize: 13, fontWeight: 700, width: 110, textAlign: 'right' }}>{money(totalBal)}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 600, color: totalContribAnnual > 0 ? 'var(--green)' : 'var(--muted)' }}>
                    {totalContribAnnual > 0 ? `+${money(totalContribAnnual)}/yr` : '—'}
                  </span>
                </div>
              );
            })()}
          </div>
          <div style={{ borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 8 }}>
            <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '2px 0', fontSize: 13, color: 'var(--muted)', cursor: 'pointer' }}>
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
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 84px 200px 116px', gap: 10, padding: '0 0 4px 10px', fontSize: 10, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
                  <span>Account</span><span style={{ textAlign: 'right' }}>Balance</span><span style={{ textAlign: 'right' }}>Contribute / yr</span><span>Bucket</span>
                </div>
                {[...groups.entries()].map(([org, accs]) => (
                  <div key={org} style={{ marginBottom: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '2px 0 4px' }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>{org}</span>
                      <span style={{ fontSize: 11, color: 'var(--muted)' }}>{money(accs.reduce((t, x) => t + x.balance, 0))}</span>
                    </div>
                    {accs.map(acc => (
                      <div key={acc.id} style={{ display: 'grid', gridTemplateColumns: '1fr 84px 200px 116px', gap: 10, alignItems: 'center', padding: '3px 0 3px 10px', fontSize: 12 }}>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={acc.name}>{acc.name}</span>
                        <span style={{ textAlign: 'right', color: 'var(--muted)' }}>{money(acc.balance)}</span>
                        {/* Max-fill buttons sit inline, just left of the input, so the input's
                            right edge lines up across every row. Only shown for federally-limited buckets. */}
                        <div style={{ justifySelf: 'end', display: 'flex', alignItems: 'center', gap: 5 }}>
                          {(() => {
                            const b = bucketOf(acc);
                            const set = (v: number) => setAccountContribs(prev => ({ ...prev, [acc.id]: v }));
                            const mb: React.CSSProperties = { fontSize: 10, padding: '2px 6px', lineHeight: 1.4 };
                            if (b === 'pretax') return (<>
                              <button className="btn-ghost" style={mb} title={`${limitYear} max employee deferral (401(k)/403(b)) — ${money(irs.k401Employee)}/yr`} onClick={() => set(irs.k401Employee)}>EE</button>
                              <button className="btn-ghost" style={mb} title={`${limitYear} max employee + employer (401(k)/403(b), §415(c)) — ${money(irs.k401Total)}/yr`} onClick={() => set(irs.k401Total)}>EE+ER</button>
                            </>);
                            if (b === 'roth') return <button className="btn-ghost" style={mb} title={`${limitYear} max Roth IRA — ${money(irs.ira)}/yr`} onClick={() => set(irs.ira)}>Max</button>;
                            if (b === 'hsa') return <button className="btn-ghost" style={mb} title={`${limitYear} max HSA, family coverage — ${money(irs.hsaFamily)}/yr`} onClick={() => set(irs.hsaFamily)}>Max</button>;
                            return null;
                          })()}
                          <NumberInput value={accountContribs[acc.id] ?? 0} prefix="$" width={84} required={false}
                            onCommit={n => setAccountContribs(prev => ({ ...prev, [acc.id]: n }))} />
                        </div>
                        <select value={bucketOf(acc)} onChange={ev => setBucketOverrides(prev => ({ ...prev, [acc.id]: ev.target.value as TaxBucket }))}
                          style={{ fontSize: 12, padding: '2px 4px' }}>
                          {(['taxable', 'pretax', 'roth', 'hsa', 'college'] as TaxBucket[]).map(b => <option key={b} value={b}>{BUCKET_META[b].label}</option>)}
                        </select>
                      </div>
                    ))}
                  </div>
                ))}
                <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>Enter your total yearly contribution to each account (include employer match), or use the <strong>EE</strong>/<strong>EE+ER</strong>/<strong>Max</strong> buttons to fill the {limitYear} IRS maximum (shown only for pre-tax, Roth &amp; HSA accounts). Pre-tax &amp; HSA contributions are tax-deductible; contributions stop once everyone has retired. Buckets are guessed from account names — fix any that are wrong; withdrawals draw taxable → pre-tax → Roth, HSA last.</p>
              </div>
            );
          })()}
          </>) : (
            <p style={{ fontSize: 13, color: 'var(--muted)' }}>Connect accounts to break your balances down by tax treatment.</p>
          )}

          {/* Market Assumptions — hideable; nominal market & inflation rates that drive the sim. */}
          <div style={{ borderTop: '1px solid var(--border)', marginTop: 14, paddingTop: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <h3 style={{ ...subHead, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                Market Assumptions
                <InfoTip text="Presets are based on the S&P 500 index for stock returns & volatility, the U.S. CPI for inflation, and the S&P CoreLogic Case-Shiller national home-price index for real estate." />
              </h3>
              <button className="btn-ghost" style={{ fontSize: 12 }} onClick={() => setShowMarket(s => !s)}>{showMarket ? 'Hide' : 'Show'}</button>
            </div>
            {showMarket && (<>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '10px 0' }}>
                {MARKET_PRESETS.map(p => (
                  <button key={p.label} className="btn-ghost" style={{ fontSize: 11 }}
                    title={`S&P 500 ${p.label}: ${Math.round(p.investReturn * 100)}% return, ${Math.round(p.volatility * 100)}% vol, ${Math.round(p.inflation * 1000) / 10}% inflation`}
                    onClick={() => setA(prev => ({ ...DEFAULT_ASSUMPTIONS, ...prev, investReturn: p.investReturn, volatility: p.volatility, inflation: p.inflation, realEstateGrowth: p.realEstateGrowth }))}>
                    {p.label}
                  </button>
                ))}
              </div>
              {numRow('Investment return %', 'investReturn', 0.5, 100, '', '%')}
              {numRow('Return volatility %', 'volatility', 1, 100, '', '%')}
              {numRow('Real estate growth %', 'realEstateGrowth', 0.5, 100, '', '%')}
              {numRow('Inflation %', 'inflation', 0.5, 100, '', '%')}
              <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>Returns are nominal (before inflation); the chart is in future dollars. Spending grows with inflation, income grows at each earner's own raise rate, and real estate at its own growth rate.</p>
            </>)}
          </div>
          </>)}
        </div>

      {/* Expense projection from real data */}
      {projection && projection.monthsAnalyzed > 0 && (
        <div ref={spendingRef} style={{ ...card, scrollMarginTop: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8, marginBottom: showSpending ? 4 : 0 }}>
            <div onClick={() => setShowSpending(s => !s)} title={showSpending ? 'Collapse' : 'Expand'}
              style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <h2 style={{ fontSize: 15, fontWeight: 600 }}>Annual spending &amp; income, from your data</h2>
              <span style={{ fontSize: 13, color: 'var(--muted)', userSelect: 'none' }}>{showSpending ? '▾ Hide' : '▸ Show'}</span>
            </div>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>{projection.monthsAnalyzed} month{projection.monthsAnalyzed === 1 ? '' : 's'} of transactions</span>
          </div>
          {showSpending && (<>
          <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>Averaged from your transactions — these feed the <strong>Annual spending</strong> assumption used by the forecast.</p>
          {/* Per-year vs per-month display toggle */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
            {([['Per year', true], ['Per month', false]] as [string, boolean][]).map(([label, val]) => (
              <button key={label} onClick={() => setProjAnnual(val)}
                className={projAnnual === val ? 'btn-primary' : 'btn-ghost'} style={{ fontSize: 11 }}>{label}</button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap', marginBottom: 14 }}>
            <div>
              <p style={{ color: 'var(--muted)', fontSize: 12 }}>Avg spending / {projAnnual ? 'yr' : 'mo'}</p>
              <p style={{ fontSize: 20, fontWeight: 700 }}>{money(projection.avgMonthlySpending * (projAnnual ? 12 : 1))}</p>
            </div>
            <div>
              <p style={{ color: 'var(--muted)', fontSize: 12 }}>Avg income / {projAnnual ? 'yr' : 'mo'}</p>
              <p style={{ fontSize: 20, fontWeight: 700 }}>{money(projection.avgMonthlyIncome * (projAnnual ? 12 : 1))}</p>
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
              <div style={{ display: 'grid', gap: 2 }}>
                {projection.byCategory.slice(0, 8).map(c => (
                  <div key={c.category} onClick={() => viewCategoryTxns(c.category)}
                    title={`View ${c.category} transactions`}
                    style={{ display: 'grid', gridTemplateColumns: '130px 1fr 80px', gap: 10, alignItems: 'center', fontSize: 12, cursor: 'pointer', padding: '4px 6px', margin: '0 -6px', borderRadius: 6 }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                    <span style={{ color: 'var(--muted)' }}>{c.category} <span style={{ opacity: 0.5 }}>›</span></span>
                    <div style={{ height: 6, background: 'var(--bg)', borderRadius: 4, overflow: 'hidden' }}>
                      <div style={{ width: `${(c.avgMonthly / max) * 100}%`, height: '100%', background: '#6c8fff', borderRadius: 4 }} />
                    </div>
                    <span style={{ textAlign: 'right' }}>{money(c.avgMonthly * (projAnnual ? 12 : 1))}/{projAnnual ? 'yr' : 'mo'}</span>
                  </div>
                ))}
                <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>Click a category to see its transactions.</p>
              </div>
            );
          })()}

          {/* Canonical Annual spending assumption + what-if scaling, together. */}
          <div style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Annual spending <span style={{ fontWeight: 400, color: 'var(--muted)', fontSize: 12 }}>(used by the forecast)</span></span>
              <NumberInput value={A.annualSpending} prefix="$"
                onCommit={n => setA(prev => ({ ...DEFAULT_ASSUMPTIONS, ...prev, annualSpending: n }))} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>What-if: adjust spending
                {spendingAdjust !== 1 && <span onClick={() => setSpendingAdjust(1)} style={{ marginLeft: 8, fontSize: 11, color: 'var(--accent)', cursor: 'pointer', fontWeight: 400 }}>reset</span>}
              </span>
              <span style={{ fontSize: 13, fontWeight: 700, color: spendingAdjust < 1 ? 'var(--green)' : spendingAdjust > 1 ? 'var(--red)' : 'var(--text)' }}>
                {spendingAdjust >= 1 ? '+' : ''}{Math.round((spendingAdjust - 1) * 100)}% · {money(A.annualSpending * spendingAdjust)}/yr
              </span>
            </div>
            <input type="range" min={0.5} max={1.5} step={0.05} value={spendingAdjust}
              onChange={e => setSpendingAdjust(parseFloat(e.target.value))}
              style={{ width: '100%', accentColor: 'var(--accent)', cursor: 'pointer' }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
              <span>Median at {A.endAge}: <strong style={{ color: 'var(--text)' }}>{moneyM(futureNW)}</strong></span>
              <span>Success: <strong style={{ color: sim.successPct >= 90 ? 'var(--green)' : sim.successPct >= 70 ? 'var(--amber)' : 'var(--red)' }}>{sim.successPct}%</strong></span>
            </div>
            <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>Scales your Annual spending for the whole projection — drag to see the impact, without changing the saved number.</p>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
            <button className="btn-ghost" style={{ fontSize: 12 }}
              onClick={() => {
                setPrevApplied({ income: earners[0]?.income ?? 0, spending: A.annualSpending });
                setA(prev => ({ ...DEFAULT_ASSUMPTIONS, ...prev, annualSpending: projection.avgMonthlySpending * 12 }));
                updateEarner(0, { income: projection.avgMonthlyIncome * 12 });
                clearImported('earner0.income');
              }}>
              Use my actual income &amp; spending
            </button>
            {prevApplied && (
              <button className="btn-ghost" style={{ fontSize: 12 }}
                onClick={() => { setA(prev => ({ ...DEFAULT_ASSUMPTIONS, ...prev, annualSpending: prevApplied.spending })); updateEarner(0, { income: prevApplied.income }); setPrevApplied(null); }}>
                ↩ Revert
              </button>
            )}
            {projection.trendPctPerYear > 0 && (
              <button className="btn-ghost" style={{ fontSize: 12 }} onClick={() => setNum('inflation', 1)(String(projection.trendPctPerYear))}>
                Set inflation to my {Math.round(projection.trendPctPerYear * 100)}%/yr trend
              </button>
            )}
          </div>
          </>)}
        </div>
      )}

      {/* Year-by-year forecast table — the raw numbers the Monte Carlo produces */}
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: showTable ? 12 : 0, gap: 12, flexWrap: 'wrap' }}>
          <div onClick={() => setShowTable(s => !s)} title={showTable ? 'Collapse' : 'Expand'}
            style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <h2 style={{ fontSize: 15, fontWeight: 600 }}>Forecast table</h2>
            <span style={{ fontSize: 13, color: 'var(--muted)', userSelect: 'none' }}>{showTable ? '▾ Hide' : '▸ Show'}</span>
          </div>
          {showTable && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>Every</span>
              {[1, 5, 10].map(n => (
                <button key={n} onClick={() => setTableInterval(n)}
                  className={tableInterval === n ? 'btn-primary' : 'btn-ghost'} style={{ fontSize: 11 }}>{n}y</button>
              ))}
            </div>
          )}
        </div>
        {showTable && (() => {
          // Sample the per-year sim output at the chosen interval, always keeping
          // the first and final year so the endpoints are visible.
          const rows = sim.bands.filter((b, i) => i % tableInterval === 0 || i === sim.bands.length - 1);
          const cols: { key: string; label: string; fmt: (b: typeof sim.bands[number]) => string; color?: string }[] = [
            { key: 'year', label: 'Year', fmt: b => String(b.year) },
            { key: 'age', label: 'Age', fmt: b => String(b.age) },
            { key: 'income', label: 'Income', fmt: b => money(b.income), color: 'var(--green)' },
            { key: 'spending', label: 'Spending', fmt: b => money(b.spending), color: 'var(--red)' },
            { key: 'invP50', label: 'Investable (median)', fmt: b => money(b.invP50) },
            { key: 're', label: 'Real estate', fmt: b => money(b.re) },
            { key: 'p50', label: 'Net worth (median)', fmt: b => money(b.p50) },
            { key: 'range', label: 'Net worth 10–90%', fmt: b => `${moneyM(b.p10)} – ${moneyM(b.p10 + b.band)}` },
          ];
          return (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
                <thead>
                  <tr>
                    {cols.map((c, i) => (
                      <th key={c.key} style={{ textAlign: i < 2 ? 'left' : 'right', padding: '6px 10px', color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, fontSize: 10, borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{c.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((b, ri) => (
                    <tr key={b.year} style={{ borderBottom: '1px solid var(--border)', background: b.age === retireAge0 ? 'rgba(245,158,11,0.08)' : ri % 2 ? 'var(--bg)' : 'transparent' }}>
                      {cols.map((c, ci) => (
                        <td key={c.key} title={c.key === 'age' && b.age === retireAge0 ? 'Retirement age' : undefined}
                          style={{ textAlign: ci < 2 ? 'left' : 'right', padding: '5px 10px', color: c.color, whiteSpace: 'nowrap', filter: privacy && ci >= 2 ? 'blur(5px)' : 'none' }}>
                          {c.fmt(b)}{c.key === 'age' && b.age === retireAge0 ? ' 🏖️' : ''}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>
                The deterministic flows (income, spending) and the Monte Carlo percentiles ({RUNS} runs) per year, sampled every {tableInterval} year{tableInterval === 1 ? '' : 's'}. The highlighted row marks your retirement age ({retireAge0}). Figures are nominal (future dollars): income grows at its own raise rate, spending &amp; Social Security at inflation, and real estate at its own growth rate.
              </p>
            </div>
          );
        })()}
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
