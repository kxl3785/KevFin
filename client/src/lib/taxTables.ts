// US federal tax tables for the Forecast's bracket-based tax model (opt-in; see
// taxCalc.ts and forecastSim.ts). Pure data plus a resolver that picks the right
// year's figures — no React, no I/O, no network: every figure is typed in here
// from the official source named beside it, retrieved 2026-11-24.
//
// Years past the last published table: thresholds the law indexes grow with the
// plan's inflation from that table (so they hold steady in today's dollars).
// Thresholds the law fixes in dollars — the net investment income tax, the Social
// Security benefit-taxation base amounts, the Additional Medicare Tax and the
// 2025–2028 senior deduction — stay at their nominal amounts. Years before the
// first table use the first table as-is.
//
// Left out entirely (not modelled anywhere): state brackets (a flat state rate is
// used instead), the alternative minimum tax, credits (child tax credit etc.),
// itemised deductions, ACA premium subsidies, and estate/gift tax.

export type FilingStatus = 'single' | 'joint';

// One ordinary-income bracket: `rate` applies to taxable income above `from`
// (the table's "Over $X" line) up to the next bracket's `from`.
export interface Bracket { rate: number; from: number }

export interface FederalTaxTable {
  year: number;
  brackets: Record<FilingStatus, Bracket[]>;
  standardDeduction: Record<FilingStatus, number>;
  // Additional standard deduction per person aged 65+ (§ 63(f)). The joint
  // figure is per qualifying spouse; the single figure is the higher
  // "unmarried" amount.
  additional65: Record<FilingStatus, number>;
  // Long-term capital gain / qualified dividend breakpoints (§ 1(h)): taxable
  // income up to zeroMax is the 0% zone, up to fifteenMax the 15% zone, above 20%.
  ltcg: Record<FilingStatus, { zeroMax: number; fifteenMax: number }>;
}

// Tax year 2026 — Rev. Proc. 2025-32 (https://www.irs.gov/pub/irs-drop/rp-25-32.pdf),
// § 4 ("2026 Adjusted Items"): § 4.01 Tables 1 and 3, § 4.03 (capital gains),
// § 4.14(1) and (3) (standard deduction, aged or blind). Brackets and standard deduction also match IRS news release
// IR-2025-103 (Oct. 9, 2025).
const TY2026: FederalTaxTable = {
  year: 2026,
  brackets: {
    single: [
      { rate: 0.10, from: 0 }, { rate: 0.12, from: 12400 }, { rate: 0.22, from: 50400 },
      { rate: 0.24, from: 105700 }, { rate: 0.32, from: 201775 }, { rate: 0.35, from: 256225 },
      { rate: 0.37, from: 640600 },
    ],
    joint: [
      { rate: 0.10, from: 0 }, { rate: 0.12, from: 24800 }, { rate: 0.22, from: 100800 },
      { rate: 0.24, from: 211400 }, { rate: 0.32, from: 403550 }, { rate: 0.35, from: 512450 },
      { rate: 0.37, from: 768700 },
    ],
  },
  standardDeduction: { single: 16100, joint: 32200 },
  additional65: { single: 2050, joint: 1650 },
  ltcg: { single: { zeroMax: 49450, fifteenMax: 545500 }, joint: { zeroMax: 98900, fifteenMax: 613700 } },
};

// Tax year 2027 — Rev. Proc. 2026-35 (https://www.irs.gov/pub/irs-drop/rp-26-35.pdf),
// § 3.01 Tables 1 and 3, § 3.03, § 3.15. Brackets and standard deduction also
// match IRS news release IR-2026-133 (Nov. 5, 2026).
const TY2027: FederalTaxTable = {
  year: 2027,
  brackets: {
    single: [
      { rate: 0.10, from: 0 }, { rate: 0.12, from: 12800 }, { rate: 0.22, from: 52025 },
      { rate: 0.24, from: 109125 }, { rate: 0.32, from: 208325 }, { rate: 0.35, from: 264550 },
      { rate: 0.37, from: 661375 },
    ],
    joint: [
      { rate: 0.10, from: 0 }, { rate: 0.12, from: 25600 }, { rate: 0.22, from: 104050 },
      { rate: 0.24, from: 218250 }, { rate: 0.32, from: 416650 }, { rate: 0.35, from: 529100 },
      { rate: 0.37, from: 793650 },
    ],
  },
  standardDeduction: { single: 16600, joint: 33200 },
  additional65: { single: 2100, joint: 1700 },
  ltcg: { single: { zeroMax: 51050, fifteenMax: 563200 }, joint: { zeroMax: 102100, fifteenMax: 633600 } },
};

export const FEDERAL_TABLES: FederalTaxTable[] = [TY2026, TY2027];
export const FIRST_TABLE_YEAR = TY2026.year;
export const LAST_TABLE_YEAR = TY2027.year;

