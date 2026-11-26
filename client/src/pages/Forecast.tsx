import { useMemo, useCallback, useRef, useState, useEffect, useDeferredValue } from 'react';
import { ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, ReferenceArea } from 'recharts';
import { useApi } from '../hooks/useApi.ts';
import { usePersistentState, writePersistent } from '../hooks/usePersistentState.ts';
import TopNav, { type View } from '../components/TopNav.tsx';
import { MONTE_CARLO_RUNS, DEFAULT_ASSUMPTIONS, DEFAULT_EARNERS, padEarners, type Assumptions, type Earner } from '../lib/forecastConfig.ts';
import { runForecastSim, backcastHistory, bandOnReaching, balanceYearsOut, flowYearsOut, deflateReal, baselineMedianAt, GLIDE_EQUITY_START, GLIDE_EQUITY_END, type SimInput, type SimRealEstate, type SimResult } from '../lib/forecastSim.ts';
import { fmtMoney, fmtMoneyCompact, fmtDate } from '../lib/format.ts';
import { DEFAULT_TAX_PLAN, normalizeTaxPlan, resolveFiling, simTaxFor, type TaxPlan } from '../lib/taxPlan.ts';
import TaxPicture, { TaxControls } from '../components/forecast/TaxPicture.tsx';
import Backtest from '../components/forecast/Backtest.tsx';
import SpendingRule from '../components/forecast/SpendingRule.tsx';
import PlanAnswers from '../components/forecast/PlanAnswers.tsx';
import NumberInput from '../components/forecast/NumberInput.tsx';
import { HeadTile, AnswerHeadTiles, HEADLINE_ANSWERS } from '../components/forecast/HeadlineTiles.tsx';
import { usePlanAnswers } from '../components/forecast/usePlanAnswers.ts';
import MilestoneLane, { type LaneMark } from '../components/forecast/MilestoneLane.tsx';
import BaselineMenu from '../components/forecast/BaselineMenu.tsx';
import YearTable from '../components/forecast/YearTable.tsx';
import { capYAxis, fmtMoneyShort } from '../lib/forecastDisplay.ts';
import { fmtAxisMoney } from '../lib/axis.ts';
import { earnerSummary, ssSummary, spendingSummary, savingsSummary, homeSummary, familySummary, assumptionsSummary, leverPhrases, whatIfSentence } from '../lib/forecastSummaries.ts';
import PlanVsActual from '../components/forecast/PlanVsActual.tsx';
import Scenarios from '../components/forecast/Scenarios.tsx';
import { makePin, canTrack, type PinnedBaseline } from '../lib/planTrack.ts';
import { withTodaysAges, type ScenarioSettings } from '../lib/forecastScenarios.ts';
import { DEFAULT_BACKTEST_SETTINGS, normalizeBacktestSettings, simExtrasFor, summarizeCuts, type BacktestSettings } from '../lib/backtest.ts';
import { DEFAULT_WITHDRAWAL_RULE, normalizeWithdrawalRule, RULE_LABELS, type WithdrawalRule } from '../lib/withdrawalRules.ts';
import { monthlyMortgagePayment, payoffYearsFromNow } from '../lib/mortgage.ts';

interface Snapshot { date: string; accounts_total: number; real_estate_total: number; net_worth: number }
// Properties from the Net Worth breakdown — loan terms + carrying costs drive the
// Forecast's explicit real-estate model (value appreciates, mortgage amortizes,
// housing outflow charged until payoff).
interface FcProperty {
  id: number; address: string;
  zestimate: number | null; mortgage_balance: number;
  mortgage_principal: number | null; mortgage_rate: number | null;
  mortgage_start: string | null; mortgage_term_years: number | null;
  property_tax_annual: number | null; insurance_annual: number | null; hoa_annual: number | null;
  rental_income_annual: number | null;
}
// Manual assets/liabilities from the Net Worth breakdown. A set interest_rate
// pulls the entry out of the volatile investment pool and grows it steadily.
interface FcManualAsset { id: number; value: number; interest_rate: number | null }
interface Breakdown { properties: FcProperty[]; manualAssets: FcManualAsset[] }
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
  taxable: { label: 'Taxable', color: 'var(--accent)', hint: 'Brokerage, checking, savings — withdraw first, no penalty.' },
  pretax: { label: 'Pre-tax', color: 'var(--amber)', hint: '401(k)/403(b)/IRA — taxed on withdrawal, 10% penalty before 59½, RMDs at 73.' },
  roth: { label: 'Roth', color: 'var(--green)', hint: 'Roth IRA/401(k) — tax-free growth & withdrawals.' },
  hsa: { label: 'HSA', color: '#f472b6', hint: 'Triple tax-advantaged — left to grow until needed last.' },
  college: { label: '529', color: 'var(--accent-2)', hint: 'Education savings (529, Coverdell, Trump Account) — spent first on college costs.' },
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
  isSale?: boolean;    // oneTime: amount is cash in (a sale/windfall), not a cost
}
const EVENT_TYPE_META: Record<EventType, { icon: string; label: string }> = {
  oneTime: { icon: '💸', label: 'Big purchase / one-time cost' },
  recurring: { icon: '🔁', label: 'Recurring expense / yr' },
  recurringEvery: { icon: '🚗', label: 'Repeat purchase every N yrs' },
  income: { icon: '📈', label: 'Income change' },
  kid: { icon: '🧒', label: 'Have a kid' },
};
// Quick-add presets for common life events. Each seeds a fully-formed event (type,
// icon, amount, sign) the user can then fine-tune.
const EVENT_PRESETS: { label: string; icon: string; type: EventType; amount: number; isSale?: boolean }[] = [
  { label: 'Buy a home', icon: '🏠', type: 'oneTime', amount: 150000 },
  { label: 'Buy vacation home', icon: '🏖️', type: 'oneTime', amount: 120000 },
  { label: 'Go part time', icon: '🐢', type: 'income', amount: -60000 },
  { label: 'Business sale', icon: '💰', type: 'oneTime', amount: 500000, isSale: true },
  { label: 'New car', icon: '🚗', type: 'recurringEvery', amount: 40000 },
  { label: 'Have a kid', icon: '🧒', type: 'kid', amount: 0 },
];
// Quick icon palette so a "big purchase" can be a home, car, trip, etc.
const ICON_CHOICES = ['💸', '🏠', '🏖️', '🚗', '✈️', '💍', '🛠️', '🏥', '🎓', '💰', '🧒', '🎉'];

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
// with matching CPI inflation and home-price growth. These are hard-coded rounded
// figures (added mid-2026), NOT live data and with no exact as-of date — the UI
// labels them "historical, approximate". Rough, for quick scenarios.
const MARKET_PRESETS: { label: string; investReturn: number; volatility: number; inflation: number; realEstateGrowth: number }[] = [
  { label: 'Trailing 5y', investReturn: 0.14, volatility: 0.18, inflation: 0.04, realEstateGrowth: 0.06 },
  { label: 'Trailing 10y', investReturn: 0.125, volatility: 0.15, inflation: 0.03, realEstateGrowth: 0.05 },
  { label: 'Trailing 20y', investReturn: 0.10, volatility: 0.16, inflation: 0.025, realEstateGrowth: 0.05 },
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

const TABS = ['Net Worth', 'Cash Flow', 'Investable assets'] as const;
type Tab = typeof TABS[number];
const TAB_LABEL: Record<Tab, string> = { 'Net Worth': 'Net worth', 'Cash Flow': 'Cash flow', 'Investable assets': 'Investable assets' };

// What-if levers under the chart: temporary overrides layered on the plan so a
// change can be tried without editing the saved inputs. null = follow the plan.
// (The spending lever is the long-standing `spendingAdjust` multiplier.)
// "You retire" / "Partner retires" for the chart's retirement markers.
function retiresLabel(who: string): string {
  return /^you$/i.test(who.trim()) ? `${who} retire` : `${who} retires`;
}

interface Levers { retireAge: number | null; extraSave: number; investReturn: number | null }
const NO_LEVERS: Levers = { retireAge: null, extraSave: 0, investReturn: null };

// The input sections, in page order. Partner, Social Security and Spending were
// part of "You" before they had sections of their own.
const GROUP_KEYS = ['you', 'partner', 'ss', 'spending', 'savings', 'home', 'family', 'advanced'] as const;
const GROUP_INHERITS_YOU: string[] = ['partner', 'ss', 'spending'];
const groupOpenIn = (g: Record<string, boolean>, k: string) => !!(g[k] ?? (GROUP_INHERITS_YOU.includes(k) ? g.you : false));
// Status word for a success probability (same thresholds as the colour).
const successStatus = (pct: number) => (pct >= 90 ? 'On track' : pct >= 70 ? 'Borderline' : 'At risk');
const successColor = (pct: number) => (pct >= 90 ? 'var(--green)' : pct >= 70 ? 'var(--amber)' : 'var(--red)');
const successTint = (pct: number) => (pct >= 90 ? 'rgba(74,222,128,0.14)' : pct >= 70 ? 'rgba(251,191,36,0.14)' : 'rgba(248,113,113,0.14)');
// Cash-flow colours: blue/orange (not green/red) so saving vs drawing down reads
// by lightness too, not hue alone.
const CF_INCOME = 'var(--accent)', CF_SPEND = '#fb923c';
const RUNS = MONTE_CARLO_RUNS;
const PLOT_LEFT = 60, PLOT_RIGHT = 16;
// The Monte Carlo simulation (and its PRNG/percentile helpers) lives in
// ../lib/forecastSim.ts so it can be unit-tested in isolation.

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

// Small "×" dismiss / remove control as a real, labelled button.
function XButton({ onClick, label, color = 'var(--muted)', style }: {
  onClick: () => void; label: string; color?: string; style?: React.CSSProperties;
}) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick}
      style={{ background: 'none', border: 'none', padding: '0 3px', borderRadius: 4, color, fontSize: 16, fontWeight: 400, lineHeight: 1, ...style }}>×</button>
  );
}

// One collapsible section in the inputs column (You, Partner, Social Security,
// Spending, Savings, …). Sections start folded: a folded row states the
// section's current values in one line ("40 · $71,772 a year · retires at 65"),
// so the column reads as a digest of the plan and only the section being edited
// takes up room. `peek` renders under the header while closed (e.g. the savings
// bucket bar). `id` is the scroll target for milestone pins.
function Group({ id, open, onToggle, title, summary, summaryColor, badge, peek, first = false, children }: {
  id?: string; open: boolean; onToggle: () => void; title: string; summary?: React.ReactNode; summaryColor?: string;
  badge?: React.ReactNode; peek?: React.ReactNode; first?: boolean; children: React.ReactNode;
}) {
  return (
    <div id={id} className="fc-anchor" style={{ borderTop: first ? 'none' : '1px solid var(--border)' }}>
      <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
        <button type="button" aria-expanded={open} onClick={onToggle} className="fc-group-btn"
          style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '14px 0', minHeight: 52,
            background: 'none', border: 'none', borderRadius: 4, color: 'inherit', font: 'inherit', textAlign: 'left' }}>
          <span style={{ flex: 'none' }}>{title}</span>
          {badge}
          {!open && summary && (
            <span className="fc-group-sum" style={{ color: summaryColor ?? 'var(--muted)' }}>{summary}</span>
          )}
          <span aria-hidden="true" style={{ marginLeft: open || !summary ? 'auto' : 0, fontSize: 14, fontWeight: 400, color: 'var(--muted)', width: 12, textAlign: 'center', flex: 'none' }}>{open ? '▾' : '▸'}</span>
        </button>
      </h2>
      {!open && peek}
      {open && <div className="fc-group-body" style={{ paddingBottom: 16 }}>{children}</div>}
    </div>
  );
}

