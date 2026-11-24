// Fee drag: what a portfolio's yearly fund fees add up to over time. Pure and
// dependency-free so the math is unit-tested (feeDrag.test.ts); the Allocation
// page's fee check-up (components/allocation/FeeCheckup.tsx) only formats it.
//
// Units: rates are fractions per year (0.07 = 7%, 0.0005 = 0.05%).
import { DEFAULT_ASSUMPTIONS, DEFAULT_EARNERS } from './forecastConfig.ts';

// Cost this year: the balance times the weighted expense ratio. 0 for anything
// that isn't a usable positive number, so NaN never reaches the page.
export function annualFeeCost(balance: number, ratio: number): number {
  if (!Number.isFinite(balance) || !Number.isFinite(ratio) || balance <= 0 || ratio <= 0) return 0;
  return balance * ratio;
}

export interface FeeDragInput {
  balance: number;        // today's value of the holdings the ratio covers
  ratio: number;          // value-weighted expense ratio
  expectedReturn: number; // nominal yearly return before fees (the Forecast's)
  inflation: number;      // yearly inflation, to state the result in today's dollars
  years: number;          // horizon
}

export interface FeeDrag {
  withoutFees: number;    // balance after `years` at the full return (today's $)
  withFees: number;       // balance after `years` at the return less the ratio (today's $)
  cost: number;           // withoutFees − withFees (today's $) — the fees' total drag
}

const ZERO: FeeDrag = { withoutFees: 0, withFees: 0, cost: 0 };

// Fee drag over N years, as the gap between two balances grown with no further
// contributions:
//   without fees: B × (1 + r)^N
//   with fees:    B × (1 + r − w)^N
// both divided by (1 + i)^N to state them in today's dollars. The gap is bigger
// than N × (yearly cost) because each year's fee also loses the growth it would
// have earned. Example: B = $100,000, r = 7%, w = 0.5%, i = 3%, N = 10:
//   1.07^10 = 1.967151, 1.065^10 = 1.877137, 1.03^10 = 1.343916
//   gap = 100,000 × (1.967151 − 1.877137) / 1.343916 ≈ $6,698 (vs 10 × $500 = $5,000).
// Fees are modelled as a continuous haircut on the return, which is how fund
// fees are actually taken (daily, out of the fund's value), not a year-end bill.
export function feeDrag({ balance, ratio, expectedReturn, inflation, years }: FeeDragInput): FeeDrag {
  if (![balance, ratio, expectedReturn, inflation, years].every(Number.isFinite)) return ZERO;
  if (balance <= 0 || years <= 0) return ZERO;
  const n = Math.floor(years);
  if (n <= 0) return ZERO;
  // A growth factor below 0 would mean losing more than everything in a year;
  // clamp at 0 (the balance is gone) so a pathological input can't flip signs.
  const gross = Math.max(0, 1 + expectedReturn);
  const net = Math.max(0, 1 + expectedReturn - Math.max(0, ratio));
  const deflate = 1 + inflation;
  if (deflate <= 0) return ZERO;
  const withoutFees = balance * Math.pow(gross / deflate, n);
  const withFees = balance * Math.pow(net / deflate, n);
  if (!Number.isFinite(withoutFees) || !Number.isFinite(withFees)) return ZERO;
  return { withoutFees, withFees, cost: Math.max(0, withoutFees - withFees) };
}

export interface ForecastRates { expectedReturn: number; inflation: number; years: number; fromSavedPlan: boolean }