// Net investment income tax (§ 1411): 3.8% of the smaller of net investment
// income or MAGI over the threshold. IRS "Questions and Answers on the Net
// Investment Income Tax" (irs.gov/newsroom/questions-and-answers-on-the-net-investment-income-tax):
// "these threshold amounts are not indexed for inflation". Fixed nominal.
export const NIIT = { rate: 0.038, threshold: { single: 200000, joint: 250000 } as Record<FilingStatus, number> };

// Social Security benefit taxation (provisional income), IRS Publication 915
// (2026), Worksheet 1: base amount $25,000 single / $32,000 joint (line 9); the
// second tier sits $9,000 / $12,000 above it (line 11), i.e. $34,000 / $44,000.
// Up to 50% of benefits are taxable over the base, up to 85% over the second
// tier. Statutory amounts, not indexed — fixed nominal.
export const SS_TAXATION = {
  base: { single: 25000, joint: 32000 } as Record<FilingStatus, number>,
  second: { single: 34000, joint: 44000 } as Record<FilingStatus, number>,
};

// Enhanced deduction for seniors, tax years 2025–2028 only: $6,000 per person 65+,
// reduced by 6% of MAGI over $75,000 ($150,000 joint). 2025 Schedule 1-A (Form
// 1040) Part V lines 31–37 (irs.gov/pub/irs-pdf/f1040s1a.pdf); years and amounts
// also on irs.gov/newsroom/2026-filing-season-updates-and-resources-for-seniors.
// Not indexed — fixed nominal, and gone from 2029.
export const SENIOR_DEDUCTION = {
  firstYear: 2025, lastYear: 2028, perPerson: 6000, phaseOutRate: 0.06,
  phaseOutStart: { single: 75000, joint: 150000 } as Record<FilingStatus, number>,
};

// Payroll (FICA) tax on wages, employee share. Social Security wage base by year:
//   2026: $184,500 — IRS Publication 15 (2026), "What's New" (irs.gov/publications/p15),
//         which also gives both rates.
//   2027: $192,300 — SSA notice, Federal Register document 2026-21796 (Oct. 26, 2026):
//         "The OASDI contribution and benefit base is $192,300 for remuneration paid
//         in 2027".
// Later years grow the last published base with the plan's inflation (the real base
// follows average wages, so that part is approximate); earlier years use the first.
// Additional Medicare Tax 0.9% over $200,000 / $250,000: IRS Topic 560
// (irs.gov/taxtopics/tc560); fixed dollar amounts, held nominal.
export const PAYROLL = {
  ssRate: 0.062, medicareRate: 0.0145,
  wageBases: [{ year: 2026, base: 184500 }, { year: 2027, base: 192300 }],
  addlMedicareRate: 0.009, addlMedicareThreshold: { single: 200000, joint: 250000 } as Record<FilingStatus, number>,
};

// The Social Security wage base for a calendar year (see PAYROLL).
export function wageBaseFor(year: number, infl: number): number {
  let b = PAYROLL.wageBases[0];
  for (const x of PAYROLL.wageBases) if (x.year <= year) b = x;
  return b.base * growthFactor(year, b.year, infl);
}

// Medicare income-related monthly adjustment amounts (IRMAA), per enrollee per
// month, by PREMIUM year. Premiums for year Y are set from MAGI on the tax return
// from two years earlier (Y − 2): medicare.gov/node/38266 ("your IRS tax return
// from 2 years ago"). A tier applies when MAGI is GREATER than its `over`
// amount, except the top tier, which applies at or above it (`atLeast`).
//   2026: CMS fact sheet "2026 Medicare Parts A & B Premiums and Deductibles"
//         (Nov. 14, 2025), cms.gov/newsroom/fact-sheets/2026-medicare-parts-b-premiums-deductibles
//   2027: CMS fact sheet "2027 Medicare Parts A & B Premiums and Deductibles"
//         (Nov. 17, 2026), cms.gov/newsroom/fact-sheets/2027-medicare-parts-b-premiums-deductibles
// Later premium years grow every threshold and surcharge with the plan's inflation.
export interface IrmaaTier { over: number; atLeast?: boolean; partB: number; partD: number }
export interface IrmaaTable { year: number; tiers: Record<FilingStatus, IrmaaTier[]> }