// One what-if slider: label + current value and the range input. The combined
// effect of every moved slider is one sentence under them (whatIfSentence).
function Lever({ id, label, valueText, min, max, step, value, onChange, active, note }: {
  id: string; label: string; valueText: string; min: number; max: number; step: number; value: number;
  onChange: (n: number) => void; active: boolean;
  note?: string; // a standing caveat (the return lever while replaying past markets)
}) {
  return (
    <div style={{ background: 'var(--bg)', border: '1px solid ' + (active ? 'color-mix(in srgb, var(--accent) 55%, transparent)' : 'var(--border)'), borderRadius: 10, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', columnGap: 8 }}>
        <label htmlFor={id} style={{ fontSize: 13, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{label}</label>
        <span style={{ fontSize: 14, fontWeight: 700, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{valueText}</span>
      </div>
      <input id={id} type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        style={{ width: '100%', accentColor: 'var(--accent)', cursor: 'pointer', margin: 0 }} />
      {note && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{note}</span>}
    </div>
  );
}

// Chart tooltip: one tidy "Median $X · Range $a – $b" readout (the raw series are a
// stacked transparent base + band WIDTH, which are meaningless on their own). Values
// arrive already deflated when the chart is in today's dollars.
type ChartRow = Record<string, number | undefined>;
function ForecastTooltip({ active, payload, tab, yearNow, currentAge0, money, unit, spendLabel = 'Spending' }: {
  active?: boolean; payload?: { payload?: ChartRow }[]; tab: Tab; yearNow: number; currentAge0: number;
  money: (n: number) => string; unit: string; spendLabel?: string;
}) {
  const row = payload?.[0]?.payload;
  if (!active || !row || typeof row.age !== 'number') return null;
  const num = (k: string) => (typeof row[k] === 'number' ? (row[k] as number) : null);
  const lines: { label: string; value: string; color: string }[] = [];
  const addMedianRange = (medianLabel: string, med: string, lo: string, band: string, color: string, baseKey: string) => {
    const m = num(med), l = num(lo), w = num(band), b = num(baseKey);
    if (m != null) lines.push({ label: medianLabel, value: money(m), color });
    // The past (modeled back-projection) has no spread — nothing to show as a range.
    if (l != null && w != null && w > 0.5) lines.push({ label: 'Range (10th–90th pct)', value: `${money(l)} – ${money(l + w)}`, color: 'var(--muted)' });
    if (b != null) lines.push({ label: 'Baseline median', value: money(b), color: 'var(--muted)' });
  };
  if (tab === 'Net Worth') addMedianRange('Median net worth', 'p50', 'p10', 'band', 'var(--accent)', 'basep50');
  else if (tab === 'Investable assets') addMedianRange('Median investable assets', 'invP50', 'invP10', 'invBand', 'var(--amber)', 'baseInvP50');
  else {
    const inc = num('income'), sp = num('spending');
    if (inc != null) lines.push({ label: 'Income + SS', value: money(inc), color: CF_INCOME });
    if (sp != null) lines.push({ label: spendLabel, value: money(sp), color: CF_SPEND });
    if (inc != null && sp != null && Math.abs(inc - sp) > 0.5) {
      lines.push(inc >= sp
        ? { label: 'Saving', value: money(inc - sp), color: CF_INCOME }
        : { label: 'Drawing from savings', value: money(sp - inc), color: CF_SPEND });
    }
  }
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px', fontSize: 12, lineHeight: 1.6 }}>
      <div style={{ fontWeight: 600, marginBottom: 2 }}>Age {row.age} · {yearNow + (row.age - currentAge0)}{row.age < currentAge0 ? ' (modeled past)' : ''}</div>
      {lines.map(l => (
        <div key={l.label} style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
          <span style={{ color: l.color }}>{l.label}</span><span style={{ fontWeight: 600 }}>{l.value}</span>
        </div>
      ))}
      <div style={{ color: 'var(--muted)', fontSize: 11, marginTop: 2 }}>{unit}</div>
    </div>
  );
}

export default function Forecast({ onNavigate, privacy, onTogglePrivacy }: {
  onNavigate: (v: View) => void; privacy: boolean; onTogglePrivacy: () => void;
}) {
  const { data: hist, loading: histLoading, error: histError, refetch: refetchHist } = useApi<Snapshot[]>('/api/net-worth/history?days=10000');
  const { data: projection } = useApi<Projection>('/api/budget/projection');
  const { data: taxData, loading: taxLoading } = useApi<TaxBucketsResp>('/api/net-worth/tax-buckets');
  const { data: breakdown, loading: breakdownLoading } = useApi<Breakdown>('/api/net-worth/breakdown');
  const latest = hist?.[0];
  // Nothing to simulate until the starting balances exist: without a net-worth
  // snapshot (and the tax-bucket / property breakdowns that split it) the sim would
  // run on $0 and flash a bogus "Current net worth $0" before the real data lands.
  const dataReady = !!latest && !taxLoading && !breakdownLoading;
  const baseAccounts = latest?.accounts_total ?? 0;
  const baseRE = latest?.real_estate_total ?? 0;
  // currentNW (and the effective, exclusion-aware bases) are derived below, once
  // the per-asset exclusion state and the property breakdown are available.

  const [tabRaw, setTab] = usePersistentState<string>('mon.fcTab', 'Net Worth');
  // The third tab was called "Success %" before it was renamed to what it plots.
  const tab: Tab = (TABS as readonly string[]).includes(tabRaw) ? tabRaw as Tab : tabRaw === 'Success %' ? 'Investable assets' : 'Net Worth';
  const [a, setA] = usePersistentState<Assumptions>('mon.fcAssumptions', DEFAULT_ASSUMPTIONS);
  const [earnersRaw, setEarnersRaw] = usePersistentState<Earner[]>('mon.fcEarners', DEFAULT_EARNERS);
  // The page and the sim index earners[0] and earners[1]; a persisted list that is
  // too short (or has a junk entry) is padded with the defaults rather than crashing.
  const earners = useMemo(() => padEarners(earnersRaw), [earnersRaw]);
  const setEarners = useCallback((u: Earner[] | ((prev: Earner[]) => Earner[])) =>
    setEarnersRaw(prev => (typeof u === 'function' ? u(padEarners(prev)) : u)), [setEarnersRaw]);
  // Set once the user edits (or imports into) the earner inputs. Until then the
  // age / income / Social Security figures are the built-in placeholders, and the
  // page says so rather than letting them pass for real data.
  const [earnersEdited, setEarnersEdited] = usePersistentState('mon.fcEarnersEdited', false);
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
    if (income != null || num(f.spouseIncome) != null) setEarnersEdited(true);
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
  }, [pendingImport, kidAges, setEarners, setA, setKidAges, setImported, setPendingImport, setEarnersEdited]);
  const [accountContribs, setAccountContribs] = usePersistentState<Record<string, number>>('mon.fcAccountContribs', {}); // annual $/yr per account id
  // Accounts / properties the user has switched off — excluded from the forecast's
  // starting balances (and contributions). Keyed by account id / property id.
  const [excludedAccounts, setExcludedAccounts] = usePersistentState<Record<string, boolean>>('mon.fcExcludedAccounts', {});
  const [excludedRE, setExcludedRE] = usePersistentState<Record<string, boolean>>('mon.fcExcludedRE', {});
  // Chart unit: "today's dollars" (default — deflated by inflation, so the numbers
  // read like real money) vs nominal "future dollars". A new key, so everyone
  // starts on today's dollars once rather than keeping the old nominal default.
  const [realDollars, setRealDollars] = usePersistentState('mon.fcTodayDollars', true);
  const [hsaLast, setHsaLast] = usePersistentState('mon.fcHsaLast', true);
  // Per-property opt-in: this property's equity may be sold/tapped to cover late-life
  // shortfalls (downsize / reverse mortgage). Keyed by property id.
  const [sellableRE, setSellableRE] = usePersistentState<Record<string, boolean>>('mon.fcSellableRE', {});
  const [glidePath, setGlidePath] = usePersistentState('mon.fcGlidePath', false); // de-risk equity exposure with age
  // Bracket tax model + Roth conversions (opt-in; flat rates by default). Its own key, not sent to the assistant.
  const [taxPlanRaw, setTaxPlan] = usePersistentState<TaxPlan>('mon.fcTaxPlan', DEFAULT_TAX_PLAN);
  const taxPlan = useMemo(() => normalizeTaxPlan(taxPlanRaw), [taxPlanRaw]);
  // Historical backtest / return model and the retirement spending rule — their own
  // keys (not fcAssumptions), so they never ship to the AI assistant. Default off.
  const [backtestRaw, setBacktest] = usePersistentState<BacktestSettings>('mon.fcReturnModel', DEFAULT_BACKTEST_SETTINGS);
  const backtestSettings = useMemo(() => normalizeBacktestSettings(backtestRaw), [backtestRaw]);
  const [spendRuleRaw, setSpendRule] = usePersistentState<WithdrawalRule>('mon.fcSpendingRule', DEFAULT_WITHDRAWAL_RULE);
  const spendRule = useMemo(() => normalizeWithdrawalRule(spendRuleRaw), [spendRuleRaw]);
  // A pinned "baseline" snapshot of the projection. When set, the chart overlays it
  // as a dashed ghost line and shows the delta vs. now — so the effect of an edit is
  // visible at a glance without flipping back and forth.
  // New pins also record each band's range and the starting net worth (plan vs actual,
  // lib/planTrack.ts); older pins without them still load.
  const [baseline, setBaseline] = usePersistentState<PinnedBaseline | null>('mon.fcBaseline', null);
  const [collegeOn, setCollegeOn] = usePersistentState('mon.fcCollegeOn', true);
  const [gradOn, setGradOn] = usePersistentState('mon.fcGradOn', false);
  const [seeded, setSeeded] = usePersistentState('mon.fcSeeded', false);
  const [projAnnual, setProjAnnual] = usePersistentState('mon.fcProjAnnual', true); // spending breakdown: show amounts per year vs per month
  // Which input sections are open. All start folded (each folded row states its
  // values). Partner, Social Security and Spending used to live inside "You", so
  // until they have their own saved state they follow it — a saved open "You"
  // still shows them open.
  const [groups, setGroups] = usePersistentState<Record<string, boolean>>('mon.fcGroups', {});
  const groupOpen = (k: string) => groupOpenIn(groups, k);
  const toggleGroup = (k: string) => setGroups(prev => ({ ...prev, [k]: !groupOpenIn(prev, k) }));
  const openGroup = (k: string) => setGroups(prev => (groupOpenIn(prev, k) ? prev : { ...prev, [k]: true }));
  const [showSpending, setShowSpending] = usePersistentState('mon.fcShowBreakdown', false); // spending breakdown (from transactions) inside "You"
  const [showAccounts, setShowAccounts] = useState(false);
  const [scenariosWide, setScenariosWide] = useState(false); // layout only: a wide scenario comparison takes the full width
  const [editingId, setEditingId] = useState<string | null>(null); // open life-event editor
  const [addMode, setAddMode] = useState(false); // arm chart click-to-add so stray clicks don't spawn events
  const [addMenuOpen, setAddMenuOpen] = useState(false); // life-event quick-add preset menu
  // Inputs section to scroll to once it has opened (from a milestone pin).
  const [scrollTo, setScrollTo] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false); // header ⋯ menu (reset)
  const addMenuRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  // Close the header / add-event menus on a press anywhere outside them.
  useEffect(() => {
    if (!addMenuOpen && !moreOpen) return;
    function onDown(e: PointerEvent) {
      const t = e.target as Node;
      if (addMenuOpen && addMenuRef.current && !addMenuRef.current.contains(t)) setAddMenuOpen(false);
      if (moreOpen && moreRef.current && !moreRef.current.contains(t)) setMoreOpen(false);
    }
    // Escape closes them too, like the Baseline menu.
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') { setAddMenuOpen(false); setMoreOpen(false); } }
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('pointerdown', onDown); window.removeEventListener('keydown', onKey); };
  }, [addMenuOpen, moreOpen]);

  // Restore the planning inputs to their defaults. Account bucket/contribution
  // settings are intentionally preserved (they reflect the user's real accounts);
  // clearing `seeded` lets income/spending re-seed from transaction data.
  function resetAll() {
    setMoreOpen(false);
    if (!confirm('Reset forecast assumptions, earners, and life events to defaults? Your account buckets and per-account contributions are kept.')) return;
    setA(DEFAULT_ASSUMPTIONS);
    setLevers(NO_LEVERS);
    setSpendingAdjust(1);
    setEarners(DEFAULT_EARNERS);
    setEarnersEdited(false);
    setEvents(DEFAULT_EVENTS);
    setKidAges([]);
    setSeeded(false);
    setAddMode(false);
    setImported({});
    setPendingImport(null);
    setTaxPlan(DEFAULT_TAX_PLAN);
    setBacktest(DEFAULT_BACKTEST_SETTINGS);
    setSpendRule(DEFAULT_WITHDRAWAL_RULE);
  }
  const [prevApplied, setPrevApplied] = usePersistentState<{ income: number; spending: number } | null>('mon.fcPrevApplied', null); // undo for "use my actual"
  const [spendingAdjust, setSpendingAdjust] = usePersistentState('mon.fcSpendingAdjust', 1); // what-if spending multiplier (the Spending lever)
  const [leversRaw, setLevers] = usePersistentState<Levers>('mon.fcLevers', NO_LEVERS);
  const levers = useMemo(() => ({ ...NO_LEVERS, ...leversRaw }), [leversRaw]);

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
  // Pin the chart card only while it fits in the window (see .fc-sticky.fits).
  const stickyRef = useRef<HTMLDivElement>(null);
  const [stickyFits, setStickyFits] = useState(true);
  useEffect(() => {
    const el = stickyRef.current;
    if (!el) return;
    const check = () => setStickyFits(el.offsetHeight + 72 <= window.innerHeight);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    window.addEventListener('resize', check);
    return () => { ro.disconnect(); window.removeEventListener('resize', check); };
  }, [dataReady]); // the card mounts once the data has loaded
  const yearNow = new Date().getFullYear(); // for the chart's age→year axis labels
  // Preceding years shown on the chart (modeled back-projection). The axis starts
  // at startAge; events can be placed back to there to set past life events whose
  // forward implications (a mortgage, recurring costs, a kid) the model carries.
  const [historyYears, setHistoryYears] = usePersistentState('mon.fcHistoryYears', 0);
  const startAge = Math.max(0, currentAge0 - Math.max(0, historyYears));

  // Explicit real-estate model from the user's properties (loan terms + carrying
  // costs). Null when there are no properties, which keeps the legacy baseRE path.
  const realEstate = useMemo<SimRealEstate | null>(() => {
    const props = (breakdown?.properties ?? []).filter(p => !excludedRE[String(p.id)]);
    if (!props.length) return null;
    const properties = props.map(p => {
      const hasTerms = p.mortgage_principal != null && p.mortgage_rate != null && !!p.mortgage_start;
      // With loan terms the mortgage amortizes; a manual balance is held static
      // (subtracts from equity, no paydown and no modeled payment).
      const ratePct = hasTerms ? (p.mortgage_rate as number) : 0;
      const monthlyPI = hasTerms ? monthlyMortgagePayment(p.mortgage_principal as number, p.mortgage_rate as number, p.mortgage_term_years ?? 30) : 0;
      return { value: p.zestimate ?? 0, balance: p.mortgage_balance ?? 0, ratePct, monthlyPI, sellable: !!sellableRE[String(p.id)] };
    });
    if (properties.reduce((t, p) => t + p.value, 0) <= 0) return null;
    const sum = (sel: (p: FcProperty) => number | null) => props.reduce((t, p) => t + (sel(p) ?? 0), 0);
    return {
      properties,
      propertyTaxAnnual: sum(p => p.property_tax_annual),
      insuranceAnnual: sum(p => p.insurance_annual),
      hoaAnnual: sum(p => p.hoa_annual),
      rentalIncomeAnnual: sum(p => p.rental_income_annual),
      taxGrowth: A.propertyTaxGrowth, insuranceGrowth: A.insuranceGrowth, hoaGrowth: A.hoaGrowth, rentalGrowth: A.rentalGrowth,
    };
  }, [breakdown, excludedRE, sellableRE, A.propertyTaxGrowth, A.insuranceGrowth, A.hoaGrowth, A.rentalGrowth]);
  // Latest mortgage payoff age across the included loans, for a chart marker.
  const payoffAge = useMemo(() => {
    const props = (breakdown?.properties ?? []).filter(p => !excludedRE[String(p.id)]);
    let maxYrs = 0;
    for (const p of props) {
      if (p.mortgage_start && p.mortgage_principal != null) {
        maxYrs = Math.max(maxYrs, payoffYearsFromNow(p.mortgage_start, p.mortgage_term_years ?? 30));
      }
    }
    return maxYrs > 0 ? Math.round(currentAge0 + maxYrs) : null;
  }, [breakdown, excludedRE, currentAge0]);

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

  const money = (n: number, opts?: { cents?: boolean; sign?: boolean }) => (privacy ? '••••••' : fmtMoney(n, opts));
  const moneyM = (n: number) => (privacy ? '•••' : fmtMoneyCompact(n));

  const bucketOf = (acc: TaxAccount): TaxBucket => bucketOverrides[acc.id] ?? acc.bucket;
  const acctExcluded = (acc: TaxAccount) => !!excludedAccounts[acc.id];

  // Effective starting balances after the user's per-asset exclusions: the dashboard
  // totals minus anything switched off. With nothing excluded these equal the raw
  // totals, so the default forecast is unchanged.
  const excludedAcctBal = (taxData?.accounts ?? []).filter(acctExcluded).reduce((t, a) => t + a.balance, 0);
  const effBaseAccounts = Math.max(0, baseAccounts - excludedAcctBal);
  const effBaseRE = breakdown
    ? breakdown.properties.filter(p => !excludedRE[String(p.id)]).reduce((t, p) => t + ((p.zestimate ?? 0) - (p.mortgage_balance ?? 0)), 0)
    : baseRE;
  const currentNW = effBaseAccounts + effBaseRE;

  // Manual assets/liabilities the user gave an explicit rate: pulled out of the
  // volatile investment pool and grown steadily at their own rate in the sim
  // instead. Unrated entries stay in the pool (legacy). Percent → fraction.
  const manualRated = useMemo(
    () => (breakdown?.manualAssets ?? [])
      .filter(m => m.interest_rate != null)
      .map(m => ({ value: m.value, rate: (m.interest_rate as number) / 100 })),
    [breakdown],
  );
  // The investment pools start from the accounts total minus the rated sleeve, so
  // those dollars aren't double-counted (they compound in the sleeve instead).
  const manualSleeveTotal = manualRated.reduce((t, m) => t + m.value, 0);
  const effLiquidAccounts = Math.max(0, effBaseAccounts - manualSleeveTotal);

  // Starting pool balances by tax bucket (excluded accounts dropped), scaled so
  // their sum equals the liquid accounts total (keeps the headline consistent).
  const pools0 = useMemo(() => {
    const raw: Record<TaxBucket, number> = { taxable: 0, pretax: 0, roth: 0, hsa: 0, college: 0 };
    for (const acc of taxData?.accounts ?? []) { if (acctExcluded(acc)) continue; raw[bucketOf(acc)] += acc.balance; }
    const sum = raw.taxable + raw.pretax + raw.roth + raw.hsa + raw.college;
    if (sum <= 0) return { taxable: effLiquidAccounts, pretax: 0, roth: 0, hsa: 0, college: 0 };
    const scale = effLiquidAccounts / sum;
    return { taxable: raw.taxable * scale, pretax: raw.pretax * scale, roth: raw.roth * scale, hsa: raw.hsa * scale, college: raw.college * scale };
  }, [taxData, bucketOverrides, excludedAccounts, effLiquidAccounts]); // eslint-disable-line react-hooks/exhaustive-deps

  // Annual contributions (today's $) summed per bucket — excluded accounts don't contribute.
  // A callback too, so a saved scenario's contributions map onto today's accounts the same way.
  const contribFor = useCallback((contribs: Record<string, number>) => {
    const r: Record<TaxBucket, number> = { taxable: 0, pretax: 0, roth: 0, hsa: 0, college: 0 };
    for (const acc of taxData?.accounts ?? []) { if (acctExcluded(acc)) continue; r[bucketOf(acc)] += contribs[acc.id] || 0; }
    return r;
  }, [taxData, bucketOverrides, excludedAccounts]); // eslint-disable-line react-hooks/exhaustive-deps
  const contribByBucket = useMemo(() => contribFor(accountContribs), [contribFor, accountContribs]);

  // Bracket tax settings for the sim — undefined in flat mode, so the default sim
  // input is exactly what it was before. A blank conversion start is left for the
  // sim to resolve from earner 0's retirement age, so the Retire lever moves it.
  const simTax = useMemo(() => simTaxFor(taxPlan, { twoEarners: !!earners[1]?.enabled }), [taxPlan, earners]);
  // Return model + spending rule fields for the sim — {} with the defaults.
  const simExtras = useMemo(() => simExtrasFor(backtestSettings, spendRule), [backtestSettings, spendRule]);
  // The plan's sim input (no levers). Each what-if variant below is this with a
  // few fields swapped, so the plan, the combined what-if and each lever's own
  // effect all come from the same model.
  const planInput = useMemo<SimInput>(() => ({
    A, currentAge0, infl, costPerKid, kidIndependentAge,
    kidAges, events, earners, pools0, contribByBucket, baseRE: effBaseRE,
    hsaLast, collegeOn, gradOn, spendingAdjust: 1, glidePath,
    realEstate: realEstate ?? undefined, manualAssets: manualRated, runs: RUNS,
    ...(simTax ? { tax: simTax } : {}),
    ...simExtras,
  }), [A, currentAge0, infl, costPerKid, kidIndependentAge, kidAges, events, earners, pools0, contribByBucket, effBaseRE, hsaLast, collegeOn, gradOn, glidePath, realEstate, manualRated, simTax, simExtras]);
  // Apply lever overrides: retirement age (earner 0), a spending multiplier,
  // extra yearly saving and the return.
  // Extra saving means spending that much less each working year. The plan
  // already invests every year's surplus, so adding it as a contribution only
  // re-routed money that was being saved anyway — and once it exceeded the
  // surplus it forced penalised pre-tax withdrawals, so more "saving" lowered
  // the result. It can't exceed what you spend.
  const withLevers = useCallback((l: Levers, spendAdj: number): SimInput => {
    const retireAt = l.retireAge ?? planInput.earners[0]?.retireAge ?? 65;
    const cut = Math.min(l.extraSave, planInput.A.annualSpending * spendAdj);
    return {
      ...planInput,
      spendingAdjust: spendAdj,
      A: l.investReturn != null ? { ...planInput.A, investReturn: l.investReturn } : planInput.A,
      earners: l.retireAge != null ? planInput.earners.map((e, i) => (i === 0 ? { ...e, retireAge: l.retireAge as number } : e)) : planInput.earners,
      events: cut > 0 && retireAt > planInput.currentAge0
        ? [...planInput.events, { type: 'recurring', age: planInput.currentAge0, untilAge: retireAt - 1, amount: -cut }]
        : planInput.events,
    };
  }, [planInput]);

  // Sliders update every tick while dragged; let the sims trail a frame behind so
  // the thumb stays smooth.
  const dLevers = useDeferredValue(levers);
  const dSpendAdj = useDeferredValue(spendingAdjust);
  const retireLeverOn = dLevers.retireAge != null && dLevers.retireAge !== (earners[0]?.retireAge ?? 65);
  const returnLeverOn = dLevers.investReturn != null && Math.abs(dLevers.investReturn - A.investReturn) > 1e-9;
  const saveLeverOn = dLevers.extraSave > 0;
  const spendLeverOn = Math.abs(dSpendAdj - 1) > 1e-9;
  const anyLever = retireLeverOn || returnLeverOn || saveLeverOn || spendLeverOn;

  const EMPTY_SIM: SimResult = { bands: [], successPct: 0 };
  const planSim = useMemo<SimResult>(() => (dataReady ? runForecastSim(planInput) : EMPTY_SIM),
    [planInput, dataReady]); // eslint-disable-line react-hooks/exhaustive-deps
  // What the page shows: the plan with every active lever applied.
  const sim = useMemo<SimResult>(() => (!dataReady ? EMPTY_SIM : anyLever ? runForecastSim(withLevers(dLevers, dSpendAdj)) : planSim),
    [withLevers, dLevers, dSpendAdj, anyLever, planSim, dataReady]); // eslint-disable-line react-hooks/exhaustive-deps
  // The shown plan without its Roth conversions, for the Tax picture's comparison.
  // With brackets and conversions on, one simulation costs ~100 ms, so it is run
  // only while the Tax picture is open, and a moment after the inputs settle (not
  // on every tick of a lever drag). Until then the last comparison stays shown.
  const [taxPictureOpen] = usePersistentState('mon.fcTaxOpen', true);
  const noConvInput = useMemo(() => (dataReady && taxPictureOpen && simTax?.conversions ? { ...withLevers(dLevers, dSpendAdj), tax: { ...simTax, conversions: null } } : null),
    [withLevers, dLevers, dSpendAdj, simTax, dataReady, taxPictureOpen]);
  const [simNoConv, setSimNoConv] = useState<SimResult | null>(null);
  useEffect(() => {
    if (!noConvInput) { setSimNoConv(null); return; }
    const t = setTimeout(() => setSimNoConv(runForecastSim(noConvInput)), 250);
    return () => clearTimeout(t);
  }, [noConvInput]);

  // The assistant's summary always describes the default model (random futures,
  // steady spending), so the backtest settings never reach it. That takes its
  // own simulation when they are on; it is run in the summary's (debounced)
  // effect below rather than on every render.
  const extrasOn = Object.keys(simExtras).length > 0;
  // The shown forecast's input, for the on-demand backtest (stable between renders).
  const shownInput = useMemo(() => (dataReady ? withLevers(dLevers, dSpendAdj) : null), [withLevers, dLevers, dSpendAdj, dataReady]);
  const histOn = !!sim.historical && !sim.historical.fallback;
  // Where the shown numbers come from, for the header, hero and table wording:
  // "N past starting years (first–last)" when replaying history, else the Monte Carlo runs.
  const histStarts = histOn ? sim.historical!.starts : [];
  const histSpanText = histStarts.length
    ? `${histStarts.length} past starting year${histStarts.length === 1 ? '' : 's'} (${histStarts[0].startYear}–${histStarts[histStarts.length - 1].startYear})`
    : '';
  // A non-steady spending rule trades running out for spending cuts, so the success
  // figure is labelled as such and shown with the cuts it took; the spending line
  // and column stay the plan (before the rule).
  const ruleOn = spendRule.kind !== 'fixed';
  const ruleCuts = useMemo(() => (ruleOn && sim.paths?.length ? summarizeCuts(sim.paths) : null), [ruleOn, sim.paths]);
  const spendLabel = ruleOn ? 'Planned spending' : 'Spending';

  // Modeled back-projection for the preceding years (empty when historyYears = 0).
  const backBands = useMemo(() => dataReady && historyYears > 0 ? backcastHistory(withLevers(dLevers, dSpendAdj), startAge) : [],
    [historyYears, startAge, withLevers, dLevers, dSpendAdj, dataReady]);
  // Full age series = past (back-projection) + future (Monte Carlo).
  const allBands = useMemo(() => [...backBands, ...sim.bands], [backBands, sim.bands]);

  const finalBand = sim.bands.length ? sim.bands[sim.bands.length - 1] : null;
  const futureNW = finalBand ? finalBand.p50 : currentNW;
  // 10th–90th percentile spread of the final-year simulated outcomes (an 80% range of outcomes, not a statistical confidence interval).
  const futureLo = finalBand ? finalBand.p10 : currentNW;
  const futureHi = finalBand ? finalBand.p10 + finalBand.band : currentNW;
  const deltaPct = currentNW ? ((futureNW - currentNW) / currentNW) * 100 : 0;
  // Follows the Retire lever, so the hero, markers and table match what's charted.
  const retireAge0 = dLevers.retireAge ?? earners[0]?.retireAge ?? 65;
  // Projected net worth ON REACHING the primary earner's retirement age. A band
  // labeled age X is the balance at the END of age X, so the balance at the start of
  // retirement is the band for retireAge0 − 1 (not retireAge0, which already includes
  // a full year of retirement draws). Today's net worth if retirement is now/past;
  // the final band if it lands beyond the plan horizon.
  const retireBand = bandOnReaching(sim.bands, currentAge0, retireAge0);
  // Years from today that the retirement figure is actually priced at (for the
  // today's-dollars deflator): the shown band's own age, never the nominal retireAge0.
  const retireYearsOut = retireBand ? balanceYearsOut(retireBand.age, currentAge0) : 0;
  const finalYearsOut = finalBand ? balanceYearsOut(finalBand.age, currentAge0) : 0;
  const retireNW = retireBand ? retireBand.p50 : currentNW;
  const retireLo = retireBand ? retireBand.p10 : currentNW;
  const retireHi = retireBand ? retireBand.p10 + retireBand.band : currentNW;

  // Merge the pinned baseline's median lines into the chart data (matched by age),
  // and compute the headline deltas the badge shows. No baseline → pass-through.
  const chartData = useMemo(() => {
    if (!baseline) return allBands;
    const byAge = new Map(baseline.bands.map(b => [b.age, b]));
    return allBands.map(b => {
      const base = byAge.get(b.age);
      return base ? { ...b, basep50: base.p50, baseInvP50: base.invP50 } : b;
    });
  }, [allBands, baseline]);
  // "Today's dollars" view: deflate a nominal value at `age` back to present
  // purchasing power. The identity when realDollars is off (factor = 1). Used for
  // both the chart series and the headline figures so they stay in sync.
  // Balances (net worth, investable, real-estate equity, baseline) are END-of-year
  // values: the band at age X is (X − currentAge0 + 1) years out. Income/spending are
  // the year's flows, priced at the start of the year, so they are one year less out.
  const deflYears = (v: number, yearsOut: number) => (realDollars ? deflateReal(v, yearsOut, infl) : v);
  const unitLabel = realDollars ? "in today's dollars" : 'in future dollars';
  // The chart renders this: the same band series, optionally deflated per-year,
  // plus the Cash Flow tab's gap fills. The gap is drawn as two stacks on a
  // transparent base of min(income, spending): `cfSave` on top where income is
  // higher, `cfDraw` where spending is.
  const displayData = useMemo(() => {
    const balanceKeys = ['p10', 'p50', 'band', 'invP10', 'invP50', 'invBand', 're', 'basep50', 'baseInvP50'] as const;
    const flowKeys = ['income', 'spending'] as const;
    return chartData.map(b => {
      const o: Record<string, number> = { ...b };
      if (realDollars) {
        for (const k of balanceKeys) if (typeof o[k] === 'number') o[k] = deflYears(o[k], balanceYearsOut(b.age, currentAge0));
        for (const k of flowKeys) if (typeof o[k] === 'number') o[k] = deflYears(o[k], flowYearsOut(b.age, currentAge0));
      }
      if (typeof o.income === 'number' && typeof o.spending === 'number') {
        o.cfBase = Math.min(o.income, o.spending);
        o.cfSave = Math.max(0, o.income - o.spending);
        o.cfDraw = Math.max(0, o.spending - o.income);
      }
      return o;
    });
  }, [chartData, realDollars, infl, currentAge0]); // eslint-disable-line react-hooks/exhaustive-deps

  // Compare now vs the pin at the SAME final age and deflate both sides with the same
  // factor, so the delta follows the Future $/Today's $ toggle like everything else.
  const baseDeltaNW = baseline && finalBand
    ? deflYears(futureNW, finalYearsOut) - deflYears(baselineMedianAt(baseline, finalBand.age), finalYearsOut)
    : null;
  const baseDeltaSucc = baseline ? sim.successPct - baseline.successPct : null;
  const pinnedWhen = baseline ? (() => {
    const d = new Date(baseline.at);
    return `${fmtDate(d, { year: d.getFullYear() !== new Date().getFullYear() })}, ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
  })() : '';
  const pinnedShort = baseline ? fmtDate(new Date(baseline.at), { year: new Date(baseline.at).getFullYear() !== new Date().getFullYear() }) : '';
  const pinBaseline = () => setBaseline(makePin(sim.bands, {
    futureNW, successPct: sim.successPct, startNW: currentNW, recordedNW: latest?.net_worth, at: Date.now(),
  }));
  // Pinning again replaces the plan "Are you on track?" follows, so a tracked pin asks first.
  const repinBaseline = () => {
    if (baseline && canTrack(baseline)
      && !confirm(`Replace the pin? It is also the plan “Are you on track?” follows, tracked since ${fmtDate(new Date(baseline.at))}. The new pin starts tracking from today.`)) return;
    pinBaseline();
  };
  // The pin is also the plan that Plan versus actual tracks, so clearing a pin
  // that is being tracked asks first.
  const clearBaseline = () => {
    if (baseline && canTrack(baseline)
      && !confirm(`Clear the pin? It is also the plan “Are you on track?” follows, tracked since ${fmtDate(new Date(baseline.at))}. Pinning again starts tracking from today.`)) return;
    setBaseline(null);
  };

  // Named scenarios (PlanAnswers): the page's full set of plan inputs, and loading one back.
  const currentScenario = useMemo<ScenarioSettings>(() => ({
    assumptions: A, earners, events, kidAges, collegeOn, gradOn, hsaLast, glidePath, spendingAdjust, levers,
    accountContribs, taxPlan, returnModel: backtestSettings, spendingRule: spendRule,
  }), [A, earners, events, kidAges, collegeOn, gradOn, hsaLast, glidePath, spendingAdjust, levers, accountContribs, taxPlan, backtestSettings, spendRule]);
  // Today's ages stay as they are on the page (a scenario holds the ages it was
  // saved with, which may be out of date); everything else comes from it.
  const loadScenario = useCallback((saved: ScenarioSettings) => {
    const s = withTodaysAges(saved, { currentAge: currentAge0, earners, kidAges });
    setA(s.assumptions); setEarners(s.earners); setEarnersEdited(true);
    setEvents(s.events as LifeEvent[]); setKidAges(s.kidAges);
    setCollegeOn(s.collegeOn); setGradOn(s.gradOn); setHsaLast(s.hsaLast); setGlidePath(s.glidePath);
    setSpendingAdjust(s.spendingAdjust); setLevers(s.levers); setAccountContribs(s.accountContribs);
    setTaxPlan(s.taxPlan); setBacktest(s.returnModel); setSpendRule(s.spendingRule);
  }, [currentAge0, earners, kidAges, setA, setEarners, setEarnersEdited, setEvents, setKidAges, setCollegeOn, setGradOn, setHsaLast, setGlidePath, setSpendingAdjust, setLevers, setAccountContribs, setTaxPlan, setBacktest, setSpendRule]);

  // Persist a compact summary of the (client-side) Monte Carlo so the AI assistant
  // can answer planning questions ("am I on track to retire?") with the actual
  // projected numbers — it can't run the simulation itself. Keyed for the assistant
  // to ship with each chat (see AiAssistant). Reflects the last Forecast render.
  // Skipped until the data it's derived from has loaded: before then currentNW is 0
  // and the summary would overwrite the last good one with a net worth of $0.
  // Describes the saved plan, never the unsaved what-if levers.
  const summaryReady = dataReady && !!hist && !!taxData && !!breakdown;
  useEffect(() => {
    if (!summaryReady) return;
    const write = () => {
      const summarySim = extrasOn
        ? runForecastSim({ ...planInput, returnModel: undefined, historicalStockShare: undefined, withdrawal: undefined })
        : planSim;
      const summaryFinal = summarySim.bands.length ? summarySim.bands[summarySim.bands.length - 1] : null;
      if (!summaryFinal) return;
      writePersistent('mon.fcSummary', {
        currentNetWorth: Math.round(currentNW),
        currentAge: currentAge0,
        planToAge: A.endAge,
        // Nominal throughout, with the same balances restated in today's purchasing
        // power (the page's default view) so the assistant can quote the figure the
        // user actually sees on screen.
        dollars: "future (nominal) dollars, except fields ending in TodaysDollars",
        medianNetWorthAtPlanEnd: Math.round(summaryFinal.p50),
        medianNetWorthAtPlanEndTodaysDollars: Math.round(deflateReal(summaryFinal.p50, balanceYearsOut(summaryFinal.age, currentAge0), infl)),
        range80pct: [Math.round(summaryFinal.p10), Math.round(summaryFinal.p10 + summaryFinal.band)],
        successProbabilityPct: summarySim.successPct,
        changeVsTodayPct: Math.round(currentNW ? ((summaryFinal.p50 - currentNW) / currentNW) * 100 : 0),
        // The path, not just the endpoint: every fifth birthday plus the first and
        // last year, so the assistant can speak to (and chart) when the balance
        // peaks, dips or runs low. Same nominal dollars as the figures above.
        trajectory: summarySim.bands
          .filter((b, i, all) => i === 0 || i === all.length - 1 || b.age % 5 === 0)
          .map(b => ({
            age: b.age, year: b.year,
            p10: Math.round(b.p10), median: Math.round(b.p50), p90: Math.round(b.p10 + b.band),
            medianTodaysDollars: Math.round(deflateReal(b.p50, balanceYearsOut(b.age, currentAge0), infl)),
            income: Math.round(b.income), spending: Math.round(b.spending),
          })),
        retirement: earners
          .map((e, i) => (i === 0 || e.enabled ? { earner: e.label, retireAge: e.retireAge } : null))
          .filter(Boolean),
        // Which tax model produced these figures (a setting, no amounts). In bracket
        // mode the flat effTaxRate / retireTaxRate in the assumptions are not used.
        taxModel: taxPlan.mode === 'brackets'
          ? 'federal tax worked out from the IRS brackets each year (the flat effTaxRate and retireTaxRate are not used)'
          : 'flat effective rates (effTaxRate while working, retireTaxRate in retirement)',
        ...(taxPlan.mode === 'brackets' ? { rothConversions: taxPlan.convOn } : {}),
        computedAt: new Date().toISOString(),
      });
    };
    // With the default model the page's own simulation is the summary's: write it
    // now. Otherwise wait for the edits to settle before running the extra one.
    if (!extrasOn) { write(); return; }
    const t = setTimeout(write, 800);
    return () => clearTimeout(t);
  }, [summaryReady, currentNW, currentAge0, A.endAge, planSim, planInput, extrasOn, earners, infl, taxPlan.mode, taxPlan.convOn]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- What-if levers -------------------------------------------------------
  const leverRetire = levers.retireAge ?? earners[0]?.retireAge ?? 65;
  const leverReturn = levers.investReturn ?? A.investReturn;
  const leversDirty = levers.retireAge != null || levers.investReturn != null || levers.extraSave > 0 || Math.abs(spendingAdjust - 1) > 1e-9;
  // Where "Save to plan" puts the extra saving: the first included taxable
  // account (else any included account). With no accounts there's nowhere to
  // put it, so that lever stays as a what-if.
  const saveTargetAcct = (() => {
    const accs = (taxData?.accounts ?? []).filter(acc => !excludedAccounts[acc.id]);
    return accs.find(acc => (bucketOverrides[acc.id] ?? acc.bucket) === 'taxable') ?? accs[0] ?? null;
  })();
  function resetLevers() { setLevers(NO_LEVERS); setSpendingAdjust(1); }
  // Commit every moved lever into the plan's own inputs, then clear the levers.
  function saveLevers() {
    if (levers.retireAge != null) updateEarner(0, { retireAge: levers.retireAge });
    if (levers.investReturn != null) setA(prev => ({ ...DEFAULT_ASSUMPTIONS, ...prev, investReturn: levers.investReturn as number }));
    if (Math.abs(spendingAdjust - 1) > 1e-9) {
      setA(prev => ({ ...DEFAULT_ASSUMPTIONS, ...prev, annualSpending: Math.round((prev.annualSpending ?? DEFAULT_ASSUMPTIONS.annualSpending) * spendingAdjust) }));
      setSpendingAdjust(1);
    }
    // Extra saving becomes an editable life event ("spend less until you retire",
    // as the lever models it) plus, where there's an account to name, a matching
    // contribution so the money lands there rather than in general savings.
    if (levers.extraSave > 0) {
      const retireAt = levers.retireAge ?? earners[0]?.retireAge ?? 65;
      const cut = Math.min(levers.extraSave, A.annualSpending * spendingAdjust);
      if (cut > 0 && retireAt > currentAge0) {
        setEvents(prev => [...prev, {
          id: 's' + Date.now(), label: 'Save more', icon: '💰', type: 'recurring',
          age: currentAge0, untilAge: retireAt - 1, amount: -Math.round(cut),
        }]);
        if (saveTargetAcct) {
          const id = saveTargetAcct.id;
          setAccountContribs(prev => ({ ...prev, [id]: (prev[id] || 0) + Math.round(cut) }));
        }
      }
    }
    setLevers(NO_LEVERS);
  }

  function updateEvent(id: string, patch: Partial<LifeEvent>) { setEvents(prev => prev.map(e => (e.id === id ? { ...e, ...patch } : e))); }
  function removeEvent(id: string) { setEvents(prev => prev.filter(e => e.id !== id)); }
  function updateEarner(idx: number, patch: Partial<Earner>) { setEarnersEdited(true); setEarners(prev => prev.map((e, i) => (i === idx ? { ...e, ...patch } : e))); }
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
    // The breakdown lives inside the "Spending" section — make sure both are open.
    if (!groupOpen('spending')) openGroup('spending');
    if (!showSpending) setShowSpending(true);
    if (projection && spendingRef.current) {
      returnDone.current = true;
      try { localStorage.removeItem('mon.forecastReturn'); } catch { /* ignore */ }
      // Next frame, not now: when the data is already cached this effect runs in
      // the page's first commit, and the app's own scroll-to-top on a tab change
      // (a parent effect, so it runs after this one) would undo the scroll.
      const el = spendingRef.current;
      requestAnimationFrame(() => el.scrollIntoView({ block: 'start' }));
    }
  }, [projection, dataReady, groups, showSpending]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Draggable event markers over the chart ---
  const wrapRef = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(920);
  const dragId = useRef<string | null>(null);
  // Active drag of the X-axis to pull the timeline into the past (replaces the old
  // History slider). pxPerYear is captured at drag start so the axis rescaling
  // mid-drag doesn't make the gesture jumpy.
  const axisDrag = useRef<{ startX: number; startYears: number; pxPerYear: number } | null>(null);
  const HISTORY_MAX = 30;
  useEffect(() => {
    const el = wrapRef.current; if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el); setW(el.clientWidth);
    return () => ro.disconnect();
  }, [dataReady]); // the chart column only mounts once the data has loaded
  const plotW = Math.max(1, w - PLOT_LEFT - PLOT_RIGHT);
  // Age↔pixel mapping spans the full plotted range [startAge, endAge] so event
  // chips and markers line up once the axis is extended into the past.
  const ageToX = (age: number) => PLOT_LEFT + ((age - startAge) / Math.max(1, A.endAge - startAge)) * plotW;
  const xToAge = (clientX: number) => {
    if (!wrapRef.current) return currentAge0;
    const x = clientX - wrapRef.current.getBoundingClientRect().left;
    const age = Math.round(startAge + ((x - PLOT_LEFT) / plotW) * (A.endAge - startAge));
    return Math.max(startAge, Math.min(A.endAge, age));
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
  }, [currentAge0, startAge, A.endAge, plotW]); // eslint-disable-line react-hooks/exhaustive-deps

  // Drag the X-axis horizontally to extend the timeline into the past (drag right)
  // or pull it back toward today (drag left) — the back-projection grows/shrinks.
  useEffect(() => {
    function move(e: PointerEvent) {
      const d = axisDrag.current; if (!d) return;
      const deltaYears = Math.round((e.clientX - d.startX) / d.pxPerYear);
      setHistoryYears(Math.max(0, Math.min(HISTORY_MAX, d.startYears + deltaYears)));
    }
    function up() { axisDrag.current = null; }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, [setHistoryYears]);

  function startAxisDrag(e: React.PointerEvent) {
    e.preventDefault();
    const span = Math.max(1, A.endAge - startAge);
    axisDrag.current = { startX: e.clientX, startYears: historyYears, pxPerYear: plotW / span };
  }

  // Click empty chart area to insert a new event at that age, then edit it.
  function addEventAt(clientX: number) {
    const age = xToAge(clientX);
    const id = 'e' + Date.now();
    setEvents(prev => [...prev, { id, label: 'Event', icon: EVENT_TYPE_META.oneTime.icon, type: 'oneTime', age, amount: 10000 }]);
    setEditingId(id);
  }
  // Quick-add a preset event a few years out, then open its editor to tune.
  function addPreset(p: typeof EVENT_PRESETS[number]) {
    const id = 'e' + Date.now();
    const age = Math.min(A.endAge, currentAge0 + 5);
    setEvents(prev => [...prev, { id, label: p.label, icon: p.icon, type: p.type, age, amount: p.amount, isSale: p.isSale }]);
    setAddMenuOpen(false);
    setEditingId(id);
  }
  const editingEvent = events.find(e => e.id === editingId) ?? null;

  // Retirement and Social Security reference ages (for labelled chart markers),
  // on earner 0's age axis. Earner 0's retirement follows the Retire lever.
  const twoEarners = !!earners[1]?.enabled;
  const ageOnAxis = (e: Earner, i: number, age: number) => (i === 0 ? age : currentAge0 + (age - e.currentAge));
  const retireMarks = earners.flatMap((e, i) => (i === 0 || e.enabled
    ? [{ age: ageOnAxis(e, i, i === 0 ? retireAge0 : e.retireAge), label: twoEarners ? retiresLabel(e.label || (i ? 'Partner' : 'You')) : 'Retire', section: i === 0 ? 'you' : 'partner' }]
    : []));
  const ssMarks = earners.flatMap((e, i) => ((i === 0 || e.enabled) && e.ssEnabled
    ? [{ age: ageOnAxis(e, i, e.ssClaimAge), label: twoEarners ? `${e.label || (i ? 'Partner' : 'You')}: Social Security` : 'Social Security starts' }]
    : []));
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
  // alongside the current kids under Family.
  const futureKids = events.filter(e => e.type === 'kid');

  // The plan's own milestones for the pin lane under the chart (life events are
  // pinned there too). Two earners retiring at the same age read as one line.
  const laneMarks: LaneMark[] = [
    ...(() => {
      const byAge = new Map<number, typeof retireMarks>();
      for (const m of retireMarks) byAge.set(m.age, [...(byAge.get(m.age) ?? []), m]);
      return [...byAge.values()].map(ms => ms.length > 1
        ? { key: 'r' + ms[0].age, age: ms[0].age, icon: '🏖️', label: ms.length === 2 ? 'You both retire' : 'Everyone retires', tone: 'var(--amber)', section: 'you' }
        : { key: 'r' + ms[0].age + ms[0].section, age: ms[0].age, icon: '🏖️', label: ms[0].label, tone: 'var(--amber)', section: ms[0].section });
    })(),
    ...(() => {
      // Both claiming at one age: one line.
      const byAge = new Map<number, number>();
      for (const m of ssMarks) byAge.set(m.age, (byAge.get(m.age) ?? 0) + 1);
      return [...byAge.entries()].map(([age, n]) => ({
        key: 's' + age, age, icon: '🏛️', tone: 'var(--muted)', section: 'ss',
        label: n > 1 || ssMarks.length === 1 ? 'Social Security starts' : (ssMarks.find(m => m.age === age)?.label ?? 'Social Security starts'),
      }));
    })(),
    ...(payoffAge != null && payoffAge > currentAge0 ? [{ key: 'payoff', age: payoffAge, icon: '🔑', label: 'Mortgage paid off', tone: 'var(--teal)', section: 'home' }] : []),
    ...[...new Set(collegeMarks)].map(age => {
      const n = collegeMarks.filter(a => a === age).length;
      return { key: 'c' + age, age, icon: '🎓', label: n > 1 ? `${n} kids start college` : 'A kid starts college', plural: 'Kids start college', tone: 'var(--accent-2)', section: 'family' };
    }),
  ];
  // Open an input section and bring it into view (from a milestone pin).
  const showSection = (k: string) => { openGroup(k); setScrollTo(k); };

  // One label + field row in the input groups (same height everywhere).
  const rowStyle: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '4px 0', minHeight: 38 };
  const numRow = (label: string, key: keyof Assumptions, step: number, mul: number, prefix?: string, suffix?: string) => {
    const impKey = `assumptions.${key}`;
    return (
    <div key={key} style={rowStyle}>
      <span style={{ fontSize: 13, color: 'var(--muted)' }}>{label}</span>
      <NumberInput value={A[key] as number} mul={mul} step={step} width={104} prefix={prefix} suffix={suffix} imported={!!importedSet[impKey]}
        onCommit={n => { setA(prev => ({ ...DEFAULT_ASSUMPTIONS, ...prev, [key]: n })); clearImported(impKey); }} />
    </div>
  );};

  const card: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 20 };
  // Sub-section heading used inside the controls groups (Earners, Kids, Taxes, …).
  const subHead: React.CSSProperties = { fontSize: 12, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5 };

  // "What your plan supports": one solve shared by the headline tiles and its card.
  const answers = usePlanAnswers(shownInput);
  // A section opened from a milestone pin scrolls into view once it has rendered open.
  useEffect(() => {
    if (!scrollTo) return;
    const el = document.getElementById('fc-group-' + scrollTo);
    if (el) {
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    }
    setScrollTo(null);
  }, [scrollTo, groups]);

  // Loading / error / empty states: never simulate (or show "$0") without real data.
  if (!dataReady) {
    const noHistory = !histError && !histLoading && hist != null && hist.length === 0;
    return (
      <div className="page" style={{ maxWidth: 1280, margin: '0 auto', padding: '32px 24px' }}>
        <TopNav view="forecast" onNavigate={onNavigate} privacy={privacy} onTogglePrivacy={onTogglePrivacy} />
        <h1 style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.5px', marginBottom: 16 }}>Forecast</h1>
        <div style={{ ...card, textAlign: 'center', padding: '48px 20px' }} role={histError ? 'alert' : 'status'}>
          {histError ? (<>
            <p style={{ fontSize: 15, fontWeight: 600, color: 'var(--red)', marginBottom: 6 }}>Couldn’t load your net-worth history</p>
            <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 14 }}>The forecast starts from your latest tracked net worth ({histError}). Check that the server is running, then try again.</p>
            <button className="btn-ghost btn-sm" onClick={() => refetchHist()}>Retry</button>
          </>) : noHistory ? (<>
            <p style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>No net-worth history yet</p>
            <p style={{ fontSize: 13, color: 'var(--muted)' }}>Connect accounts on the Dashboard — the forecast projects forward from your latest tracked net worth.</p>
          </>) : (
            <p style={{ fontSize: 14, color: 'var(--muted)' }}>Loading your net worth…</p>
          )}
        </div>
      </div>
    );
  }

  // Derived figures for the grouped controls and the chart labels.
  const placeholders = !earnersEdited && earners[0]?.currentAge === DEFAULT_EARNERS[0].currentAge;
  const anySellable = !!realEstate?.properties.some(p => p.sellable);
  // A "failing" plan can still own a valuable home whose equity isn't counted.
  const homeEquityIdle = sim.successPct < 100 && effBaseRE > 0 && !anySellable;
  const totalBal = pools0.taxable + pools0.pretax + pools0.roth + pools0.hsa + pools0.college;
  const totalContribAnnual = contribByBucket.taxable + contribByBucket.pretax + contribByBucket.roth + contribByBucket.hsa + contribByBucket.college;
  const hasAccounts = !!taxData && taxData.accounts.length > 0;
  const hasProjection = !!projection && projection.monthsAnalyzed > 0;
  const pctTxt = (v: number) => `${Math.round(v * 1000) / 10}%`;
  // What-if: one sentence for the combined effect of every moved slider, against
  // the plan's own chance and value at retirement (same dollar basis as the tiles).
  const planRetireAge = earners[0]?.retireAge ?? 65;
  const planRetireBand = bandOnReaching(planSim.bands, currentAge0, planRetireAge);
  const planRetireValue = planRetireBand ? deflYears(planRetireBand.p50, balanceYearsOut(planRetireBand.age, currentAge0)) : currentNW;
  const whatIfText = anyLever ? whatIfSentence({
    changes: leverPhrases({
      retire: retireLeverOn ? { plan: planRetireAge, now: retireAge0 } : null,
      spend: spendLeverOn ? { pct: Math.round((dSpendAdj - 1) * 100), amount: A.annualSpending * dSpendAdj } : null,
      extraSave: saveLeverOn ? dLevers.extraSave : 0,
      ret: returnLeverOn ? { plan: A.investReturn, now: dLevers.investReturn as number } : null,
    }, n => (privacy ? '••••••' : fmtMoney(n))),
    chance: { plan: planSim.successPct, now: sim.successPct },
    retire: { planAge: planRetireAge, planValue: planRetireValue, nowAge: retireAge0, nowValue: deflYears(retireNW, retireYearsOut) },
    money: n => (privacy ? '•••' : fmtMoneyShort(n)),
  }) : null;
  // The first year's spending as the forecast spends it: everyday living plus
  // housing, from the plan's own simulation (so it matches the table's first row).
  const firstBand = planSim.bands[0];
  const firstHousing = firstBand?.housing ?? 0;
  const firstLiving = firstBand ? (firstBand.living ?? firstBand.spending - firstHousing) : A.annualSpending;
  // Life events and college in that first year: neither living nor housing. A
  // "Save more" event is negative here, since it lowers what the year spends.
  const firstOther = firstBand ? firstBand.spending - firstHousing - firstLiving : 0;
  // Y-axis cap for the balance charts: the band's top can run several times past
  // the median by 90; stop the axis near the median's highest point and note how
  // far the range really reaches (see capYAxis).
  const yCap = (() => {
    if (tab === 'Cash Flow' || !displayData.length) return null;
    const nw = tab === 'Net Worth';
    let medMax = -Infinity, top = -Infinity, topAge = 0, lo = Infinity;
    for (const r of displayData) {
      const med = nw ? r.p50 : r.invP50, base = nw ? r.basep50 : r.baseInvP50;
      const p10 = nw ? r.p10 : r.invP10, band = nw ? r.band : r.invBand;
      if (typeof med === 'number') medMax = Math.max(medMax, med);
      if (typeof base === 'number') medMax = Math.max(medMax, base);
      if (typeof p10 === 'number') {
        lo = Math.min(lo, p10);
        const hi = p10 + (typeof band === 'number' ? band : 0);
        if (hi > top) { top = hi; topAge = r.age; }
      }
    }
    const cap = capYAxis({ medianMax: medMax, rangeMax: top, min: Number.isFinite(lo) ? lo : 0 });
    return cap ? { ...cap, top, topAge } : null;
  })();
  const leverRetireMin = Math.min(leverRetire, Math.max(currentAge0 + 1, 45));
  const leverRetireMax = Math.max(80, leverRetire, leverRetireMin + 1);
  const leverSpendPct = Math.round((spendingAdjust - 1) * 100);
  const pill = (color: string, bg: string): React.CSSProperties => ({ fontSize: 11, fontWeight: 700, borderRadius: 999, padding: '2px 8px', color, background: bg, whiteSpace: 'nowrap' });
  const menuBox: React.CSSProperties = { position: 'absolute', top: '100%', right: 0, marginTop: 4, zIndex: 50,
    background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8,
    boxShadow: '0 8px 24px rgba(0,0,0,0.5)', padding: 4, minWidth: 190 };
  const menuItem: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
    background: 'transparent', border: 'none', color: 'var(--text)', fontSize: 12.5, padding: '7px 8px', borderRadius: 6, cursor: 'pointer' };
  const hoverBg = {
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => { e.currentTarget.style.background = 'var(--bg)'; },
    onMouseLeave: (e: React.MouseEvent<HTMLElement>) => { e.currentTarget.style.background = 'transparent'; },
  };
  // Jump bar: scroll to a card (below the sticky bar via .fc-anchor's
  // scroll-margin) and move focus there, so keyboard users land on it too.
  const JUMPS: [string, string][] = [
    ['fc-plan', 'Plan'], ['fc-answers', 'What it supports'], ['fc-inputs', 'Inputs'], ['fc-track', 'On track'],
    ['fc-scenarios', 'Scenarios'], ['fc-taxes', 'Taxes'], ['fc-past', 'Past markets'], ['fc-table', 'Year by year'],
  ];
  const jumpTo = (e: React.MouseEvent<HTMLAnchorElement>, id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    e.preventDefault();
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    // A folded card would land you on a closed header; open it first, and scroll
    // once it has rendered: scrolling at once measured the folded page, so a
    // card near the bottom stopped well short of the top.
    const closed = el.querySelector<HTMLButtonElement>('button.fc-head-btn[aria-expanded="false"]');
    const go = () => { el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' }); el.focus({ preventScroll: true }); };
    if (closed) { closed.click(); window.setTimeout(go, 80); } else go();
  };
  // Pairs of analysis cards sit side by side on wide screens, unless one needs
  // the width: the scenario comparison table, or the open conversions chart.
  const taxWide = taxPictureOpen && taxPlan.mode === 'brackets' && taxPlan.convOn;
  const anchor = (cls = '') => ({ className: `fc-anchor ${cls}`.trim(), tabIndex: -1, style: { outline: 'none', minWidth: 0 } as React.CSSProperties });

  // One earner's pay and retirement fields (the You and Partner sections).
  const earnerFields = (idx: number) => {
    const e = earners[idx];
    if (!e) return null;
    return (<>
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
        <div key={key} style={rowStyle}>
          <span style={{ fontSize: 13, color: 'var(--muted)' }}>{label}</span>
          <NumberInput value={e[key] as number} prefix={pre || undefined} imported={!!importedSet[impKey]}
            onCommit={n => {
              // An age outside 0–110 or a negative income broke the chart
              // (axis from age −3, "at retirement · 65" for a 150-year-old).
              const v = key === 'currentAge' ? Math.min(110, Math.max(0, Math.round(n))) : Math.max(0, n);
              updateEarner(idx, { [key]: v } as Partial<Earner>); clearImported(impKey);
            }} />
        </div>
      );})}
      {/* Annual raise: the income's own growth rate, independent of inflation. */}
      <div style={rowStyle}>
        <span style={{ fontSize: 13, color: 'var(--muted)' }} title="Your income's own annual growth, compounded each working year. Independent of inflation — set 0% for a field with no cost-of-living raises.">
          Annual raise / yr
        </span>
        <NumberInput value={e.raisePct ?? 0.02} mul={100} step={0.5} suffix="%" required={false}
          onCommit={n => updateEarner(idx, { raisePct: n })} />
      </div>
      {/* Employer match: free money into pre-tax, on top of the per-account
          contributions below (which are employee dollars only). */}
      <div style={rowStyle}>
        <span style={{ fontSize: 13, color: 'var(--muted)' }} title="Employer 401(k)/403(b) match or profit-sharing. Added straight to your pre-tax pool on top of your own contributions — it isn't part of your cash income and isn't your tax deduction. Grows with your raise and stops when you retire.">
          Employer match / yr
        </span>
        <NumberInput value={e.employerMatch ?? 0} prefix="$" required={false}
          onCommit={n => updateEarner(idx, { employerMatch: n })} />
      </div>
      <div style={rowStyle}>
        <span style={{ fontSize: 13, color: 'var(--muted)' }}>Retire at age</span>
        <NumberInput value={e.retireAge} onCommit={n => updateEarner(idx, { retireAge: n })} />
      </div>
    </>);
  };
  // One earner's Social Security: on/off, claim age, benefit and the estimate helper.
  const ssFields = (idx: number) => {
    const e = earners[idx];
    if (!e) return null;
    const ssOpt = ssOptimal(e.income, A.endAge);
    return (<>
      <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, color: 'var(--muted)', cursor: 'pointer', padding: '2px 0' }}>
        <span>🏛️ {twoEarners ? `${e.label?.trim() || (idx ? 'Partner' : 'You')}: Social Security` : 'Include Social Security'}</span>
        <input type="checkbox" checked={e.ssEnabled} onChange={ev => updateEarner(idx, { ssEnabled: ev.target.checked })} style={{ width: 'auto' }} />
      </label>
      {e.ssEnabled && (
        <>
          <div style={rowStyle}>
            <span style={{ fontSize: 13, color: 'var(--muted)' }}>Claim at age</span>
            <NumberInput value={e.ssClaimAge} onCommit={n => updateEarner(idx, { ssClaimAge: n })} />
          </div>
          <div style={rowStyle}>
            <span style={{ fontSize: 13, color: 'var(--muted)' }}>Benefit / yr</span>
            <NumberInput value={e.ssAnnual} prefix="$" required={false} onCommit={n => updateEarner(idx, { ssAnnual: n })} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginTop: 2 }}>
            <span style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.3 }}
              title={`Estimated from this income. Claiming earlier pays less per year but for more years; delaying pays more per year. Claiming at ${ssOpt.best} collects the most total Social Security if you live to ${A.endAge}${ssOpt.hi > ssOpt.lo ? ` — though ages ${ssOpt.lo}–${ssOpt.hi} come within ~2% of it` : ''}. “Apply estimate” sets your claim age and benefit (today's $).`}>
              Best to claim at <strong>{ssOpt.best}</strong> if you live to {A.endAge} → ~{money(ssOpt.annual)}/yr{ssOpt.hi > ssOpt.lo ? ` (${ssOpt.lo}–${ssOpt.hi} ≈ equal)` : ''}
            </span>
            <button className="btn-ghost btn-sm" style={{ whiteSpace: 'nowrap' }}
              title={`Set claim age to ${ssOpt.best} and benefit to ${money(ssOpt.annual)}/yr (today's $)`}
              onClick={() => updateEarner(idx, { ssClaimAge: ssOpt.best, ssAnnual: ssOpt.annual })}>Apply estimate</button>
          </div>
        </>
      )}
    </>);
  };
  const allGroupsOpen = GROUP_KEYS.every(k => groupOpen(k) || (k === 'partner' && !twoEarners) || (k === 'home' && !(breakdown && breakdown.properties.length > 0)));

  return (
    <div className="page fc-page" style={{ maxWidth: 1280, margin: '0 auto', padding: '32px 24px' }}>
      <TopNav view="forecast" onNavigate={onNavigate} privacy={privacy} onTogglePrivacy={onTogglePrivacy} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <h1 style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.5px' }}>Forecast</h1>
        <InfoTip width={320} text={
          'How this forecast works. Your starting point is your latest tracked net worth — investable accounts (sorted into tax buckets: taxable, pre-tax, Roth, HSA, 529) plus real-estate equity. Income and spending are seeded from your budget history; document imports (e.g. a tax return) can fill income, filing status, dependents, and your effective tax rate. Real estate is modeled explicitly: each home appreciates while its mortgage amortizes, and its housing cost (mortgage P&I until payoff, plus property tax/insurance/HOA, each growing at its own rate) is charged every year. It then runs a Monte Carlo simulation — hundreds of randomized market paths — and charts the median outcome and its range, shown in today’s or future dollars.'
          + (histOn ? ' Right now it replays past US markets instead: one path per past starting year, with that stretch’s actual returns and inflation.' : '')
        } />
        <span style={{ color: 'var(--muted)', fontSize: 13 }}>{histOn ? histSpanText : `${RUNS} simulated market paths`} · drag the pins under the chart to move life events, click to edit</span>
        {/* Reset is destructive, so it lives in a menu rather than beside the title. */}
        <div ref={moreRef} style={{ position: 'relative', marginLeft: 'auto' }}>
          <button type="button" className="btn-ghost btn-sm" aria-label="More actions" aria-haspopup="menu" aria-expanded={moreOpen}
            onClick={() => setMoreOpen(o => !o)} style={{ fontSize: 16, lineHeight: 1, padding: '0 10px', minHeight: 32 }}>⋯</button>
          {moreOpen && (
            <div role="menu" style={menuBox}>
              <button type="button" role="menuitem" onClick={resetAll} style={menuItem} {...hoverBg}
                title="Restore default assumptions, earners, and life events (account contributions and exclusions are kept)">↺ Reset to defaults</button>
            </div>
          )}
        </div>
      </div>

      <nav className="fc-jump" aria-label="Forecast sections">
        <div className="fc-jump-row">
          {JUMPS.map(([id, label]) => <a key={id} href={`#${id}`} className="fc-jump-link" onClick={e => jumpTo(e, id)}>{label}</a>)}
        </div>
      </nav>

      {Object.keys(importedSet).length > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16,
          padding: '8px 12px', borderRadius: 10,
          background: 'var(--imported-dim)', border: '1px solid var(--imported)',
          fontSize: 12.5, color: 'var(--text)',
        }}>
          <span style={{ color: 'var(--imported)', fontSize: 13 }}>●</span>
          <span>Highlighted fields were imported from a document. Edit any field to clear its highlight.</span>
          <button className="btn-ghost btn-sm" style={{ marginLeft: 'auto' }}
            onClick={() => setImported({})} title="Clear all import highlights">Clear highlights</button>
        </div>
      )}

      {/* Headline row: the answers first — will the money last, what it is worth at
          retirement, what the plan supports, and today's starting point — before
          any chart or input. */}
      <section className="fc-kpis" aria-label="Forecast at a glance">
        <HeadTile hero label={`${histOn ? `Past starts that lasted to ${A.endAge}` : `Chance money lasts to ${A.endAge}`}${ruleOn ? ' (spending flexes)' : ''}`}
          value={`${sim.successPct}%`} color={successColor(sim.successPct)}
          tag={<span style={pill(successColor(sim.successPct), successTint(sim.successPct))}>{successStatus(sim.successPct)}</span>}
          sub={ruleCuts && ruleCuts.anyCut > 0 ? `typical spending cut ${Math.round(ruleCuts.median * 100)}% · hardest tenth ${Math.round(ruleCuts.worstTenth * 100)}%` : `of ${histOn ? histSpanText : `${RUNS} simulated futures`}`}
          detail={<p style={{ margin: 0 }}>{histOn
            ? `Share of the ${histSpanText} where your money never ran out before age ${A.endAge}, replaying actual returns and inflation.`
            : `Share of ${RUNS} simulated futures where your money never runs out before age ${A.endAge}.`} Real-estate equity isn’t counted unless you mark a property “Sell” under Home.{ruleOn
            ? ` With the “${RULE_LABELS[spendRule.kind]}” spending rule, everyday spending is cut instead of running out, so a high figure here can still mean deep cuts${ruleCuts ? `: ${Math.round(ruleCuts.median * 100)}% at most in a typical ${histOn ? 'starting year' : 'future'}, ${Math.round(ruleCuts.worstTenth * 100)}% in the hardest tenth` : ''}.`
            : ' Higher is safer — aim for 90%+.'}</p>} />
        <HeadTile label={`At retirement · age ${retireAge0}`} value={money(deflYears(retireNW, retireYearsOut))}
          sub={`likely ${moneyM(deflYears(retireLo, retireYearsOut))} – ${moneyM(deflYears(retireHi, retireYearsOut))}`} detail={(() => {
          const yrs = retireAge0 - currentAge0;
          const dRet = deflYears(retireNW, retireYearsOut), dDelta = currentNW ? ((dRet - currentNW) / currentNW) * 100 : 0;
          return (
          <>
            <p style={{ margin: 0 }}>Projected median net worth when {earners[0]?.label || 'you'} retire{yrs > 0 ? `, in ${yrs} year${yrs === 1 ? '' : 's'}` : ' (already reached)'} — {unitLabel}. “Likely” is the 10th–90th percentile range: 1 in 10 {histOn ? 'past starting years ends' : 'futures ends'} below it, 1 in 10 above.</p>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
              <span>vs. today</span>
              <span style={{ fontWeight: 600, color: dDelta >= 0 ? 'var(--green)' : 'var(--red)' }}>{money(dRet - currentNW, { sign: true })} ({dDelta >= 0 ? '+' : ''}{Math.round(dDelta)}%)</span>
            </div>
          </>
          );
        })()} />
        <AnswerHeadTiles answers={answers} money={n => money(n)} endAge={A.endAge} earnerLabel={i => earners[i]?.label} />
        <HeadTile label="Today" value={money(currentNW)} sub={latest ? `as of ${fmtDate(latest.date)}` : undefined} detail={
          <>
            <p style={{ margin: 0 }}>Your latest tracked total — investable accounts plus real-estate equity (home value minus mortgage).</p>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
              <span>Investable accounts</span><span style={{ fontWeight: 600, color: 'var(--text)' }}>{money(effBaseAccounts)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
              <span>Real-estate equity</span><span style={{ fontWeight: 600, color: 'var(--text)' }}>{money(effBaseRE)}</span>
            </div>
            {(excludedAcctBal > 0 || (effBaseRE !== baseRE)) && (
              <p style={{ margin: '8px 0 0', fontSize: 12, opacity: 0.8 }}>Excludes assets you've switched off.</p>
            )}
          </>
        } />
      </section>
      <p className="fc-kpi-line">
        Median path: <strong>{moneyM(currentNW)} today → {moneyM(deflYears(futureNW, finalYearsOut))} at {A.endAge}</strong>, {unitLabel}.
        {sim.successPct < 90 && ' Try retiring later or spending less with the What-if sliders.'}
        {anyLever && <span style={{ color: 'var(--accent)' }}> Includes your what-if changes.</span>}
      </p>

      {/* Two-column split: the chart column pins (sticky) on wide screens while the
          grouped controls scroll alongside it; stacks to one column when narrow. */}
      <div className="forecast-split">
      <div id="fc-plan" {...anchor('forecast-chart-col')}>
      <div ref={stickyRef} className={'fc-sticky' + (stickyFits ? ' fits' : '')} style={card}>
        {/* Toolbar: chart tabs, then dollar basis, baseline and add-event in one row. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          <div className="seg" role="group" aria-label="Chart">
            {TABS.map(t => <button key={t} type="button" aria-pressed={tab === t} onClick={() => setTab(t)} className={'seg-btn' + (tab === t ? ' active' : '')}>{TAB_LABEL[t]}</button>)}
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginLeft: 'auto', flexWrap: 'wrap' }}>
            <div className="seg" role="group" aria-label="Dollar basis">
              <button type="button" className={'seg-btn' + (realDollars ? ' active' : '')} aria-pressed={realDollars}
                title="Inflation-adjusted: every amount in today’s purchasing power" onClick={() => setRealDollars(true)}>Today’s $</button>
              <button type="button" className={'seg-btn' + (!realDollars ? ' active' : '')} aria-pressed={!realDollars}
                title="Nominal dollars of each future year (not adjusted for inflation)" onClick={() => setRealDollars(false)}>Future $</button>
            </div>
            {/* Baseline: pin the projection (a comparison line and the plan that
                Plan versus actual tracks), pin again, or clear it. */}
            <BaselineMenu pinned={!!baseline} pinnedShort={pinnedShort} pinnedWhen={pinnedWhen}
              deltas={baseline && ((baseDeltaNW != null && Math.round(baseDeltaNW) !== 0) || (baseDeltaSucc != null && baseDeltaSucc !== 0)) ? (<>
                {baseDeltaNW != null && Math.round(baseDeltaNW) !== 0 && (
                  <div style={{ color: baseDeltaNW >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
                    {baseDeltaNW >= 0 ? '▲' : '▼'} {money(Math.abs(baseDeltaNW))} median net worth at {A.endAge} <span style={{ fontWeight: 400, color: 'var(--muted)' }}>({unitLabel})</span>
                  </div>
                )}
                {baseDeltaSucc != null && baseDeltaSucc !== 0 && (
                  <div style={{ color: baseDeltaSucc >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
                    {baseDeltaSucc > 0 ? '+' : '−'}{Math.abs(baseDeltaSucc)} pts chance of success
                  </div>
                )}
              </>) : null}
              onPin={pinBaseline} onRepin={repinBaseline} onClear={clearBaseline} />
            {addMode ? (
              <button className="btn-primary btn-sm" onClick={() => setAddMode(false)}
                title="Then click the chart at the age where the event happens">✕ Cancel placing</button>
            ) : (
              <div ref={addMenuRef} style={{ position: 'relative' }}>
                <button type="button" className={(addMenuOpen ? 'btn-primary' : 'btn-ghost') + ' btn-sm'} aria-haspopup="menu" aria-expanded={addMenuOpen}
                  onClick={() => setAddMenuOpen(o => !o)} title="Add a common life event, or place a custom one on the chart">
                  ＋ Event ▾
                </button>
                {addMenuOpen && (
                  // On a phone the toolbar wraps this button to the left edge, where a
                  // right-anchored menu opened half off-screen (.fc-event-menu flips it).
                  <div role="menu" className="fc-event-menu" style={{ ...menuBox, right: undefined }}>
                    {EVENT_PRESETS.map(p => (
                      <button key={p.label} type="button" role="menuitem" onClick={() => addPreset(p)} style={menuItem} {...hoverBg}>
                        <span style={{ fontSize: 14 }}>{p.icon}</span>{p.label}
                      </button>
                    ))}
                    <div style={{ borderTop: '1px solid var(--border)', margin: '4px 0' }} />
                    <button type="button" role="menuitem" onClick={() => { setAddMenuOpen(false); setAddMode(true); }} style={{ ...menuItem, color: 'var(--muted)' }} {...hoverBg}>
                      <span style={{ fontSize: 14 }}>📍</span>Custom — place on chart
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        <div ref={wrapRef} style={{ position: 'relative' }}>
          <div style={{ position: 'relative' }}>
            <div onClick={e => { if (addMode) { addEventAt(e.clientX); setAddMode(false); } }}
              title={addMode ? 'Click to place the event at this age' : undefined}
              style={{ width: '100%', height: 330, filter: privacy ? 'blur(7px)' : 'none', cursor: addMode ? 'crosshair' : 'default' }}>
              <ResponsiveContainer>
                <ComposedChart data={displayData} margin={{ top: 14, right: PLOT_RIGHT, left: 8, bottom: 0 }}>
                <defs>
                  <linearGradient id="gBand" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.18} />
                    <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.04} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                {/* Age only — the year is still shown in the tooltip; a second axis
                    line per tick cluttered the axis. */}
                <XAxis dataKey="age" tickLine={false} axisLine={false} height={22}
                  tick={({ x, y, payload }: { x: number; y: number; payload: { value: number } }) => (
                    <g transform={`translate(${x},${y})`}>
                      <text x={0} y={0} dy={12} textAnchor="middle" fill="var(--muted)" fontSize={11}>{payload.value}</text>
                    </g>
                  )} />
                <YAxis tick={{ fill: 'var(--muted)', fontSize: 11 }} tickLine={false} axisLine={false} width={52}
                  tickFormatter={yCap && yCap.ticks.length > 1 ? (v: number) => (privacy ? '•••' : fmtAxisMoney(v, yCap.ticks[1] - yCap.ticks[0])) : moneyM}
                  {...(yCap ? { domain: yCap.domain, ticks: yCap.ticks, allowDataOverflow: true } : {})} />
                <Tooltip content={p => (
                  <ForecastTooltip active={p.active} payload={p.payload} tab={tab} yearNow={yearNow} currentAge0={currentAge0}
                    money={money} unit={realDollars ? "today's dollars" : 'future dollars'} spendLabel={spendLabel} />
                )} />
                {/* Retirement years, lightly shaded from the primary earner's retirement. */}
                {retireAge0 < A.endAge && retireAge0 >= startAge && (
                  <ReferenceArea x1={retireAge0} x2={A.endAge} fill="var(--amber)" fillOpacity={0.03} stroke="none" />
                )}
                {/* Faint guides from each milestone pin up through the plot (the
                    labels live in the pin lane and its key, below the chart). */}
                {events.flatMap(e => eventOccurrences(e, A.endAge).map((a, j) =>
                  <ReferenceLine key={e.id + '@' + j} x={a} stroke="var(--border)" strokeDasharray="2 4" />))}
                {retireMarks.map((m, i) => <ReferenceLine key={'r' + i} x={m.age} stroke="var(--amber)" strokeOpacity={0.7} strokeWidth={1.5} />)}
                {ssMarks.map((m, i) => <ReferenceLine key={'s' + i} x={m.age} stroke="var(--muted)" strokeDasharray="2 3" />)}
                {collegeMarks.map((age, i) => <ReferenceLine key={'c' + i} x={age} stroke="var(--accent-2)" strokeDasharray="2 4" />)}
                {/* "Today" divider between the modeled past and the Monte Carlo future. */}
                {historyYears > 0 && <ReferenceLine x={currentAge0} stroke="var(--muted)" strokeWidth={1.5}
                  label={{ value: 'Today', position: 'insideTopRight', fontSize: 10, fill: 'var(--muted)' }} />}
                {/* Mortgage payoff — housing outflow drops here. */}
                {payoffAge != null && payoffAge <= A.endAge && <ReferenceLine x={payoffAge} stroke="var(--teal)" strokeDasharray="3 3" />}
                {tab === 'Net Worth' && <>
                  <Area dataKey="p10" stackId="nw" stroke="none" fill="transparent" name=" " legendType="none" />
                  <Area dataKey="band" stackId="nw" stroke="none" fill="url(#gBand)" name="Likely range (10th–90th pct)" />
                  <Line dataKey="p50" name="Median net worth" stroke="var(--accent)" strokeWidth={2.5} dot={false} />
                  {baseline && <Line dataKey="basep50" name="Baseline" stroke="var(--muted)" strokeWidth={1.6} strokeDasharray="5 4" dot={false} />}
                </>}
                {/* Cash flow: the gap between the lines is shaded — blue where income
                    covers spending (saving), orange where savings fill the gap. */}
                {tab === 'Cash Flow' && <>
                  <Area dataKey="cfBase" stackId="cfs" stroke="none" fill="transparent" name=" " legendType="none" isAnimationActive={false} />
                  <Area dataKey="cfSave" stackId="cfs" stroke="none" fill={CF_INCOME} fillOpacity={0.22} name="Saving" isAnimationActive={false} />
                  <Area dataKey="cfBase" stackId="cfd" stroke="none" fill="transparent" name="  " legendType="none" isAnimationActive={false} />
                  <Area dataKey="cfDraw" stackId="cfd" stroke="none" fill={CF_SPEND} fillOpacity={0.3} name="Drawing from savings" isAnimationActive={false} />
                  <Line dataKey="income" name="Income + SS" stroke={CF_INCOME} strokeWidth={2} dot={false} />
                  <Line dataKey="spending" name={spendLabel} stroke={CF_SPEND} strokeWidth={2} dot={false} />
                </>}
                {tab === 'Investable assets' && <>
                  <Area dataKey="invP10" stackId="iv" stroke="none" fill="transparent" name=" " legendType="none" />
                  <Area dataKey="invBand" stackId="iv" stroke="none" fill="url(#gBand)" name="Likely range (10th–90th pct)" />
                  <Line dataKey="invP50" name="Median investable assets" stroke="var(--amber)" strokeWidth={2.5} dot={false} />
                  {baseline && <Line dataKey="baseInvP50" name="Baseline" stroke="var(--muted)" strokeWidth={1.6} strokeDasharray="5 4" dot={false} />}
                  <ReferenceLine y={0} stroke="var(--red)" strokeWidth={1.5} />
                </>}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            {/* With the axis capped, where the top of the likely range really goes. */}
            {yCap && (
              <span className="fc-cap-note" style={{ right: PLOT_RIGHT + 4 }}>
                <span aria-hidden="true">↑ </span>top of range reaches {moneyM(yCap.top)} at {yCap.topAge}
              </span>
            )}
            {/* Drag the age axis to pull the timeline into the past (the Baseline menu
                and this zone's tooltip say so). Disabled while placing an event so
                axis clicks still land. */}
            <div
              onPointerDown={startAxisDrag}
              title={historyYears
                ? `Showing ${historyYears} past year${historyYears === 1 ? '' : 's'} (a modeled back-projection). Drag left to return to today, right for more.`
                : 'Drag right to show past years (a modeled back-projection); drag left to return to today'}
              style={{
                position: 'absolute', left: PLOT_LEFT, width: plotW, bottom: 0, height: 24,
                cursor: 'ew-resize', touchAction: 'none', zIndex: 6,
                pointerEvents: addMode ? 'none' : 'auto',
              }}
            />
          </div>
          {/* Milestones: emoji pins under the plot and a key beneath. */}
          <MilestoneLane
            events={events.map(e => ({ id: e.id, label: e.label, icon: e.icon, age: e.age, repeats: eventOccurrences(e, A.endAge).slice(1) }))}
            marks={laneMarks} ageToX={ageToX} left={PLOT_LEFT} right={PLOT_LEFT + plotW}
            startAge={startAge} endAge={A.endAge} editingId={editingId} addMode={addMode}
            onDragStart={id => { dragId.current = id; dragMoved.current = false; }}
            onEdit={id => setEditingId(id)}
            onMove={(id, age) => updateEvent(id, { age })}
            onOpenSection={showSection} />
          {historyYears > 0 && (
            <p className="fc-lane-history">
              <span aria-hidden="true">⟲ </span>Showing {historyYears} past year{historyYears === 1 ? '' : 's'} (modeled) · drag the age axis to change
              <button type="button" className="btn-ghost btn-sm" onClick={() => setHistoryYears(0)}>Hide past</button>
            </p>
          )}
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
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>Life event · age {editingEvent.age}</span>
                <XButton onClick={() => setEditingId(null)} label="Close event editor" />
              </div>
              <input value={editingEvent.label} onChange={ev => updateEvent(editingEvent.id, { label: ev.target.value })}
                placeholder="Label" aria-label="Event label" style={{ fontSize: 13, padding: '4px 8px', width: '100%', marginBottom: 8 }} />
              <select value={editingEvent.type} aria-label="Event type"
                onChange={ev => { const t = ev.target.value as EventType; updateEvent(editingEvent.id, { type: t, icon: EVENT_TYPE_META[t].icon }); }}
                style={{ width: '100%', marginBottom: 8 }}>
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
                        className={((editingEvent.isPct ?? false) === v ? 'btn-primary' : 'btn-ghost') + ' btn-sm'}>{lbl}</button>
                    ))}
                  </div>
                )}
                {/* One-time: purchase (cash out) vs sale / windfall (cash in) */}
                {editingEvent.type === 'oneTime' && (
                  <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                    {([['💸 Purchase', false], ['💰 Sale (money in)', true]] as [string, boolean][]).map(([lbl, v]) => (
                      <button key={lbl} onClick={() => updateEvent(editingEvent.id, { isSale: v })}
                        className={((editingEvent.isSale ?? false) === v ? 'btn-primary' : 'btn-ghost') + ' btn-sm'}>{lbl}</button>
                    ))}
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <span style={{ fontSize: 13, color: 'var(--muted)' }}>{
                    editingEvent.type === 'income' ? (editingEvent.isPct ? 'Change %' : 'Change / yr')
                    : editingEvent.type === 'recurringEvery' ? 'Each time'
                    : editingEvent.type === 'oneTime' ? (editingEvent.isSale ? 'Proceeds' : 'Cost')
                    : 'Amount'}</span>
                  <NumberInput value={editingEvent.amount} required={false} signed
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
                <button className="btn-ghost btn-sm" style={{ color: 'var(--red)' }}
                  onClick={() => { removeEvent(editingEvent.id); setEditingId(null); }}>Remove</button>
                <button className="btn-primary btn-sm" onClick={() => setEditingId(null)}>Done</button>
              </div>
            </div>
          )}
        </div>
        {/* Legend for the lines and bands (Recharts' own sat between the plot and the pins). */}
        <p className="fc-legend" aria-hidden="true">
          {tab === 'Cash Flow' ? (<>
            <span><span className="fc-legend-line" style={{ borderTopColor: CF_INCOME }} />Income + SS</span>
            <span><span className="fc-legend-line" style={{ borderTopColor: CF_SPEND }} />{spendLabel}</span>
            <span><span className="fc-swatch" style={{ background: CF_INCOME, opacity: 0.35 }} />Saving</span>
            <span><span className="fc-swatch" style={{ background: CF_SPEND, opacity: 0.45 }} />Drawing from savings</span>
          </>) : (<>
            <span><span className="fc-legend-line" style={{ borderTopColor: tab === 'Net Worth' ? 'var(--accent)' : 'var(--amber)' }} />{tab === 'Net Worth' ? 'Median net worth' : 'Median investable assets'}</span>
            <span><span className="fc-swatch" style={{ background: 'color-mix(in srgb, var(--accent) 22%, transparent)' }} />Likely range (10th–90th pct)</span>
            {baseline && <span><span className="fc-legend-line dashed" />Baseline</span>}
          </>)}
        </p>
        {tab === 'Investable assets' && (
          <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 8 }}>
            Success counts the {histOn ? 'past starting years' : 'futures'} where these assets never hit $0 before {A.endAge}. {histOn
              ? <>Each line of the band is a past starting year replayed with actual returns and inflation, restated at your plan’s inflation.</>
              : <>Returns are sampled around {pctTxt(leverReturn)} ± {Math.round(A.volatility * 100)}%{glidePath ? `, with equity gliding from ${Math.round(GLIDE_EQUITY_START * 100)}% to ${Math.round(GLIDE_EQUITY_END * 100)}% by retirement` : ''}.</>}
          </p>
        )}

        {tab === 'Cash Flow' && ruleOn && (
          <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 8 }}>
            Planned spending is shown before your spending rule; once retired, the rule may spend less or more each year.
          </p>
        )}

        {/* What-if levers: temporary overrides; nothing changes until "Save to plan". */}
        <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
            <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>What if…</h2>
            <span style={{ fontSize: 13, color: 'var(--muted)' }}>Try changes without touching your plan</span>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              <button type="button" className="btn-ghost btn-sm" disabled={!leversDirty} onClick={resetLevers}>Reset</button>
              <button type="button" className="btn-primary btn-sm" disabled={!leversDirty} onClick={saveLevers}
                title={`Make these the plan: sets your retirement age, annual spending and return${saveTargetAcct ? `, and adds the extra saving to ${saveTargetAcct.name}` : ''}`}>Save to plan</button>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
            <Lever id="fc-lever-retire" label="Retire at" valueText={String(leverRetire)} min={leverRetireMin} max={leverRetireMax} step={1}
              value={leverRetire} onChange={n => setLevers(p => ({ ...NO_LEVERS, ...p, retireAge: n }))} active={retireLeverOn} />
            <Lever id="fc-lever-spend" min={-50} max={50} step={5} value={leverSpendPct}
              label={`Spending${leverSpendPct ? ` ${leverSpendPct > 0 ? '+' : '−'}${Math.abs(leverSpendPct)}%` : ''}`}
              valueText={`${moneyM(A.annualSpending * spendingAdjust)}/yr`}
              onChange={n => setSpendingAdjust(1 + n / 100)} active={spendLeverOn} />
            <Lever id="fc-lever-save" label="Extra saving" min={0} max={50000} step={1000} value={levers.extraSave}
              valueText={levers.extraSave ? `+${moneyM(levers.extraSave)}/yr` : '$0/yr'}
              onChange={n => setLevers(p => ({ ...NO_LEVERS, ...p, extraSave: n }))} active={saveLeverOn} />
            <Lever id="fc-lever-return" label="Return" min={Math.min(3, leverReturn * 100)} max={Math.max(11, leverReturn * 100)} step={0.5}
              value={Math.round(leverReturn * 1000) / 10} valueText={pctTxt(leverReturn)}
              onChange={n => setLevers(p => ({ ...NO_LEVERS, ...p, investReturn: n / 100 }))}
              note={histOn ? 'Not used with past markets' : undefined} active={returnLeverOn && !histOn} />
          </div>
          {/* One line for the combined effect of whatever was moved. */}
          <p className={'fc-whatif' + (whatIfText ? ' on' : '')} role="status" aria-live="polite">
            {whatIfText ?? 'Move a slider to try a change.'}
          </p>
        </div>
      </div>
      </div>{/* /forecast-chart-col */}

      {/* The answers: straight under the hero in one column, under both columns on wide screens. */}
      <div id="fc-answers" {...anchor('forecast-answers')}>
        <PlanAnswers input={shownInput} money={n => money(n)} answers={answers} shownAbove={HEADLINE_ANSWERS} />
      </div>

      <div id="fc-inputs" {...anchor('forecast-controls-col')}>
      {/* One folded row per section, stating its values; a row opens on click. */}
      <div style={{ ...card, padding: '2px 20px' }}>
        <div className="fc-inputs-head">
          <h2>Your plan</h2>
          <button type="button" className="btn-ghost btn-sm" aria-pressed={allGroupsOpen}
            onClick={() => setGroups(prev => Object.fromEntries(GROUP_KEYS.map(k => [k, !allGroupsOpen])) as Record<string, boolean> & typeof prev)}>
            {allGroupsOpen ? 'Close all' : 'Open all'}
          </button>
        </div>

        {/* — You — */}
        <Group id="fc-group-you" open={groupOpen('you')} onToggle={() => toggleGroup('you')} title={earners[0]?.label?.trim() && !/^you$/i.test(earners[0].label.trim()) ? `You (${earners[0].label.trim()})` : 'You'}
          badge={placeholders ? <span style={pill('var(--amber)', 'rgba(251,191,36,0.14)')} title="Age and income are still the built-in placeholders — set yours below">Placeholder values</span> : undefined}
          summary={earnerSummary({ currentAge: currentAge0, income: earners[0]?.income ?? 0, retireAge: earners[0]?.retireAge ?? 65 }, n => money(n))}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <span style={{ ...subHead, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              Earnings &amp; retirement
              <InfoTip text="Each earner's income grows by its annual raise each year until retirement, then stops — independent of inflation (set 0% for a field with no cost-of-living raises). Set per-account contributions under Savings." />
            </span>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--muted)', cursor: 'pointer' }}>
              <input type="checkbox" checked={earners[1]?.enabled ?? false}
                onChange={e => { updateEarner(1, { enabled: e.target.checked }); if (e.target.checked) openGroup('partner'); }} style={{ width: 'auto' }} />
              Two earners
            </label>
          </div>
          {earnerFields(0)}
        </Group>

        {/* — Partner — (two-earner households) */}
        {earners[1]?.enabled && (
          <Group id="fc-group-partner" open={groupOpen('partner')} onToggle={() => toggleGroup('partner')} title={earners[1]?.label?.trim() || 'Partner'}
            summary={earnerSummary({ currentAge: earners[1].currentAge, income: earners[1].income, retireAge: earners[1].retireAge }, n => money(n))}>
            {earnerFields(1)}
            <button type="button" className="btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={() => updateEarner(1, { enabled: false })}
              title="Back to a one-earner plan (the partner's figures are kept if you turn them on again)">Remove second earner</button>
          </Group>
        )}

        {/* — Social Security — */}
        <Group id="fc-group-ss" open={groupOpen('ss')} onToggle={() => toggleGroup('ss')} title="Social Security"
          summary={ssSummary(earners.filter((e, i) => i === 0 || e.enabled).map(e => ({ enabled: e.ssEnabled, annual: e.ssAnnual, claimAge: e.ssClaimAge })), n => money(n))}>
          <div className={'fc-two-up' + (earners[1]?.enabled ? '' : ' single')}>
            {earners.map((e, idx) => ((idx === 0 || e.enabled) ? (
              <div key={idx} style={earners[1]?.enabled ? { border: '1px solid var(--border)', borderRadius: 10, padding: 14 } : undefined}>
                {ssFields(idx)}
              </div>
            ) : null))}
          </div>
        </Group>

        {/* — Spending — */}
        <Group id="fc-group-spending" open={groupOpen('spending')} onToggle={() => toggleGroup('spending')} title="Spending"
          summary={spendingSummary({ living: firstLiving, housing: firstHousing }, n => money(n), ruleOn ? RULE_LABELS[spendRule.kind].toLowerCase() : undefined)}>
          <div>
            {numRow('Plan to age', 'endAge', 1, 1)}
            <div style={rowStyle}>
              <span style={{ fontSize: 13, color: 'var(--muted)' }}>Annual spending</span>
              <NumberInput value={A.annualSpending} prefix="$"
                onCommit={n => setA(prev => ({ ...DEFAULT_ASSUMPTIONS, ...prev, annualSpending: n }))} />
            </div>
            {/* What "spending" includes: the forecast's own first year, so it always
                matches the year-by-year table. */}
            {firstHousing > 0.5 && firstBand && (
              <p className="fc-spend-split">
                In {firstBand.year} the forecast spends <strong>{money(firstBand.spending)}</strong>: {money(firstLiving)} living + {money(firstHousing)} housing
                {Math.abs(firstOther) > 0.5 && <> {firstOther > 0 ? '+' : '−'} {money(Math.abs(firstOther))} from life events{firstOther < 0 ? ' that cut spending' : ' and college'}</>}
                <InfoTip text="Housing is added on top of Annual spending: mortgage payments until payoff, plus property tax, insurance and HOA, each growing at its own rate (set under Home). Living is everything else the forecast spends that year — your Annual spending plus any kids, college or life events. If your tracked spending already includes these housing costs, lower Annual spending." />
              </p>
            )}
            <SpendingRule rule={spendRule} onChange={setSpendRule} paths={sim.paths} historical={histOn} />
            {hasProjection && projection && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 2 }}>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                  Your {projection.monthsAnalyzed}-month average: {money(projection.avgMonthlySpending * 12)}/yr spending · {money(projection.avgMonthlyIncome * 12)}/yr income
                </span>
                <button className="btn-ghost btn-sm" style={{ marginLeft: 'auto' }}
                  onClick={() => {
                    setPrevApplied({ income: earners[0]?.income ?? 0, spending: A.annualSpending });
                    setA(prev => ({ ...DEFAULT_ASSUMPTIONS, ...prev, annualSpending: projection.avgMonthlySpending * 12 }));
                    updateEarner(0, { income: projection.avgMonthlyIncome * 12 });
                    clearImported('earner0.income');
                  }}>Use my averages</button>
                {prevApplied && (
                  <button className="btn-ghost btn-sm"
                    onClick={() => { setA(prev => ({ ...DEFAULT_ASSUMPTIONS, ...prev, annualSpending: prevApplied.spending })); updateEarner(0, { income: prevApplied.income }); setPrevApplied(null); }}>
                    ↩ Revert
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Spending breakdown from transactions — the source of the spending figure. */}
          {hasProjection && projection && (
            <div ref={spendingRef} style={{ borderTop: '1px solid var(--border)', marginTop: 12, paddingTop: 10, scrollMarginTop: 16 }}>
              <button type="button" aria-expanded={showSpending} onClick={() => setShowSpending(s => !s)}
                style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', background: 'none', border: 'none', padding: '4px 0', color: 'var(--text)', font: 'inherit', fontSize: 13, fontWeight: 600, textAlign: 'left' }}>
                <span aria-hidden="true" style={{ color: 'var(--muted)', fontSize: 12, width: 10 }}>{showSpending ? '▾' : '▸'}</span>
                Spending breakdown
                <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 400, color: 'var(--muted)' }}>{projection.monthsAnalyzed} month{projection.monthsAnalyzed === 1 ? '' : 's'} of transactions</span>
              </button>
              {showSpending && (<div style={{ marginTop: 10 }}>
                <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 }}>
                  <div>
                    <p style={{ color: 'var(--muted)', fontSize: 12 }}>Avg spending / {projAnnual ? 'yr' : 'mo'}</p>
                    <p style={{ fontSize: 18, fontWeight: 700 }}>{money(projection.avgMonthlySpending * (projAnnual ? 12 : 1))}</p>
                  </div>
                  <div>
                    <p style={{ color: 'var(--muted)', fontSize: 12 }}>Avg income / {projAnnual ? 'yr' : 'mo'}</p>
                    <p style={{ fontSize: 18, fontWeight: 700 }}>{money(projection.avgMonthlyIncome * (projAnnual ? 12 : 1))}</p>
                  </div>
                  <div>
                    <p style={{ color: 'var(--muted)', fontSize: 12 }}>Spending trend</p>
                    <p style={{ fontSize: 18, fontWeight: 700, color: projection.trendPctPerYear > 0 ? 'var(--red)' : 'var(--green)' }}>
                      {projection.trendPctPerYear >= 0 ? '+' : ''}{Math.round(projection.trendPctPerYear * 100)}%/yr
                    </p>
                  </div>
                  <div className="seg" role="group" aria-label="Amounts per" style={{ marginLeft: 'auto' }}>
                    {([['Per year', true], ['Per month', false]] as [string, boolean][]).map(([label, val]) => (
                      <button key={label} type="button" aria-pressed={projAnnual === val} onClick={() => setProjAnnual(val)}
                        className={'seg-btn' + (projAnnual === val ? ' active' : '')}>{label}</button>
                    ))}
                  </div>
                </div>
                {projection.byCategory.length > 0 && (() => {
                  const max = projection.byCategory[0].avgMonthly || 1;
                  return (
                    <div style={{ display: 'grid', gap: 2 }}>
                      {projection.byCategory.slice(0, 8).map(c => (
                        <div key={c.category} onClick={() => viewCategoryTxns(c.category)}
                          role="button" tabIndex={0} aria-label={`View ${c.category} transactions`}
                          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); viewCategoryTxns(c.category); } }}
                          title={`View ${c.category} transactions`}
                          style={{ display: 'grid', gridTemplateColumns: '120px 1fr 80px', gap: 10, alignItems: 'center', fontSize: 12, cursor: 'pointer', padding: '4px 6px', margin: '0 -6px', borderRadius: 6 }}
                          {...hoverBg}>
                          <span style={{ color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.category} <span style={{ opacity: 0.5 }}>›</span></span>
                          <div style={{ height: 6, background: 'var(--bg)', borderRadius: 4, overflow: 'hidden' }}>
                            <div style={{ width: `${(c.avgMonthly / max) * 100}%`, height: '100%', background: 'var(--accent)', borderRadius: 4 }} />
                          </div>
                          <span style={{ textAlign: 'right' }}>{money(c.avgMonthly * (projAnnual ? 12 : 1))}/{projAnnual ? 'yr' : 'mo'}</span>
                        </div>
                      ))}
                    </div>
                  );
                })()}
                {projection.trendPctPerYear > 0 && (
                  <button className="btn-ghost btn-sm" style={{ marginTop: 10 }} onClick={() => setNum('inflation', 1)(String(projection.trendPctPerYear))}>
                    Set inflation to my {Math.round(projection.trendPctPerYear * 100)}%/yr trend
                  </button>
                )}
              </div>)}
            </div>
          )}
        </Group>

        {/* — Savings — */}
        <Group id="fc-group-savings" open={groupOpen('savings')} onToggle={() => toggleGroup('savings')} title="Savings"
          summary={savingsSummary({
            total: totalBal, connected: hasAccounts, contribPerYear: totalContribAnnual,
            buckets: (['taxable', 'pretax', 'roth', 'hsa', 'college'] as TaxBucket[]).filter(b => pools0[b] > 0.5).map(b => (b === 'taxable' || b === 'pretax' ? BUCKET_META[b].label.toLowerCase() : BUCKET_META[b].label)),
          }, n => money(n))}
          summaryColor={hasAccounts && totalContribAnnual === 0 ? 'var(--amber)' : undefined}
          peek={hasAccounts && (
            <div style={{ display: 'flex', height: 6, borderRadius: 3, overflow: 'hidden', margin: '-6px 0 14px' }}>
              {(['taxable', 'pretax', 'roth', 'hsa', 'college'] as TaxBucket[]).map(b => {
                const pct = totalBal > 0 ? (pools0[b] / totalBal) * 100 : 0;
                return pct > 0 ? <div key={b} style={{ width: `${pct}%`, background: BUCKET_META[b].color }} /> : null;
              })}
            </div>
          )}>
          {taxData ? (<>
          {/* Bucket totals bar */}
          {taxData.accounts.length > 0 && (
            <div style={{ display: 'flex', height: 12, borderRadius: 6, overflow: 'hidden', marginBottom: 12 }}>
              {(['taxable', 'pretax', 'roth', 'hsa', 'college'] as TaxBucket[]).map(b => {
                const pct = effBaseAccounts > 0 ? (pools0[b] / effBaseAccounts) * 100 : 0;
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
          {hasAccounts && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 10 }}>
              <span style={{ ...subHead, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                Contributions by account
                <InfoTip width={300} text={`Your own yearly contribution to each account — employee dollars only (the employer match goes under You or Partner). EE / EE+ER / Max fill the ${limitYear} IRS limit. Pre-tax & HSA contributions are tax-deductible and stop once everyone has retired. Buckets are guessed from account names — fix any that are wrong. Withdrawals draw taxable → pre-tax → Roth, HSA last.`} />
              </span>
              <button className={(totalContribAnnual === 0 && !showAccounts ? 'btn-primary' : 'btn-ghost') + ' btn-sm'} onClick={() => setShowAccounts(s => !s)}>
                {showAccounts ? 'Hide accounts' : 'Set contributions'}
              </button>
            </div>
          )}
          {showAccounts && taxData.accounts.length > 0 && (() => {
            // Group by institution, mirroring the dashboard's default grouping.
            const groups = new Map<string, TaxAccount[]>();
            for (const acc of taxData.accounts) { const g = groups.get(acc.org_name) ?? []; g.push(acc); groups.set(acc.org_name, g); }
            return (
              <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
                {/* Two lines per account: name + balance, then tax bucket + contribution.
                    On a single line the fixed controls left the name ~45px in this
                    narrow column, so names broke mid-word (and phones had to scroll
                    sideways). */}
                {[...groups.entries()].map(([org, accs]) => (
                  <div key={org} style={{ marginBottom: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '2px 0 4px' }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>{org}</span>
                      <span style={{ fontSize: 12, color: 'var(--muted)' }}>{money(accs.reduce((t, x) => t + x.balance, 0))}</span>
                    </div>
                    {accs.map(acc => { const off = acctExcluded(acc); return (
                      <div key={acc.id} style={{ display: 'grid', gridTemplateColumns: '24px minmax(0, 1fr) auto', columnGap: 10, rowGap: 4, alignItems: 'center', padding: '5px 0 5px 10px', fontSize: 12, opacity: off ? 0.4 : 1 }}>
                        <input type="checkbox" checked={!off} title={off ? 'Excluded — click to include in the forecast' : 'Included — click to exclude from the forecast'}
                          onChange={() => setExcludedAccounts(prev => { const c = { ...prev }; if (off) delete c[acc.id]; else c[acc.id] = true; return c; })}
                          style={{ width: 'auto', justifySelf: 'center' }} />
                        <span style={{ whiteSpace: 'normal', overflowWrap: 'break-word', lineHeight: 1.3, textDecoration: off ? 'line-through' : 'none' }} title={acc.name}>{acc.name}</span>
                        <span style={{ textAlign: 'right', color: 'var(--muted)' }}>{money(acc.balance)}</span>
                        <div style={{ gridColumn: '2 / -1', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '4px 8px' }}>
                          <select value={bucketOf(acc)} title="Tax bucket" aria-label={`Tax bucket for ${acc.name}`}
                            onChange={ev => setBucketOverrides(prev => ({ ...prev, [acc.id]: ev.target.value as TaxBucket }))}
                            style={{ fontSize: 12, padding: '3px 6px' }}>
                            {(['taxable', 'pretax', 'roth', 'hsa', 'college'] as TaxBucket[]).map(b => <option key={b} value={b}>{BUCKET_META[b].label}</option>)}
                          </select>
                        {/* Max-fill buttons sit inline, just left of the input, so the input's
                            right edge lines up across every row. Only shown for federally-limited buckets. */}
                        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'nowrap', gap: 5 }}>
                          {(() => {
                            const b = bucketOf(acc);
                            const set = (v: number) => setAccountContribs(prev => ({ ...prev, [acc.id]: v }));
                            const mb: React.CSSProperties = { fontSize: 12, padding: '3px 7px', lineHeight: 1.4, whiteSpace: 'nowrap', flex: '0 0 auto' };
                            if (b === 'pretax') return (<>
                              <button className="btn-ghost" style={mb} title={`${limitYear} max employee deferral (401(k)/403(b)) — ${money(irs.k401Employee)}/yr`} onClick={() => set(irs.k401Employee)}>EE</button>
                              <button className="btn-ghost" style={mb} title={`${limitYear} overall 401(k)/403(b) additions cap (§415(c)) — ${money(irs.k401Total)}/yr. Use only if YOUR OWN dollars reach it (e.g. after-tax / mega-backdoor); enter the employer match on the earner card instead.`} onClick={() => set(irs.k401Total)}>EE+ER</button>
                            </>);
                            if (b === 'roth') return <button className="btn-ghost" style={mb} title={`${limitYear} max Roth IRA — ${money(irs.ira)}/yr`} onClick={() => set(irs.ira)}>Max</button>;
                            if (b === 'hsa') return <button className="btn-ghost" style={mb} title={`${limitYear} max HSA, family coverage — ${money(irs.hsaFamily)}/yr`} onClick={() => set(irs.hsaFamily)}>Max</button>;
                            return null;
                          })()}
                          <NumberInput value={accountContribs[acc.id] ?? 0} prefix="$" suffix="/yr" width={64} required={false}
                            onCommit={n => setAccountContribs(prev => ({ ...prev, [acc.id]: n }))} />
                        </div>
                        </div>
                      </div>
                    ); })}
                  </div>
                ))}
              </div>
            );
          })()}
          </>) : (
            <p style={{ fontSize: 13, color: 'var(--muted)' }}>Connect accounts to break your balances down by tax treatment.</p>
          )}
        </Group>

        {/* — Home — */}
        {breakdown && breakdown.properties.length > 0 && (
          <Group id="fc-group-home" open={groupOpen('home')} onToggle={() => toggleGroup('home')} title="Home"
            summary={homeSummary({ count: breakdown.properties.filter(p => !excludedRE[String(p.id)]).length, equity: effBaseRE, sellable: anySellable }, n => money(n))}
            summaryColor={homeEquityIdle ? 'var(--amber)' : undefined}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
              <span style={{ ...subHead, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                Properties
                <InfoTip width={300} text="Each property grows as its own asset: the value appreciates and the mortgage amortizes. Its housing cost (P&I until payoff, plus tax/insurance/HOA) is charged every year, on top of Annual spending — lower that if your tracked spending already includes these. Equity only counts toward retirement solvency for a property marked “Sell” (downsize or reverse mortgage)." />
              </span>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>{money(effBaseRE)} equity</span>
            </div>
              {breakdown.properties.map(p => {
                const off = !!excludedRE[String(p.id)];
                const sell = !!sellableRE[String(p.id)];
                const eq = (p.zestimate ?? 0) - (p.mortgage_balance ?? 0);
                return (
                  <div key={p.id} style={{ display: 'grid', gridTemplateColumns: '24px 1fr auto auto', gap: 10, alignItems: 'center', padding: '3px 0 3px 10px', fontSize: 12, opacity: off ? 0.4 : 1 }}>
                    <input type="checkbox" checked={!off} title={off ? 'Excluded — click to include in the forecast' : 'Included — click to exclude from the forecast'}
                      onChange={() => setExcludedRE(prev => { const c = { ...prev }; if (off) delete c[String(p.id)]; else c[String(p.id)] = true; return c; })}
                      style={{ width: 'auto', justifySelf: 'center' }} />
                    <span style={{ whiteSpace: 'normal', overflowWrap: 'anywhere', lineHeight: 1.3, textDecoration: off ? 'line-through' : 'none' }} title={p.address}>{p.address}</span>
                    <span style={{ textAlign: 'right', color: 'var(--muted)' }}>{money(eq)}</span>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, whiteSpace: 'nowrap', cursor: off ? 'default' : 'pointer', color: sell ? 'var(--green)' : 'var(--muted)' }}
                      title="Sell/draw this property's equity as a last resort to cover retirement shortfalls (downsize / reverse mortgage)">
                      <input type="checkbox" disabled={off} checked={sell}
                        onChange={() => setSellableRE(prev => { const c = { ...prev }; if (c[String(p.id)]) delete c[String(p.id)]; else c[String(p.id)] = true; return c; })}
                        style={{ width: 'auto' }} />
                      💵 Sell
                    </label>
                  </div>
                );
              })}
            {homeEquityIdle && (
              <p style={{ fontSize: 12, color: 'var(--text)', background: 'rgba(245,158,11,0.08)', border: '1px solid var(--amber)', borderRadius: 8, padding: '7px 10px', margin: '8px 0 0' }}>
                Your home equity ({money(effBaseRE)}) isn’t counted toward solvency, so a projection can “fail” while you still own a valuable home. Tick <strong>“💵 Sell”</strong> to let a property’s equity cover late-life shortfalls.
              </p>
            )}
            <div style={{ borderTop: '1px solid var(--border)', marginTop: 12, paddingTop: 8 }}>
              <span style={subHead}>Growth rates</span>
              {numRow('Home value growth %', 'realEstateGrowth', 0.5, 100, '', '%')}
              {realEstate && (<>
                {numRow('Property tax growth %', 'propertyTaxGrowth', 0.5, 100, '', '%')}
                {numRow('Insurance growth %', 'insuranceGrowth', 0.5, 100, '', '%')}
                {numRow('HOA growth %', 'hoaGrowth', 0.5, 100, '', '%')}
                {realEstate.rentalIncomeAnnual > 0 && numRow('Rental income growth %', 'rentalGrowth', 0.5, 100, '', '%')}
              </>)}
            </div>
          </Group>
        )}

        {/* — Family — */}
        <Group id="fc-group-family" open={groupOpen('family')} onToggle={() => toggleGroup('family')} title="Family"
          summary={familySummary({ kids: kidAges.length, planned: futureKids.length, college: collegeOn })}>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ ...subHead, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  Kids
                  <InfoTip text="Current kids are already in your spending — it drops by the per-kid cost as each reaches independence (the empty-nest effect). Planned kids add the per-kid cost from birth to the independence age. College is modeled separately below." />
                </span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn-ghost btn-sm" onClick={() => setKidAges(prev => [...prev, 0])}>+ Add kid</button>
                  <button className="btn-ghost btn-sm"
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
                        onCommit={n => { const age = Math.min(30, Math.max(0, Math.round(n))); setKidAges(prev => prev.map((v, i2) => (i2 === idx ? age : v))); clearImported('kids'); }} />
                      <XButton onClick={() => setKidAges(prev => prev.filter((_, i2) => i2 !== idx))} label={`Remove kid (age ${k})`} color="var(--red)" />
                    </span>
                  ))}
                  {/* Planned future kids — dashed chip, editable "born in N years"; mirrors the chart 🧒 marker. */}
                  {futureKids.map(e => (
                    <span key={e.id} title="Planned future child — set the years until they're born, or drag the 🧒 on the chart"
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 3, background: 'var(--bg)', border: '1px dashed var(--border)', borderRadius: 14, padding: '2px 6px 2px 8px', fontSize: 12 }}>
                      🧒
                      <span style={{ fontSize: 12, color: 'var(--muted)' }}>in</span>
                      <NumberInput value={e.age - currentAge0} width={30} required={false} suffix="y" title="Years until this child is born"
                        onCommit={n => updateEvent(e.id, { age: Math.round(currentAge0 + Math.max(0, n)) })} />
                      <XButton onClick={() => removeEvent(e.id)} label="Remove planned kid" color="var(--red)" />
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
                        ? <p key={idx} style={{ fontSize: 12, color: 'var(--muted)' }}>🧒 age {k}: already independent — no spending effect</p>
                        : <p key={idx} style={{ fontSize: 12, color: 'var(--text)' }}>🧒 age {k}: independent in {yearsToIndep}y → spending <strong>−{money(costPerKid)}/yr</strong> after</p>;
                    })}
                  </div>
                </>)}
              </>)}
            </div>
          <div style={{ borderTop: '1px solid var(--border)', marginTop: 16, paddingTop: 14 }}>
            <h3 style={{ ...subHead, marginBottom: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              Education
              <InfoTip text="Modeled per child, funded from 529 first then taxable. Cost/year is entered in today's dollars but reported in the dollars of the years attended (grown by education inflation)." />
            </h3>
          {eduChildren.length === 0 && (
            <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: -6, marginBottom: 12 }}>Add kids above to project college &amp; grad-school costs.</p>
          )}
          <div className="fc-two-up">
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
                    <button key={p.label} className="btn-ghost btn-sm" title={`Set cost/year to ${fmtMoney(p.value)} (today's $)`}
                      onClick={() => setA(prev => ({ ...DEFAULT_ASSUMPTIONS, ...prev, collegeCostPerYear: p.value }))}>
                      {p.label} {fmtMoneyCompact(p.value)}
                    </button>
                  ))}
                </div>
                {/* Reported in the dollars of the years attended (grown by education inflation). */}
                {eduChildren.length > 0 && (
                  <div style={{ marginTop: 8, display: 'grid', gap: 3 }}>
                    {eduChildren.map(c => {
                      const p = eduCost(c.ageNow, A.collegeStartAge, A.collegeYears, A.collegeCostPerYear, A.eduInflation);
                      if (!p) return <p key={c.key} style={{ fontSize: 12, color: 'var(--muted)' }}>🧒 {c.label}: past college age</p>;
                      const when = p.startsIn > 0 ? `in ${p.startsIn}y` : 'now';
                      return (
                        <p key={c.key} style={{ fontSize: 12, color: 'var(--text)' }}>
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
                <div style={rowStyle}>
                  <span style={{ fontSize: 13, color: 'var(--muted)' }}>You cover</span>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    {([['Full', 1], ['Partial', 0.5]] as [string, number][]).map(([lbl, v]) => {
                      const active = lbl === 'Full' ? A.gradCoverage >= 1 : A.gradCoverage < 1;
                      return <button key={lbl} className={(active ? 'btn-primary' : 'btn-ghost') + ' btn-sm'}
                        onClick={() => setA(prev => ({ ...DEFAULT_ASSUMPTIONS, ...prev, gradCoverage: v }))}>{lbl}</button>;
                    })}
                    {A.gradCoverage < 1 && <NumberInput value={A.gradCoverage * 100} suffix="%" width={58} required={false}
                      onCommit={n => setA(prev => ({ ...DEFAULT_ASSUMPTIONS, ...prev, gradCoverage: Math.max(0, Math.min(1, n / 100)) }))} />}
                  </div>
                </div>
                {/* Reported in the dollars of the years attended (grown by education inflation). */}
                {eduChildren.length > 0 && (
                  <div style={{ marginTop: 8, display: 'grid', gap: 3 }}>
                    {eduChildren.map(c => {
                      const p = eduCost(c.ageNow, A.gradStartAge, A.gradYears, A.gradCostPerYear, A.eduInflation, A.gradCoverage);
                      if (!p) return <p key={c.key} style={{ fontSize: 12, color: 'var(--muted)' }}>🧒 {c.label}: past grad-school age</p>;
                      const when = p.startsIn > 0 ? `in ${p.startsIn}y` : 'now';
                      return (
                        <p key={c.key} style={{ fontSize: 12, color: 'var(--text)' }}>
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
        </Group>

        {/* — Assumptions (market, taxes) — */}
        <Group id="fc-group-advanced" open={groupOpen('advanced')} onToggle={() => toggleGroup('advanced')} title="Assumptions"
          summary={assumptionsSummary({ investReturn: A.investReturn, inflation: A.inflation, brackets: taxPlan.mode === 'brackets', effTaxRate: A.effTaxRate, retireTaxRate: A.retireTaxRate })}>
          <span style={{ ...subHead, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            Market
            <InfoTip width={300} text="Returns are nominal (before inflation); spending grows with inflation, income at each earner’s raise rate. Presets use approximate historical S&P 500 returns & volatility, U.S. CPI inflation and Case-Shiller home-price growth over each window — hard-coded rounded figures, not live data." />
          </span>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '10px 0 6px' }}>
            {MARKET_PRESETS.map(p => (
              <button key={p.label} className="btn-ghost btn-sm"
                title={`S&P 500 ${p.label.toLowerCase()} (historical, approximate): ${Math.round(p.investReturn * 1000) / 10}% return, ${Math.round(p.volatility * 100)}% volatility, ${Math.round(p.inflation * 1000) / 10}% inflation, ${Math.round(p.realEstateGrowth * 1000) / 10}% home-price growth`}
                onClick={() => setA(prev => ({ ...DEFAULT_ASSUMPTIONS, ...prev, investReturn: p.investReturn, volatility: p.volatility, inflation: p.inflation, realEstateGrowth: p.realEstateGrowth }))}>
                {p.label} · {Math.round(p.investReturn * 1000) / 10}%
              </button>
            ))}
          </div>
          {numRow('Investment return %', 'investReturn', 0.5, 100, '', '%')}
          {numRow('Return volatility %', 'volatility', 1, 100, '', '%')}
          {histOn && (
            <p style={{ fontSize: 12, color: 'var(--muted)', margin: '2px 0 6px', lineHeight: 1.45 }}>
              Not used while the forecast replays past markets: each starting year earns its actual past returns. They still shape the modeled past on the chart.
            </p>
          )}
          {numRow('Inflation %', 'inflation', 0.5, 100, '', '%')}
          {!(breakdown && breakdown.properties.length > 0) && numRow('Real estate growth %', 'realEstateGrowth', 0.5, 100, '', '%')}
          <label style={{ ...rowStyle, fontSize: 13, color: 'var(--muted)', cursor: 'pointer' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              📉 Equity glide path (de-risk with age)
              <InfoTip text={`Target-date style: equity exposure falls from ${Math.round(GLIDE_EQUITY_START * 100)}% today to ${Math.round(GLIDE_EQUITY_END * 100)}% by retirement, then holds. The rest sits in bonds (≈ inflation + 1%), so both the average return and the swings shrink as you approach retirement.`} />
            </span>
            <input type="checkbox" checked={glidePath} onChange={e => setGlidePath(e.target.checked)} style={{ width: 'auto' }} />
          </label>
          <div style={{ borderTop: '1px solid var(--border)', marginTop: 10, paddingTop: 10 }}>
            <span style={{ ...subHead, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              Taxes
              <InfoTip text={taxPlan.mode === 'brackets'
                ? 'Future years’ federal tax is worked out from the IRS brackets (see the Tax picture card). The two flat rates are not used for the forecast; they only shape the modelled past-years line when the chart shows history. Pre-tax withdrawals before age 60 add a 10% penalty; RMDs start at 73.'
                : 'Effective blended rates. Social Security is taxed at the retirement rate once you stop working; pre-tax withdrawals before age 60 add a 10% penalty; RMDs start at 73.'} />
            </span>
            <TaxControls plan={taxPlan} onChange={setTaxPlan} twoEarners={!!earners[1]?.enabled} />
            {/* Bracket mode: the flat rates only drive the past-years line, so they
                show (relabelled) only while the chart shows history. */}
            {(taxPlan.mode !== 'brackets' || historyYears > 0) && numRow(taxPlan.mode === 'brackets' ? 'Past years: tax rate while working %' : 'Tax rate while working %', 'effTaxRate', 1, 100, '', '%')}
            {(taxPlan.mode !== 'brackets' || historyYears > 0) && numRow(taxPlan.mode === 'brackets' ? 'Past years: tax rate in retirement %' : 'Tax rate in retirement %', 'retireTaxRate', 1, 100, '', '%')}
          </div>
        </Group>
      </div>
      </div>{/* /forecast-controls-col */}
      </div>{/* /forecast-split */}

      <div className="fc-stack">
        <div className={'fc-pair' + (scenariosWide ? ' fc-pair-stack' : '')}>
          <div id="fc-track" {...anchor()}>
            <PlanVsActual baseline={baseline} history={hist ?? null} money={n => money(n)} privacy={privacy} />
          </div>
          <div id="fc-scenarios" {...anchor()}>
            <Scenarios current={dataReady ? currentScenario : null} baseInput={dataReady ? planInput : null} contribFor={contribFor}
              onLoad={loadScenario} money={n => money(n)} onWide={setScenariosWide} />
          </div>
        </div>

        <div className={'fc-pair' + (taxWide ? ' fc-pair-stack' : '')}>
          <div id="fc-taxes" {...anchor()}>
            <TaxPicture plan={taxPlan} onChange={setTaxPlan} sim={sim} simNoConv={simNoConv} infl={infl} realDollars={realDollars}
              currentAge0={currentAge0} endAge={A.endAge} retireAge={retireAge0}
              filing={resolveFiling(taxPlan, !!earners[1]?.enabled)} twoEarners={!!earners[1]?.enabled} money={money} privacy={privacy} />
          </div>
          <div id="fc-past" {...anchor()}>
            <Backtest input={shownInput} sim={sim} settings={backtestSettings} onSettings={setBacktest}
              glidePath={glidePath} endAge={A.endAge} money={n => money(n)} privacy={privacy} />
          </div>
        </div>

        {/* Year-by-year forecast table — the raw numbers the Monte Carlo produces.
            Follows the Future $/Today's $ toggle: balances are end-of-year, flows
            start-of-year (same pricing as the chart and headline stats). */}
        <div id="fc-table" {...anchor()}>
          <YearTable bands={sim.bands} retireAge={retireAge0} money={n => money(n)} privacy={privacy}
            bal={(v, b) => deflYears(v, balanceYearsOut(b.age, currentAge0))}
            flow={(v, b) => deflYears(v, flowYearsOut(b.age, currentAge0))}
            spendLabel={spendLabel} unitLabel={unitLabel}
            footnote={<>Income and spending are single projections; the median and 10th–90th figures come from {histOn ? `the ${histSpanText}, replayed with actual returns and inflation` : `the ${RUNS} simulated market paths`}.{ruleOn ? ' Spending is your plan before the spending rule; in retirement the rule may spend less or more.' : ''} Spending includes housing costs (mortgage until payoff, plus property tax, insurance and HOA).</>} />
        </div>
      </div>{/* /fc-stack */}

    </div>
  );
}
