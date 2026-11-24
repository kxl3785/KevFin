// Shared REST response shapes, imported by BOTH sides of the API boundary:
// the server (route/service return types) and the client (via the `@shared`
// alias — see client/tsconfig.json and client/vite.config.ts). Adding a field
// here is the one place that keeps the two in sync; before this file the
// client hand-copied these interfaces and drifted (e.g. SQLite's 0/1 booleans
// leaking into the UI as numbers).
//
// Type-only module: `import type` on both sides, nothing at runtime.

export interface Snapshot {
  date: string;
  accounts_total: number;
  real_estate_total: number;
  net_worth: number;
}

export type AccountCategory = 'banking' | 'brokerage' | 'credit' | 'other';

export interface Account {
  id: string;
  org_name: string;
  name: string;
  renamed: boolean; // custom display name set (converted from SQLite 0/1 at the route layer)
  balance: number;
  currency: string;
  category: AccountCategory;
  hidden: boolean; // excluded from net worth (converted from SQLite 0/1 at the route layer)
  updated_at: string;
}

export interface ManualAsset {
  id: number;
  name: string;
  category: AccountCategory;
  value: number;
  // Annual growth/interest rate (percent). null = no rate set; the Forecast then
  // leaves this asset in the volatile investment pool (legacy behavior).
  interest_rate: number | null;
  updated_at: string;
}

export interface Property {
  id: number;
  address: string;
  zestimate: number | null;
  mortgage_balance: number;
  // Amortization inputs — when principal + rate + start are set, mortgage_balance
  // is computed from a standard schedule server-side instead of entered manually.
  mortgage_principal: number | null;
  mortgage_rate: number | null;
  mortgage_start: string | null;
  mortgage_term_years: number | null;
  // Recurring carrying costs (annual $). Informational on the dashboard; drive the
  // Budget housing breakdown and the Forecast's modeled housing outflow.
  property_tax_annual: number | null;
  insurance_annual: number | null;
  hoa_annual: number | null;
  rental_income_annual: number | null; // income the property generates (e.g. rent)
  updated_at: string;
}

export interface Breakdown {
  accounts: Account[];
  manualAssets: ManualAsset[];
  properties: Property[];
}

export interface Connection {
  id: number;
  account_count: number;
  institutions: string;
  created_at: string;
}

export interface PlaidItem {
  item_id: string;
  institution_name: string;
  account_count: number;
  created_at: string;
}

// ---- GET /api/performance/returns (contribution-aware returns + income) ----
// Built by server/src/services/investmentReturns.ts. Returns are fractions
// (0.1 = 10%); null means "not measurable", never a guessed number.

export interface ReturnsMeasure {
  periodReturn: number | null;  // cumulative over the measured span
  annualized: number | null;    // only for spans over a year
  days?: number;                // the span this figure covers (an account that starts empty counts from its first deposit)
}

export interface ReturnsFlow {
  id: string;                   // transaction id (the include/exclude override key)
  accountId: string;
  accountName: string;
  date: string;
  amount: number;               // + deposit, − withdrawal
  description: string;
  basis: 'matched' | 'guessed'; // guessed = description not recognised
  included: boolean;
  overridden: boolean;
}

export interface ReturnsAccount {
  id: string;
  name: string;
  institution: string;
  balance: number;
  included: boolean;
  reason: string | null;        // plain-language reason when left out
  measuredFrom: string | null;
  measuredTo: string | null;
  days: number;
  timeWeighted: ReturnsMeasure; // "your return, deposits removed"
  moneyWeighted: ReturnsMeasure;// "return on your dollars"
  deposits: number;
  withdrawals: number;          // positive number
  gain: number | null;          // end − start − (deposits − withdrawals)
}

export interface ReturnsTotal {
  measuredFrom: string;
  measuredTo: string;
  days: number;
  timeWeighted: ReturnsMeasure;
  moneyWeighted: ReturnsMeasure;
  startValue: number;
  endValue: number;
  deposits: number;
  withdrawals: number;
  gain: number;
}

export interface ReturnsIncomeMonth { month: string; dividends: number; interest: number; capitalGains: number; total: number }

export interface ReturnsData {
  windowStart: string;
  windowEnd: string;
  total: ReturnsTotal | null;
  coverage: { includedBalance: number; totalBalance: number; share: number | null; includedCount: number; accountCount: number };
  accounts: ReturnsAccount[];
  flows: ReturnsFlow[];
  benchmark: { id: string; label: string; from: string; to: string; periodReturn: number | null; annualized: number | null } | null;
  income: {
    months: ReturnsIncomeMonth[];
    from: string;
    to: string;
    total: number;
    nextTwelveMonths: number;   // simply the past 12 months, not a forecast
    byAccount: { accountId: string; name: string; total: number }[];
  };
  caveats: string[];
}
