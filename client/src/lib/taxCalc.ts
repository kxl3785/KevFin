import type { Bracket, IrmaaTier, YearTaxParams, FilingStatus } from './taxTables.ts';

// Pure US federal income-tax arithmetic for one year, used by the Forecast's
// opt-in bracket tax model. Tables and their sources live in taxTables.ts; this
// file only does the math. Estimates for planning, not tax advice.
//
// Not modelled: AMT, credits, itemised deductions, ACA subsidies, state brackets,
// estate tax, tax-exempt interest (would raise provisional income and MAGI), the
// head-of-household and married-filing-separately statuses.

export interface TaxIncome {
  wages: number;             // taxable wages: gross pay less pre-tax 401(k)/HSA payroll deferrals
  pretaxWithdrawals: number; // traditional IRA / 401(k) withdrawals, including required distributions
  conversions: number;       // pre-tax → Roth conversions (ordinary income, no penalty)
  interest: number;          // taxable interest and non-qualified dividends (ordinary, investment income)
  qualified: number;         // long-term capital gains and qualified dividends
  socialSecurity: number;    // gross Social Security benefits
}
export interface TaxHousehold {
  status: FilingStatus;
  age65Count: number;        // people on the return aged 65+ (clamped to 1 single / 2 joint)
}

export const ZERO_INCOME: TaxIncome = { wages: 0, pretaxWithdrawals: 0, conversions: 0, interest: 0, qualified: 0, socialSecurity: 0 };

// Non-finite or negative amounts are treated as 0, so nothing downstream goes NaN.
const nn = (v: number) => (Number.isFinite(v) && v > 0 ? v : 0);

// Tax on `taxable` ordinary income through a bracket schedule (sum of each slice
// times its rate).
export function bracketTax(taxable: number, brackets: Bracket[]): number {
  const t = nn(taxable);
  let tax = 0;
  for (let i = 0; i < brackets.length; i++) {
    const lo = brackets[i].from;
    const hi = i + 1 < brackets.length ? brackets[i + 1].from : Infinity;
    if (t <= lo) break;
    tax += (Math.min(t, hi) - lo) * brackets[i].rate;
  }
  return tax;
}

// Index of the bracket the LAST dollar of `taxable` sits in. A bracket covers
// (from, nextFrom] — "over $X but not over $Y" — so income exactly at a boundary
// is still in the lower bracket with no room left. Zero income sits in the first.
export function bracketIndex(taxable: number, brackets: Bracket[]): number {
  const t = nn(taxable);
  let idx = 0;
  for (let i = 1; i < brackets.length; i++) if (t > brackets[i].from) idx = i;
  return idx;
}

// Top of the bracket taxed at `rate` (the next bracket's start), or null when
// `rate` is the top bracket or not in the schedule.
export function bracketTop(brackets: Bracket[], rate: number): number | null {
  const i = brackets.findIndex(b => Math.abs(b.rate - rate) < 1e-9);
  if (i < 0 || i + 1 >= brackets.length) return null;
  return brackets[i + 1].from;
}

// Taxable ordinary income that still fits under the top of the `rate` bracket
// (0 when already past it; null when that bracket has no top).
export function roomToBracketTop(ordinaryTaxable: number, brackets: Bracket[], rate: number): number | null {
  const top = bracketTop(brackets, rate);
  return top == null ? null : Math.max(0, top - nn(ordinaryTaxable));
}

// Per-bracket view of ordinary taxable income: how much of each bracket is filled
// and how much is still open (null for the open-ended top bracket).
export interface BracketSlice { rate: number; from: number; to: number | null; filled: number; open: number | null; tax: number }
export function bracketFill(ordinaryTaxable: number, brackets: Bracket[]): BracketSlice[] {
  const t = nn(ordinaryTaxable);
  return brackets.map((b, i) => {
    const to = i + 1 < brackets.length ? brackets[i + 1].from : null;
    const filled = Math.max(0, Math.min(t, to ?? Infinity) - b.from);
    return { rate: b.rate, from: b.from, to, filled, open: to == null ? null : Math.max(0, to - b.from - filled), tax: filled * b.rate };
  });
}

// Taxable share of Social Security benefits — IRS Publication 915, Worksheet 1.
// Provisional income = other income + half the benefits. Over the base amount,
// half of each extra dollar becomes taxable (capped at half the benefits); over
// the second tier, 85 cents of each extra dollar, all capped at 85% of benefits.
export function taxableSocialSecurity(benefits: number, otherIncome: number, p: Pick<YearTaxParams, 'ssBase' | 'ssSecond'>): { taxable: number; provisional: number } {
  const b = nn(benefits);
  const provisional = nn(otherIncome) + 0.5 * b;
  if (b <= 0) return { taxable: 0, provisional };
  const line10 = provisional - p.ssBase;                 // over the base amount
  if (line10 <= 0) return { taxable: 0, provisional };
  const line11 = p.ssSecond - p.ssBase;                  // $9,000 single / $12,000 joint
  const line12 = Math.max(0, line10 - line11);           // over the second tier
  const line15 = Math.min(0.5 * b, 0.5 * Math.min(line10, line11));
  const taxable = Math.min(line15 + 0.85 * line12, 0.85 * b);
  return { taxable, provisional };
}

