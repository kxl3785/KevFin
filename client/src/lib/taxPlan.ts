import type { SimTaxSettings, SimTaxYear } from './forecastSim.ts';
import { taxParamsFor, irmaaTiersFor, IRMAA_LOOKBACK_YEARS, type FilingStatus } from './taxTables.ts';
import { federalTax, bracketFill, irmaaTier, marginalRate, ordinaryRoomToRate, type TaxIncome } from './taxCalc.ts';

// The Forecast's tax-model settings as saved in the browser/prefs store under
// `mon.fcTaxPlan` — a key of its own, kept out of `mon.fcAssumptions` so the AI
// assistant (which ships fcAssumptions with each chat) never receives it.
// Everything defaults to off: 'flat' mode is the original model, unchanged.

export interface TaxPlan {
  mode: 'flat' | 'brackets';
  filing: 'auto' | FilingStatus;   // auto → joint when the second earner is on
  stateRate: number;               // flat state income-tax rate, fraction
  convOn: boolean;                 // Roth conversions (brackets mode only)
  convStartAge: number | null;     // null → the primary earner's retirement age
  convEndAge: number;
  convRate: number;                // fill up to the top of this bracket
  convIrmaaCap: boolean;           // stop before the next Medicare surcharge tier
}

export const DEFAULT_TAX_PLAN: TaxPlan = {
  mode: 'flat', filing: 'auto', stateRate: 0,
  convOn: false, convStartAge: null, convEndAge: 72, convRate: 0.22, convIrmaaCap: true,
};

// Brackets a conversion can fill to the top of (37% has no top).
export const CONVERSION_RATES = [0.10, 0.12, 0.22, 0.24, 0.32, 0.35];

const num = (v: unknown, lo: number, hi: number, dflt: number) =>
  (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt);

// Repair a stored plan field by field: missing fields (older saves) and junk
// (hand-edited or a different schema) fall back to the defaults.
export function normalizeTaxPlan(raw: unknown): TaxPlan {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_TAX_PLAN;
  return {
    mode: r.mode === 'brackets' ? 'brackets' : 'flat',
    filing: r.filing === 'single' || r.filing === 'joint' ? r.filing : 'auto',
    stateRate: num(r.stateRate, 0, 0.2, d.stateRate),
    convOn: typeof r.convOn === 'boolean' ? r.convOn : d.convOn,
    convStartAge: r.convStartAge == null ? null : num(r.convStartAge, 18, 120, 0) || null,
    convEndAge: num(r.convEndAge, 18, 120, d.convEndAge),
    convRate: CONVERSION_RATES.includes(r.convRate as number) ? (r.convRate as number) : d.convRate,
    convIrmaaCap: typeof r.convIrmaaCap === 'boolean' ? r.convIrmaaCap : d.convIrmaaCap,
  };
}

export function resolveFiling(plan: TaxPlan, twoEarners: boolean): FilingStatus {
  return plan.filing === 'auto' ? (twoEarners ? 'joint' : 'single') : plan.filing;
}

// The simulation's tax settings for a plan, or undefined in flat mode (so the sim
// input — and every number — is exactly what it was before this feature). Without
// `retireAge`, a blank conversion start stays null and the sim resolves it to
// earner 0's retirement age in whatever input it runs, so the Retire lever and the
// solver's retirement shifts move the window too — the Forecast page does this.
// Passing `retireAge` pins a blank start to that age instead (the older behaviour).
export function simTaxFor(plan: TaxPlan, opts: { twoEarners: boolean; retireAge?: number }): SimTaxSettings | undefined {
  if (plan.mode !== 'brackets') return undefined;
  const startAge = plan.convStartAge ?? opts.retireAge ?? null;
  return {
    mode: 'brackets',
    filing: resolveFiling(plan, opts.twoEarners),
    stateRate: plan.stateRate,
    conversions: plan.convOn
      ? { startAge, endAge: startAge == null ? plan.convEndAge : Math.max(startAge, plan.convEndAge), bracketRate: plan.convRate, irmaaCap: plan.convIrmaaCap }
      : null,
  };
}

// Full tax picture for one simulated year (nominal dollars), rebuilt from the
// sim's record with the same tables, so it matches the tax the sim charged.
// The Medicare tier is the one this year's income sets for premiums two years on
// (its surcharge amounts are in that premium year's dollars). `roomAtRate` is the
// extra ordinary income — a withdrawal or Roth conversion — that still fits before
// ordinary taxable income passes the top of the current bracket, counting unused
// deduction and the Social Security a withdrawal makes taxable (null at the top).
export function taxYearDetail(rec: SimTaxYear, infl: number) {
  const params = taxParamsFor(rec.year, rec.status, infl);
  const income: TaxIncome = {
    wages: rec.wages, pretaxWithdrawals: rec.rmd + rec.pretaxDraw, conversions: rec.conversion,
    interest: 0, qualified: rec.gains, socialSecurity: rec.socialSecurity,
  };
  const hh = { status: rec.status, age65Count: rec.age65Count };
  const result = federalTax(income, hh, params);
  const premiumYear = rec.year + IRMAA_LOOKBACK_YEARS;
  return {
    params, income, result,
    roomAtRate: ordinaryRoomToRate(income, hh, params, result.bracketRate),
    fill: bracketFill(result.ordinaryTaxable, params.brackets),
    marginal: marginalRate(income, hh, params),
    premiumYear,
    irmaa: irmaaTier(result.agi, irmaaTiersFor(premiumYear, rec.status, infl)),
  };
}
