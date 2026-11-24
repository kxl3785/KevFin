// Asset location: which kinds of investments sit in which kinds of account
// (taxable, pre-tax, Roth, HSA, college). Pure — the service hands it the
// allocation's holdings, each holding's asset-class split and a resolver from
// account name to tax bucket (the same taxBucket() + Forecast reassignments the
// tax-buckets endpoint uses), and this builds the table plus a few neutral,
// rule-based observations. Tested in assetLocation.test.ts.
import { TAX_BUCKETS, type TaxBucket } from './taxBucket.js';

export interface LocationHolding {
  value: number;
  accounts: { name: string; value: number }[];
  // Fractions of the holding in each asset class (sum ~1). A fund that is part
  // US / part foreign stock splits across both rows of the table.
  classSplit: Record<string, number>;
  // A municipal / tax-exempt bond fund (isTaxExemptBond). It stays in the Bonds
  // row of the table, but is left out of the "bonds in taxable accounts" note:
  // its interest is generally free of federal income tax, and a taxable
  // account is where such funds usually sit.
  taxExempt?: boolean;
}

// Municipal or tax-exempt bond holdings, by name or symbol. Matches "Vanguard
// Tax-Exempt Bond Index Fund ETF" (VTEB), "iShares National Muni Bond ETF"
// (MUB), "... Municipal Income Fund", "... Tax-Free Bond Fund".
export function isTaxExemptBond(symbol: string, name: string): boolean {
  return /municipal|\bmunis?\b|tax[- ]?exempt|tax[- ]?free/i.test(`${symbol} ${name}`);
}

export type LocationObservationKind = 'bonds-taxable' | 'reits-taxable' | 'foreign-sheltered';
export interface LocationObservation { kind: LocationObservationKind; amount: number }

export interface AssetLocation {
  buckets: TaxBucket[];                                  // columns, fixed order
  classes: string[];                                     // rows, largest first
  cells: Record<string, Partial<Record<TaxBucket, number>>>; // class -> bucket -> $
  bucketTotals: Record<TaxBucket, number>;
  classTotals: Record<string, number>;
  total: number;
  observations: LocationObservation[];
}

// An observation is shown only when it is material: at least $1,000 AND at least
// 1% of the located total, so a stray $40 bond ETF in a brokerage account
// doesn't produce a note.
export const OBS_MIN_AMOUNT = 1000;
export const OBS_MIN_SHARE = 0.01;
export const MAX_OBSERVATIONS = 3;

export function buildAssetLocation(
  holdings: LocationHolding[],
  bucketOf: (accountName: string) => TaxBucket,
): AssetLocation {
  const cells: Record<string, Partial<Record<TaxBucket, number>>> = {};
  const bucketTotals = Object.fromEntries(TAX_BUCKETS.map(b => [b, 0])) as Record<TaxBucket, number>;
  const classTotals: Record<string, number> = {};
  let total = 0;
  let exemptBondsTaxable = 0; // tax-exempt Bonds dollars in taxable accounts

  for (const h of holdings) {
    // Normalise the split so a fund whose look-through doesn't quite sum to 1
    // still lands its full value in the table.
    const splitSum = Object.values(h.classSplit).reduce((s, f) => s + (Number.isFinite(f) && f > 0 ? f : 0), 0);
    if (splitSum <= 0) continue;
    for (const a of h.accounts) {
      if (!Number.isFinite(a.value) || a.value <= 0) continue;
      const bucket = bucketOf(a.name);
      for (const [cls, f] of Object.entries(h.classSplit)) {
        if (!Number.isFinite(f) || f <= 0) continue;
        const v = a.value * (f / splitSum);
        const row = cells[cls] ?? (cells[cls] = {});
        row[bucket] = (row[bucket] ?? 0) + v;
        bucketTotals[bucket] += v;
        classTotals[cls] = (classTotals[cls] ?? 0) + v;
        total += v;
        if (h.taxExempt && cls === 'Bonds' && bucket === 'taxable') exemptBondsTaxable += v;
      }
    }
  }

  const classes = Object.keys(classTotals).sort((a, b) => classTotals[b] - classTotals[a]);
  return { buckets: [...TAX_BUCKETS], classes, cells, bucketTotals, classTotals, total, observations: locationObservations(cells, total, exemptBondsTaxable) };
}