export interface FederalTaxResult {
  grossIncome: number;        // every dollar received, before any exclusion (all of SS)
  provisionalIncome: number;
  taxableSocialSecurity: number;
  agi: number;                // also used as MAGI (no tax-exempt interest modelled)
  deduction: number;          // standard + age-65 extra + senior deduction
  seniorDeduction: number;
  taxableIncome: number;
  ordinaryTaxable: number;    // taxable income less the gains stacked on top
  qualifiedTaxable: number;
  ordinaryTax: number;
  gainsTax: number;
  gainsAt0: number; gainsAt15: number; gainsAt20: number;
  niit: number;
  total: number;              // ordinary + gains tax + NIIT
  bracketRate: number;        // statutory rate of the bracket ordinary income ends in
  bracketIndex: number;
  roomInBracket: number | null; // taxable ordinary income left before the next bracket (null at the top)
  effectiveRate: number;      // total / gross income (0 when there is no income)
}

export function federalTax(inc: TaxIncome, hh: TaxHousehold, p: YearTaxParams): FederalTaxResult {
  const wages = nn(inc.wages), pre = nn(inc.pretaxWithdrawals), conv = nn(inc.conversions);
  const interest = nn(inc.interest), qualified = nn(inc.qualified), ss = nn(inc.socialSecurity);
  const people = Math.max(0, Math.min(hh.status === 'joint' ? 2 : 1, Math.floor(nn(hh.age65Count))));

  const other = wages + pre + conv + interest + qualified;
  const { taxable: taxableSS, provisional } = taxableSocialSecurity(ss, other, p);
  const agi = other + taxableSS;

  // Senior deduction (2025–2028): each 65+ person's $6,000 shrinks by 6% of MAGI
  // over the threshold (Schedule 1-A lines 31–35), floored at zero.
  const seniorEach = p.senior ? Math.max(0, p.senior.perPerson - p.senior.phaseOutRate * Math.max(0, agi - p.senior.phaseOutStart)) : 0;
  const seniorDeduction = seniorEach * people;
  const deduction = p.standardDeduction + p.additional65 * people + seniorDeduction;

  const taxableIncome = Math.max(0, agi - deduction);
  // Gains and qualified dividends sit on TOP of ordinary income: the deduction
  // soaks up ordinary income first, and the gains' 0/15/20% rate depends on
  // where they land once stacked above it.
  const ordinaryTaxable = Math.max(0, taxableIncome - qualified);
  const qualifiedTaxable = taxableIncome - ordinaryTaxable;
  const ordinaryTax = bracketTax(ordinaryTaxable, p.brackets);
  const gainsAt0 = Math.max(0, Math.min(taxableIncome, p.ltcgZeroMax) - ordinaryTaxable);
  const gainsAt15 = Math.max(0, Math.min(taxableIncome, p.ltcgFifteenMax) - Math.max(ordinaryTaxable, p.ltcgZeroMax));
  const gainsAt20 = Math.max(0, qualifiedTaxable - gainsAt0 - gainsAt15);
  const gainsTax = 0.15 * gainsAt15 + 0.20 * gainsAt20;

  // NIIT: 3.8% of the smaller of investment income or MAGI over the threshold.
  // Wages, retirement withdrawals, conversions and Social Security are not
  // investment income (though they push MAGI up).
  const niit = p.niitRate * Math.min(interest + qualified, Math.max(0, agi - p.niitThreshold));

  const total = ordinaryTax + gainsTax + niit;
  const bi = bracketIndex(ordinaryTaxable, p.brackets);
  const grossIncome = other + ss;
  return {
    grossIncome, provisionalIncome: provisional, taxableSocialSecurity: taxableSS, agi,
    deduction, seniorDeduction, taxableIncome, ordinaryTaxable, qualifiedTaxable,
    ordinaryTax, gainsTax, gainsAt0, gainsAt15, gainsAt20, niit, total,
    bracketRate: p.brackets[bi].rate, bracketIndex: bi,
    roomInBracket: bi + 1 < p.brackets.length ? Math.max(0, p.brackets[bi + 1].from - ordinaryTaxable) : null,
    effectiveRate: grossIncome > 0 ? total / grossIncome : 0,
  };
}

