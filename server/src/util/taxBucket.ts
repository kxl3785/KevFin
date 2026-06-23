// Tax treatment buckets used by the Forecast retirement model. The stored
// account `category` is coarse (banking/brokerage/credit), so we infer the tax
// bucket from the account name — the only place the real type leaks through
// (e.g. "Roth IRA", "BJC 401(K)", "HSA Brokerage", "UTSAVER 403b"). It's
// best-effort; the UI lets the user reassign any account.
export type TaxBucket = 'taxable' | 'pretax' | 'roth' | 'hsa' | 'college';

export const TAX_BUCKETS: TaxBucket[] = ['taxable', 'pretax', 'roth', 'hsa', 'college'];

export function taxBucket(name: string): TaxBucket {
  const n = name.toLowerCase();
  // Order matters: HSA / 529 / Roth must win before the generic retirement test,
  // since a Roth 401(k) or HSA brokerage also matches "401"/"brokerage".
  if (/\bhsa\b|health savings/.test(n)) return 'hsa';
  if (/\b529\b|coverdell|\besa\b|education savings|college sav/.test(n)) return 'college';
  if (/roth/.test(n)) return 'roth';
  if (/\b401|\b403|\b457\b|\bira\b|\borp\b|\btsa\b|utsaver|pension|retirement|traditional|\bsep\b|\bsimple ira\b|deferred comp|pcra|brokeragelink|\b403b\b/.test(n))
    return 'pretax';
  return 'taxable'; // brokerage/individual/TOD/checking/savings/cash → taxable
}
