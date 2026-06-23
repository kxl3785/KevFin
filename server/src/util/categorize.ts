export type Category = 'banking' | 'brokerage' | 'credit' | 'other';

export const CATEGORIES: Category[] = ['banking', 'brokerage', 'credit', 'other'];

// Best-effort categorization from an account name. SimpleFIN doesn't always
// expose a reliable type, so this is heuristic — users can override per account.
export function categorize(name: string): Category {
  const n = name.toLowerCase();
  if (/(visa|mastercard|amex|american express|credit card|sapphire|freedom|venture|signature|\bcard\b)/.test(n))
    return 'credit';
  if (/(ira|401|403|roth|brokerage|529|crypto|\btod\b|invest|traditional|tenants|individual|retirement|pcra|beneficiary|\bhsa\b)/.test(n))
    return 'brokerage';
  if (/(checking|savings|spending|cash|money market|\bbank\b)/.test(n))
    return 'banking';
  return 'other';
}