// The rate actually paid on the NEXT ordinary dollar (e.g. one more dollar of
// IRA withdrawal), measured over a $100 step. It differs from the bracket rate
// when that dollar also makes more Social Security taxable, pushes gains out of
// the 0% zone, trims the senior deduction or adds NIIT.
export function marginalRate(inc: TaxIncome, hh: TaxHousehold, p: YearTaxParams, step = 100): number {
  const a = federalTax(inc, hh, p).total;
  const b = federalTax({ ...inc, pretaxWithdrawals: nn(inc.pretaxWithdrawals) + step }, hh, p).total;
  return (b - a) / step;
}

// Largest extra ORDINARY income (a withdrawal or conversion) that keeps `measure`
// at or under `cap`. `measure` must not fall as income rises (taxable income and
// MAGI both qualify). Bisection to within $1 — the relation is piecewise linear
// but its slope changes with the Social Security phase-in and senior phase-out.
function extraOrdinaryUnder(inc: TaxIncome, hh: TaxHousehold, p: YearTaxParams, cap: number,
  measure: (r: FederalTaxResult) => number): number {
  const at = (x: number) => measure(federalTax({ ...inc, conversions: nn(inc.conversions) + x }, hh, p));
  if (!Number.isFinite(cap) || at(0) >= cap) return 0;
  // Each extra dollar raises the measure by at least $1 once the deduction is
  // used up, so cap − measure(0) + deduction is a safe upper bound.
  let lo = 0, hi = Math.max(1, cap - at(0) + p.standardDeduction + p.additional65 * 2 + (p.senior?.perPerson ?? 0) * 2);
  if (at(hi) <= cap) return hi;
  for (let k = 0; k < 60 && hi - lo > 0.5; k++) {
    const mid = (lo + hi) / 2;
    if (at(mid) <= cap) lo = mid; else hi = mid;
  }
  return lo;
}

// Extra ordinary income that fits before ordinary taxable income passes the top of
// the `rate` bracket. Null when that bracket has no top.
export function ordinaryRoomToRate(inc: TaxIncome, hh: TaxHousehold, p: YearTaxParams, rate: number): number | null {
  const top = bracketTop(p.brackets, rate);
  if (top == null) return null;
  return extraOrdinaryUnder(inc, hh, p, top, r => r.ordinaryTaxable);
}

// Extra ordinary income that fits before MAGI passes `magiCap`.
export function ordinaryRoomToMagi(inc: TaxIncome, hh: TaxHousehold, p: YearTaxParams, magiCap: number): number {
  return extraOrdinaryUnder(inc, hh, p, magiCap, r => r.agi);
}

// --- Medicare income-related surcharge (IRMAA) ---------------------------------

export interface IrmaaResult {
  tier: number;                 // 0 = no surcharge
  partB: number; partD: number; // monthly surcharge per enrollee
  annualPerPerson: number;
  nextOver: number | null;      // where the next tier starts (null at the top)
  roomToNext: number | null;    // MAGI that can still be added without entering it
  ceiling: number | null;       // highest MAGI that stays in this tier
}

// Tier for a MAGI, given the tiers of the premium year it will set. A tier with
// `atLeast` starts AT its amount; the rest start just above it, so MAGI exactly
// at a threshold stays in the lower tier.
export function irmaaTier(magi: number, tiers: IrmaaTier[]): IrmaaResult {
  const m = nn(magi);
  let tier = 0;
  for (let i = 1; i < tiers.length; i++) {
    const t = tiers[i];
    if (t.atLeast ? m >= t.over : m > t.over) tier = i;
  }
  const cur = tiers[tier], next = tiers[tier + 1];
  // Highest MAGI still in this tier: the next tier's amount itself (exclusive
  // start), or one dollar under it when the next tier starts AT its amount.
  const ceiling = next ? (next.atLeast ? next.over - 1 : next.over) : null;
  return {
    tier, partB: cur.partB, partD: cur.partD,
    annualPerPerson: (cur.partB + cur.partD) * 12,
    nextOver: next ? next.over : null,
    roomToNext: ceiling == null ? null : Math.max(0, ceiling - m),
    ceiling,
  };
}

// --- Payroll tax (employee share) ----------------------------------------------

// Social Security tax on each earner's wages up to the wage base, Medicare on all
// wages, plus the 0.9% Additional Medicare Tax on household wages over the
// filing-status threshold. Uses GROSS wages: 401(k) deferrals are still subject.
export function payrollTax(wagesByEarner: number[], p: YearTaxParams): number {
  const pr = p.payroll;
  let ss = 0, total = 0;
  for (const w of wagesByEarner) { const x = nn(w); ss += pr.ssRate * Math.min(x, pr.wageBase); total += x; }
  return ss + pr.medicareRate * total + pr.addlRate * Math.max(0, total - pr.addlThreshold);
}
