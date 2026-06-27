import { getDb } from '../db/schema.js';
import { remainingMortgageBalance, mortgageSplit } from '../util/amortization.js';

/**
 * For every property with full loan terms (principal + rate + start date),
 * recompute mortgage_balance from the amortization schedule as of today.
 * Properties without terms are left untouched — their manually-entered
 * mortgage_balance stands. Called before each snapshot so equity stays current
 * as months pass without any user action.
 */
export function recomputeMortgageBalances(): void {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, mortgage_principal, mortgage_rate, mortgage_start, mortgage_term_years
    FROM properties
    WHERE mortgage_principal IS NOT NULL
      AND mortgage_rate IS NOT NULL
      AND mortgage_start IS NOT NULL
  `).all() as {
    id: number;
    mortgage_principal: number;
    mortgage_rate: number;
    mortgage_start: string;
    mortgage_term_years: number | null;
  }[];

  const update = db.prepare(`UPDATE properties SET mortgage_balance = ? WHERE id = ?`);
  for (const r of rows) {
    const balance = remainingMortgageBalance(
      r.mortgage_principal,
      r.mortgage_rate,
      r.mortgage_start,
      r.mortgage_term_years ?? 30,
    );
    update.run(balance, r.id);
  }
}

export interface PropertyCarry {
  id: number;
  address: string;
  value: number;            // current home value (zestimate)
  balance: number;          // remaining mortgage principal
  equity: number;           // value − balance
  rate: number | null;      // annual mortgage rate %
  monthlyPI: number;        // level monthly principal + interest
  annualInterest: number;   // interest over the next 12 months (a true cost)
  annualPrincipal: number;  // principal over the next 12 months (builds equity)
  propertyTaxAnnual: number;
  insuranceAnnual: number;
  hoaAnnual: number;
  monthlyCarry: number;     // P&I + (tax + insurance + HOA)/12 — total monthly housing cost
  payoffISO: string;        // scheduled payoff, '' when no loan terms
}

export interface RealEstateCarry {
  properties: PropertyCarry[];
  totals: {
    value: number; balance: number; equity: number;
    monthlyPI: number; annualInterest: number; annualPrincipal: number;
    propertyTaxAnnual: number; insuranceAnnual: number; hoaAnnual: number;
    monthlyCarry: number;
  };
}

/**
 * Per-property and aggregate housing carrying costs as of today: the mortgage
 * payment split into interest (cost) vs principal (equity), plus property tax,
 * insurance and HOA. Shared by the Budget housing breakdown. Pure read; does not
 * touch net worth. Properties without loan terms contribute only their carrying
 * costs (and value/equity from any manual balance).
 */
export function realEstateCarry(asOf: Date = new Date()): RealEstateCarry {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, address, zestimate, mortgage_balance,
           mortgage_principal, mortgage_rate, mortgage_start, mortgage_term_years,
           property_tax_annual, insurance_annual, hoa_annual
    FROM properties ORDER BY address
  `).all() as {
    id: number; address: string; zestimate: number | null; mortgage_balance: number;
    mortgage_principal: number | null; mortgage_rate: number | null;
    mortgage_start: string | null; mortgage_term_years: number | null;
    property_tax_annual: number | null; insurance_annual: number | null; hoa_annual: number | null;
  }[];

  const properties: PropertyCarry[] = rows.map(r => {
    const value = r.zestimate ?? 0;
    const split = (r.mortgage_principal != null && r.mortgage_rate != null && r.mortgage_start)
      ? mortgageSplit(r.mortgage_principal, r.mortgage_rate, r.mortgage_start, r.mortgage_term_years ?? 30, asOf)
      : null;
    const balance = split ? split.balance : r.mortgage_balance;
    const propertyTaxAnnual = r.property_tax_annual ?? 0;
    const insuranceAnnual = r.insurance_annual ?? 0;
    const hoaAnnual = r.hoa_annual ?? 0;
    const monthlyPI = split ? split.payment : 0;
    const monthlyCarry = monthlyPI + (propertyTaxAnnual + insuranceAnnual + hoaAnnual) / 12;
    return {
      id: r.id, address: r.address, value, balance, equity: value - balance,
      rate: r.mortgage_rate,
      monthlyPI,
      annualInterest: split ? split.annualInterest : 0,
      annualPrincipal: split ? split.annualPrincipal : 0,
      propertyTaxAnnual, insuranceAnnual, hoaAnnual,
      monthlyCarry,
      payoffISO: split ? split.payoffISO : '',
    };
  });

  const sum = (sel: (p: PropertyCarry) => number) => properties.reduce((t, p) => t + sel(p), 0);
  return {
    properties,
    totals: {
      value: sum(p => p.value), balance: sum(p => p.balance), equity: sum(p => p.equity),
      monthlyPI: sum(p => p.monthlyPI), annualInterest: sum(p => p.annualInterest), annualPrincipal: sum(p => p.annualPrincipal),
      propertyTaxAnnual: sum(p => p.propertyTaxAnnual), insuranceAnnual: sum(p => p.insuranceAnnual), hoaAnnual: sum(p => p.hoaAnnual),
      monthlyCarry: sum(p => p.monthlyCarry),
    },
  };
}