const IRMAA_2026: IrmaaTable = {
  year: 2026,
  tiers: {
    single: [
      { over: 0, partB: 0, partD: 0 },
      { over: 109000, partB: 81.20, partD: 14.50 },
      { over: 137000, partB: 202.90, partD: 37.50 },
      { over: 171000, partB: 324.60, partD: 60.40 },
      { over: 205000, partB: 446.30, partD: 83.30 },
      { over: 500000, atLeast: true, partB: 487.00, partD: 91.00 },
    ],
    joint: [
      { over: 0, partB: 0, partD: 0 },
      { over: 218000, partB: 81.20, partD: 14.50 },
      { over: 274000, partB: 202.90, partD: 37.50 },
      { over: 342000, partB: 324.60, partD: 60.40 },
      { over: 410000, partB: 446.30, partD: 83.30 },
      { over: 750000, atLeast: true, partB: 487.00, partD: 91.00 },
    ],
  },
};
const IRMAA_2027: IrmaaTable = {
  year: 2027,
  tiers: {
    single: [
      { over: 0, partB: 0, partD: 0 },
      { over: 112000, partB: 83.70, partD: 15.40 },
      { over: 141000, partB: 209.40, partD: 39.70 },
      { over: 177000, partB: 335.00, partD: 64.00 },
      { over: 212000, partB: 460.60, partD: 88.30 },
      { over: 500000, atLeast: true, partB: 502.40, partD: 96.40 },
    ],
    joint: [
      { over: 0, partB: 0, partD: 0 },
      { over: 224000, partB: 83.70, partD: 15.40 },
      { over: 282000, partB: 209.40, partD: 39.70 },
      { over: 354000, partB: 335.00, partD: 64.00 },
      { over: 424000, partB: 460.60, partD: 88.30 },
      { over: 750000, atLeast: true, partB: 502.40, partD: 96.40 },
    ],
  },
};
export const IRMAA_TABLES: IrmaaTable[] = [IRMAA_2026, IRMAA_2027];
export const IRMAA_LOOKBACK_YEARS = 2;

// --- Resolving a calendar year ------------------------------------------------

// Everything taxCalc needs for one filing status in one calendar year.
export interface YearTaxParams {
  year: number;            // the calendar (tax) year asked for
  tableYear: number;       // the published table it derives from
  growth: number;          // inflation factor applied to indexed amounts (1 = as published)
  status: FilingStatus;
  brackets: Bracket[];
  standardDeduction: number;
  additional65: number;
  ltcgZeroMax: number; ltcgFifteenMax: number;
  niitRate: number; niitThreshold: number;
  ssBase: number; ssSecond: number;
  // Null outside 2025–2028.
  senior: { perPerson: number; phaseOutStart: number; phaseOutRate: number } | null;
  payroll: { ssRate: number; medicareRate: number; wageBase: number; addlRate: number; addlThreshold: number };
}

// Inflation factor from `fromYear` to `year` at `infl` (1 when not after it).
// A non-finite or below −100% inflation is treated as 0 so nothing goes NaN.
function growthFactor(year: number, fromYear: number, infl: number): number {
  const r = Number.isFinite(infl) && infl > -1 ? infl : 0;
  return year > fromYear ? Math.pow(1 + r, year - fromYear) : 1;
}

function tableFor(year: number): FederalTaxTable {
  let t = FEDERAL_TABLES[0];
  for (const x of FEDERAL_TABLES) if (x.year <= year) t = x;
  return t;
}

export function taxParamsFor(year: number, status: FilingStatus, infl: number): YearTaxParams {
  const t = tableFor(year);
  const g = growthFactor(year, t.year, infl);
  const seniorOn = year >= SENIOR_DEDUCTION.firstYear && year <= SENIOR_DEDUCTION.lastYear;
  return {
    year, tableYear: t.year, growth: g, status,
    brackets: t.brackets[status].map(b => ({ rate: b.rate, from: b.from * g })),
    standardDeduction: t.standardDeduction[status] * g,
    additional65: t.additional65[status] * g,
    ltcgZeroMax: t.ltcg[status].zeroMax * g,
    ltcgFifteenMax: t.ltcg[status].fifteenMax * g,
    niitRate: NIIT.rate, niitThreshold: NIIT.threshold[status],
    ssBase: SS_TAXATION.base[status], ssSecond: SS_TAXATION.second[status],
    senior: seniorOn ? {
      perPerson: SENIOR_DEDUCTION.perPerson,
      phaseOutStart: SENIOR_DEDUCTION.phaseOutStart[status],
      phaseOutRate: SENIOR_DEDUCTION.phaseOutRate,
    } : null,
    payroll: {
      ssRate: PAYROLL.ssRate, medicareRate: PAYROLL.medicareRate,
      wageBase: wageBaseFor(year, infl),
      addlRate: PAYROLL.addlMedicareRate, addlThreshold: PAYROLL.addlMedicareThreshold[status],
    },
  };
}

// IRMAA tiers for a PREMIUM year (not the income year: income in year Y sets the
// premiums of Y + IRMAA_LOOKBACK_YEARS).
export function irmaaTiersFor(premiumYear: number, status: FilingStatus, infl: number): IrmaaTier[] {
  let t = IRMAA_TABLES[0];
  for (const x of IRMAA_TABLES) if (x.year <= premiumYear) t = x;
  const g = growthFactor(premiumYear, t.year, infl);
  return t.tiers[status].map(x => ({ ...x, over: x.over * g, partB: x.partB * g, partD: x.partD * g }));
}

// Which published tax year a calendar year's figures come from, for the UI's
// "tables in use" line.
export function tableYearFor(year: number): number { return tableFor(year).year; }