// The Forecast's return, inflation and horizon, each field falling back to the
// Forecast defaults when missing or unusable.
//  - saved:   mon.fcAssumptions (return, inflation, end age; currentAge there
//             is the frozen legacy age field).
//  - earners: mon.fcEarners. The Forecast's "Current age" edits earner 0, and
//             its timeline runs from earner 0's age (Forecast.tsx currentAge0).
//             Like the Forecast's one-time migration, a legacy age still counts
//             while earner 0's age is the untouched default.
// The horizon is the years of growth from the current age to the plan's end
// age (endAge − currentAge; the Forecast's chart has one more band because it
// counts the end-age year itself), clamped to 0..100.
// fromSavedPlan says whether these figures differ from the Forecast's
// defaults, i.e. whether the user has set any of them: the hook hands back
// the defaults object when nothing is saved, so "is a number" can't tell.
export function forecastRates(saved: unknown, earners?: unknown): ForecastRates {
  const s = (saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {}) as Record<string, unknown>;
  const num = (v: unknown, def: number, ok: (x: number) => boolean) =>
    typeof v === 'number' && Number.isFinite(v) && ok(v) ? v : def;
  const okAge = (x: number) => x >= 0 && x <= 120;
  const expectedReturn = num(s.investReturn, DEFAULT_ASSUMPTIONS.investReturn, x => x > -1 && x < 1);
  const inflation = num(s.inflation, DEFAULT_ASSUMPTIONS.inflation, x => x > -1 && x < 1);
  const legacyAge = num(s.currentAge, DEFAULT_ASSUMPTIONS.currentAge, okAge);
  const e0 = Array.isArray(earners) && earners[0] && typeof earners[0] === 'object' ? (earners[0] as Record<string, unknown>) : null;
  const earnerAge = e0 ? num(e0.currentAge, NaN, okAge) : NaN;
  const currentAge = Number.isFinite(earnerAge) && earnerAge !== DEFAULT_EARNERS[0].currentAge ? earnerAge : legacyAge;
  const endAge = num(s.endAge, DEFAULT_ASSUMPTIONS.endAge, x => x >= 0 && x <= 130);
  const years = Math.max(0, Math.min(100, Math.round(endAge - currentAge)));
  const fromSavedPlan = expectedReturn !== DEFAULT_ASSUMPTIONS.investReturn || inflation !== DEFAULT_ASSUMPTIONS.inflation
    || endAge !== DEFAULT_ASSUMPTIONS.endAge || currentAge !== DEFAULT_ASSUMPTIONS.currentAge;
  return { expectedReturn, inflation, years, fromSavedPlan };
}

// Fee drag over a whole list of holdings: each one grown at the return less
// ITS OWN fee, and the gaps added up. Holdings with no fee (stocks, cash) or an
// unknown fee (null) add nothing. This is not the same as growing the total at
// the average fee: (1 + r − w)^N curves with w, so averaging the fees first
// overstates the drag on a mix. Example, 7% return, no inflation, 50 years:
//   $90k of stocks at 0% + $10k of a fund at 1%
//   per holding: 10,000 × (1.07^50 − 1.06^50) = 10,000 × (29.457025 − 18.420154) ≈ $110,369
//   averaged:   100,000 × (1.07^50 − 1.069^50) ≈ $134,544 (22% too high)
// Over one year with no inflation it equals the simple yearly cost Σ value × ratio.
export function portfolioFeeDrag(
  holdings: { value: number; expenseRatio: number | null }[],
  rates: { expectedReturn: number; inflation: number; years: number },
): number {
  let cost = 0;
  for (const h of holdings) {
    if (h.expenseRatio == null || !(h.expenseRatio > 0)) continue;
    cost += feeDrag({ balance: h.value, ratio: h.expenseRatio, ...rates }).cost;
  }
  return cost;
}

// The rows the fee list shows before "Show all": the first `limit`, plus every
// row with an unknown fee after them, so the "+ add" the note points to is
// always on screen. Order is kept.
export function collapsedFeeRows<T extends { expenseRatio: number | null }>(rows: T[], limit: number): T[] {
  return rows.filter((r, i) => i < limit || r.expenseRatio == null);
}

// Expense ratio as a short percent for display: 0.0003 → "0.03%", 0.0125 →
// "1.25%", 0.00015 → "0.015%" (an extra digit only when two would round away
// a real figure).
export function fmtRatio(ratio: number | null | undefined): string {
  if (ratio == null || !Number.isFinite(ratio)) return '—';
  const pct = ratio * 100;
  if (pct === 0) return '0%';
  // Under 0.1% keep a third decimal, dropping it when it's a trailing zero.
  return (Math.abs(pct) < 0.1 ? pct.toFixed(3).replace(/0$/, '') : pct.toFixed(2)) + '%';
}

// Parse what the user typed as a percent ("0.03", "0.03%", " 1 ") into a ratio
// fraction. null for blank; NaN-free: an unusable entry returns { error }.
export function parseRatioInput(text: string): { ratio: number | null } | { error: string } {
  const t = text.trim().replace(/%$/, '').trim();
  if (!t) return { ratio: null };
  if (!/^\d*\.?\d+$|^\d+\.$/.test(t)) return { error: 'Enter a percent, like 0.25' };
  const pct = Number(t);
  if (!Number.isFinite(pct) || pct < 0 || pct > 5) return { error: 'Enter a figure from 0% to 5%' };
  return { ratio: pct / 100 };
}
