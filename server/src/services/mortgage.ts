import { getDb } from '../db/schema.js';
import { remainingMortgageBalance } from '../util/amortization.js';

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
