// Pure helpers behind the Investments page's "Fund fees" card
// (components/allocation/FundFeesCard.tsx): which holdings the fees go to,
// which charge nothing, which have no figure, and how those groups are worded.
// The rows are the fee check-up's (GET /api/allocation/fees), already summed
// there into the totals the headline tile shows; nothing here re-derives a
// total, so the card and the tile can't disagree. Dependency-free so the rules
// are unit-tested (fundFees.test.ts); the component only formats.

// The slice of a fee check-up row these helpers read (FeeCheckup.tsx's FeeRow).
export interface FeeRowLike {
  id: string;
  symbol: string;
  name: string;
  value: number;
  expenseRatio: number | null;
  source: string;
  annualCost: number | null;
}

export interface FeeShare<T> { row: T; share: number } // share of all yearly fees (0..1)

export interface FeeGroups<T> {
  charging: FeeShare<T>[]; // holdings with a fee above 0%, largest yearly cost first
  free: T[];               // a known fee of 0%: single stocks, cash, zero-fee funds
  unknown: T[];            // no figure at all, largest value first
}

// Split the rows into the card's three groups. A charging row's share is its
// cost over the charging rows' total, which is the check-up's totalAnnualCost
// (rows at 0% add nothing to it). Ties keep the larger holding first, then the
// server's order, so the ranking is stable. Rows with no value are dropped,
// as the server drops them from the totals.
export function feeGroups<T extends FeeRowLike>(rows: T[]): FeeGroups<T> {
  const live = rows.map((r, i) => ({ r, i })).filter(({ r }) => Number.isFinite(r.value) && r.value > 0);
  const cost = (r: T) => (r.annualCost != null && Number.isFinite(r.annualCost) ? r.annualCost : (r.expenseRatio ?? 0) * r.value);
  const paying = live.filter(({ r }) => r.expenseRatio != null && r.expenseRatio > 0 && cost(r) > 0)
    .sort((a, b) => cost(b.r) - cost(a.r) || b.r.value - a.r.value || a.i - b.i);
  const total = paying.reduce((s, { r }) => s + cost(r), 0);
  return {
    charging: paying.map(({ r }) => ({ row: r, share: total > 0 ? cost(r) / total : 0 })),
    free: live.filter(({ r }) => r.expenseRatio != null && !(r.expenseRatio > 0)).map(({ r }) => r),
    unknown: live.filter(({ r }) => r.expenseRatio == null)
      .sort((a, b) => b.r.value - a.r.value || a.i - b.i).map(({ r }) => r),
  };
}

// The rows a list shows before "Show all": a longer list folds to its first
// `limit` (six or fewer just show, rather than hide a single row behind a
// button), as Bond quality's "Held in" does.
export const FEE_LIST_LIMIT = 5;
export function foldList<T>(rows: T[], showAll: boolean, limit = FEE_LIST_LIMIT): { shown: T[]; folds: boolean } {
  const folds = rows.length > limit + 1;
  return { shown: folds && !showAll ? rows.slice(0, limit) : rows, folds };
}

// "A and B", "A, B and C". Empty for none.
export function andList(items: string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

// Name up to `max` holdings, then "and N more": "VMFXX, ABCD and 2 more". One
// over the limit is just named rather than called "1 more".
export function namedList(names: string[], max = 3): string {
  if (names.length <= max + 1) return andList(names);
  return `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
}

// What the holdings that charge nothing are, by the check-up's source for them,
// in this order: "single stocks and cash", "a single stock". A fund with a
// published or entered 0% is a zero-fee fund.
const FREE_KINDS: { key: string; test: (source: string) => boolean; one: string; many: string }[] = [
  { key: 'stock', test: s => s === 'stock', one: 'a single stock', many: 'single stocks' },
  { key: 'cash', test: s => s === 'cash', one: 'cash', many: 'cash' },
  { key: 'not-fund', test: s => s === 'not-fund', one: 'a holding that isn’t a fund', many: 'other holdings that aren’t funds' },
  { key: 'fund', test: s => s !== 'stock' && s !== 'cash' && s !== 'not-fund', one: 'a zero-fee fund', many: 'zero-fee funds' },
];
export function freeKinds(rows: Pick<FeeRowLike, 'source'>[]): string {
  return andList(FREE_KINDS.flatMap(k => {
    const n = rows.filter(r => k.test(r.source)).length;
    return n === 0 ? [] : [n === 1 ? k.one : k.many];
  }));
}

// "12 holdings charge nothing: single stocks and cash." null when none do.
export function freeLine(rows: Pick<FeeRowLike, 'source'>[]): string | null {
  if (!rows.length) return null;
  const n = rows.length;
  return `${n} holding${n === 1 ? ' charges' : 's charge'} nothing: ${freeKinds(rows)}.`;
}

// A holding's name in these lists: its ticker, else its name.
export const holdingLabel = (r: Pick<FeeRowLike, 'symbol' | 'name'>) => r.symbol || r.name;