// Rule-based observations, stated as facts about where things sit — never as a
// suggestion to move anything. Each rule names a dollar amount; the client turns
// it into a sentence (so the amount can be masked in privacy mode).
//  - bonds-taxable:     bond interest is taxed as ordinary income every year in
//                       a taxable account. Tax-exempt (municipal) bond dollars
//                       in taxable accounts are passed in separately and left
//                       out, since their interest generally isn't.
//  - reits-taxable:     most REIT payouts are non-qualified dividends, taxed as
//                       ordinary income in a taxable account.
//  - foreign-sheltered: the foreign tax credit for taxes withheld abroad can only
//                       be claimed on foreign stock held in a taxable account.
export function locationObservations(
  cells: Record<string, Partial<Record<TaxBucket, number>>>,
  total: number,
  exemptBondsTaxable = 0,
): LocationObservation[] {
  if (!(total > 0)) return [];
  const at = (cls: string, buckets: TaxBucket[]) => buckets.reduce((s, b) => s + (cells[cls]?.[b] ?? 0), 0);
  const exempt = Number.isFinite(exemptBondsTaxable) && exemptBondsTaxable > 0 ? exemptBondsTaxable : 0;
  const candidates: LocationObservation[] = [
    { kind: 'bonds-taxable', amount: Math.max(0, at('Bonds', ['taxable']) - exempt) },
    { kind: 'reits-taxable', amount: at('Real Estate', ['taxable']) },
    { kind: 'foreign-sheltered', amount: at('Foreign Stock', ['pretax', 'roth', 'hsa']) },
  ];
  const minAmount = Math.max(OBS_MIN_AMOUNT, total * OBS_MIN_SHARE);
  return candidates
    .filter(o => Number.isFinite(o.amount) && o.amount >= minAmount)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, MAX_OBSERVATIONS);
}

// Each holding's split across asset classes, from the allocation's
// byAssetClass slices (whose contributors are labelled with the holding's
// display symbol). Only ticker labels are unique enough to trust — every
// untickered holding shares the '' label — so anything else, or a split that
// doesn't account for the holding's value, falls back to the holding's single
// primary class.
export function classSplitFor(
  symbol: string,
  value: number,
  primaryClass: string,
  slices: { name: string; contributors: { label: string; value: number }[] }[],
): Record<string, number> {
  const fallback = { [primaryClass || 'Uncategorized']: 1 };
  if (!symbol.trim() || !(value > 0)) return fallback;
  const parts: Record<string, number> = {};
  let sum = 0;
  for (const s of slices) {
    for (const c of s.contributors) {
      if (c.label !== symbol || !(c.value > 0)) continue;
      parts[s.name] = (parts[s.name] ?? 0) + c.value;
      sum += c.value;
    }
  }
  // Allow a little rounding slack; a mismatch means the label is shared with
  // something else (e.g. a manual asset named like the ticker).
  if (sum <= 0 || Math.abs(sum - value) > Math.max(1, value * 0.01)) return fallback;
  return Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v / sum]));
}

// Parse the Forecast's saved account reassignments (`mon.fcBucketOverrides`,
// { accountId: bucket }), dropping anything that isn't a known bucket.
export function parseBucketOverrides(raw: string | null | undefined): Record<string, TaxBucket> {
  if (!raw) return {};
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return {}; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, TaxBucket> = {};
  for (const [k, b] of Object.entries(v as Record<string, unknown>)) {
    if (typeof b === 'string' && (TAX_BUCKETS as string[]).includes(b)) out[k] = b as TaxBucket;
  }
  return out;
}
