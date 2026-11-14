// What the quarterly report counts as cash for the emergency runway.
//
// Two things qualify:
//   - anything the user has put in the Dashboard's "Cash & Banking" category
//     (a connected account or a manual asset), and
//   - U.S. savings bonds and Treasuries held as their own account or manual
//     asset — I bonds, EE bonds, T-bills/notes/bonds, a TreasuryDirect account —
//     whatever category they sit in. They're government-backed and redeemable,
//     and they usually can't be linked as a bank account, so they end up as a
//     manual asset or a brokerage-category account that the category rule misses.
//
// Recognised by name, like the tax buckets (util/taxBucket.ts). Not counted: any
// other investment, and Treasuries held as a position *inside* an investment
// account — the report works with whole accounts, not holdings.

export type CashKind = 'banking' | 'bonds';

// "I bond(s)", "EE bond(s)", "Series I/EE", "savings bond(s)", "Treasury" /
// "Treasuries", "T-bill(s)" / "T-note(s)" / "T-bond(s)", "TreasuryDirect".
// The leading \b keeps "Muni Bonds" from matching the "i bonds" alternative.
const GOVT_BOND_RE = /\b(i|ee)[\s-]?bonds?\b|\bseries[\s-]?(i|ee)\b|\bsavings\s+bonds?\b|\btreasur(y|ies)\b|\bt[\s-]?(bills?|notes?|bonds?)\b|\btreasurydirect\b/i;

export function isGovtBondName(name: string): boolean {
  return GOVT_BOND_RE.test(name);
}

// Which kind of cash a holding is, or null if it doesn't count. A bond name wins
// over the category so a Treasury account filed under Cash & Banking is still
// reported as a bond. Credit accounts never count.
export function cashKind(category: string, name: string): CashKind | null {
  if (category === 'credit') return null;
  if (isGovtBondName(name)) return 'bonds';
  return category === 'banking' ? 'banking' : null;
}
