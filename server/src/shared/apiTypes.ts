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
