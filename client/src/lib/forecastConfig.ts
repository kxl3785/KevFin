// Shared Forecast constants. Both the Forecast page (which runs the simulation)
// and the FAQ (which describes it) read MONTE_CARLO_RUNS from here, so the
// stated run count can never drift from the actual one — change it once, here.
export const MONTE_CARLO_RUNS = 400;

// --- The saved plan's inputs ---------------------------------------------------
// The shapes and defaults of the Forecast inputs, persisted in the browser under
// `mon.fcAssumptions` and `mon.fcEarners`. They live here rather than in the
// Forecast page because the AI assistant edits the same saved plan when the user
// applies a change it proposed (lib/forecastEdit.ts) — both must agree on what a
// plan with nothing saved yet looks like.

export interface Earner {
  label: string;
  enabled: boolean;          // earner 0 is always on; this gates earner 1
  currentAge: number;        // earner 1's age (earner 0 uses Assumptions.currentAge)
  income: number;            // gross, today's $
  raisePct: number;          // annual real raise (above inflation), e.g. 0.02 = +2%/yr
  retireAge: number;
  // Employer match/profit-sharing, today's $/yr — added straight to the pre-tax
  // pool while this earner works (not their cash, not their deduction). The
  // employee's own contributions are set per account, not here. Deliberately a
  // NEW field name: old persisted state carries a never-editable `employer`
  // default that must not silently start counting.
  employerMatch?: number;
  // Legacy per-earner contribution fields — superseded by the per-account
  // contributions ("Accounts & contributions"); kept so persisted state parses.
  pretax?: number;
  employer?: number;
  roth?: number;
  hsa?: number;
  ssEnabled: boolean; ssClaimAge: number; ssAnnual: number; // Social Security, today's $/yr
}

export interface Assumptions {
  currentAge: number; endAge: number;
  investReturn: number; volatility: number; realEstateGrowth: number; inflation: number;
  // Annual growth of the real-estate carrying costs (property tax / insurance / HOA)
  // and of any rental/income the property generates.
  propertyTaxGrowth: number; insuranceGrowth: number; hoaGrowth: number; rentalGrowth: number;
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

export const DEFAULT_ASSUMPTIONS: Assumptions = {
  currentAge: 40, endAge: 90, investReturn: 0.07, volatility: 0.15, realEstateGrowth: 0.04, inflation: 0.03,
  propertyTaxGrowth: 0.02, insuranceGrowth: 0.04, hoaGrowth: 0.03, rentalGrowth: 0.03,
  annualSpending: 70000, costPerKid: 18000, kidIndependentAge: 22,
  effTaxRate: 0.24, retireTaxRate: 0.15,
  limitGrowth: 0.02,
  collegeCostPerYear: 30000, collegeYears: 4, collegeStartAge: 18, eduInflation: 0.05,
  gradCostPerYear: 40000, gradYears: 2, gradStartAge: 22, gradCoverage: 0.5,
};

export const DEFAULT_EARNERS: Earner[] = [
  { label: 'You', enabled: true, currentAge: 40, income: 180000, raisePct: 0.02, retireAge: 65, employerMatch: 12000, ssEnabled: true, ssClaimAge: 67, ssAnnual: 36000 },
  { label: 'Partner', enabled: false, currentAge: 38, income: 120000, raisePct: 0.02, retireAge: 65, employerMatch: 8000, ssEnabled: true, ssClaimAge: 67, ssAnnual: 30000 },
];

// Pad a persisted earners list up to the defaults' length (and replace non-object
// entries), returning the same reference when nothing needs fixing.
export function padEarners(list: Earner[]): Earner[] {
  const ok = list.length >= DEFAULT_EARNERS.length && list.every(e => e && typeof e === 'object');
  if (ok) return list;
  const out = list.map((e, i) => (e && typeof e === 'object' ? e : DEFAULT_EARNERS[i] ?? DEFAULT_EARNERS[0]));
  for (let i = out.length; i < DEFAULT_EARNERS.length; i++) out.push(DEFAULT_EARNERS[i]);
  return out;
}
