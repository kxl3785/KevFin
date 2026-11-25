// The Allocation page's fee and asset-location check-up (GET /api/allocation/fees).
//
// Built on the SAME holdings getAllocation() returns — so the fund list and the
// location table agree with every other panel on the page — plus:
//  - each holding's annual expense ratio (user figure > published figure >
//    0 for stocks and cash > unknown), and the yearly cost that implies. A
//    published figure is Yahoo's, else the fund's SEC shareholder report's;
//    the row's `provider` says which;
//  - each brokerage account's tax bucket, classified exactly as the Forecast
//    and /api/net-worth/tax-buckets do: taxBucket(`${name} ${org_name}`), with
//    the Forecast's saved per-account reassignments (mon.fcBucketOverrides)
//    applied on top.
// Read-only: nothing here changes a holding or an account.
import { getDb } from '../db/schema.js';
import { getAllocation, holdingId, type Allocation } from './allocation.js';
import { fetchSecurityMeta } from './yahooMeta.js';
import { fetchHoldings } from './simplefin.js';
import { lookupExpenseRatio, getExpenseOverrides } from './expenseRatios.js';
import { getAllPrefs } from './prefs.js';
import { effectiveChain } from './prices.js';
import { classifyRatio, looksLikeNonFundSecurity, summarizeFees, type FeeRow, type FeeSummary } from '../util/expenseRatio.js';
import { buildAssetLocation, classSplitFor, isTaxExemptBond, parseBucketOverrides, type AssetLocation } from '../util/assetLocation.js';
import { taxBucket, type TaxBucket } from '../util/taxBucket.js';

export interface FeeCheckup extends FeeSummary { location: AssetLocation }

const CRYPTO_FUND = /\b(trust|etf|fund|etp)\b/i;

// Brokerage holdings only: getAllocation also lists home equity and manual
// assets as positions (with no accounts) — those carry no fund fee and sit in
// no account, so they belong in neither the fee list nor the location table.
function brokerageHoldings(alloc: Allocation) {
  return alloc.holdings.filter(h => h.accounts.length > 0);
}

export async function getFeeCheckup(alloc?: Allocation): Promise<FeeCheckup> {
  const a = alloc ?? await getAllocation();
  const holdings = brokerageHoldings(a);
  const overrides = getExpenseOverrides();
  // The visible brokerage accounts — the same set getAllocation draws from.
  const accts = getDb().prepare(`
    SELECT id, name, COALESCE(custom_name, name) AS display, org_name
    FROM accounts WHERE category = 'brokerage' AND hidden = 0
  `).all() as { id: string; name: string; display: string; org_name: string | null }[];
  const visible = new Set(accts.map(x => x.id));
  // fetchHoldings reads the same cached provider payload getAllocation just used.
  const positions = await fetchHoldings();

  // Which tickers can be looked up. getAllocation shows an untickered fund (a
  // 529 portfolio, say) under its PROXY ticker (ITOT, AOA…), and a proxy ETF's
  // fee is not the plan's fee — so a holding is looked up only when its ticker
  // was REPORTED by one of these accounts, and never when any untickered
  // position was shown under it (getAllocation merges such a position into the
  // real ticker's row, and one ratio can't price both). Hidden and
  // non-brokerage accounts don't count: their positions aren't in the list.
  // A proxied holding stays unknown until the user adds a figure.
  const reported = new Set<string>();
  const proxied = new Set<string>();
  for (const [accId, list] of positions) {
    if (!visible.has(accId)) continue;
    for (const x of list) {
      const sym = (x.symbol ?? '').trim();
      if (sym) reported.add(sym);
      else {
        const proxy = effectiveChain('', x.description ?? '')[0];
        if (proxy) proxied.add(proxy);
      }
    }
  }

  // Ratios: decide what we can without the network, then look up funds in
  // parallel (yahooMeta memoizes, so the quote types getAllocation just
  // fetched are free).
  const rows: Omit<FeeRow, 'annualCost'>[] = await Promise.all(holdings.map(async h => {
    const id = holdingId(h.symbol, h.name);
    const sym = h.symbol.trim();
    const symbol = reported.has(sym) && !proxied.has(sym) ? sym : '';
    const hasOverride = overrides[id] != null;
    // Coins held directly (Crypto class, not a fund by name) are non-funds. They
    // are not looked up: a coin's symbol can collide with an unrelated ticker
    // (BTC is also an ETF's symbol). Crypto FUNDS (GBTC "Grayscale Bitcoin
    // Trust", IBIT "iShares Bitcoin Trust ETF") do charge a fee and are looked
    // up like any fund. Options and CUSIP-held bills/bonds/CDs are settled by
    // classifyRatio without a lookup.
    const coin = h.assetClass === 'Crypto' && !CRYPTO_FUND.test(h.name);
    const settled = coin || looksLikeNonFundSecurity(symbol, h.name, h.assetClass);
    const meta = symbol && !hasOverride && !settled ? await fetchSecurityMeta(symbol) : null;
    const quoteType = coin ? 'CRYPTOCURRENCY' : meta?.quoteType ?? null;
    const first = classifyRatio({ symbol, name: h.name, quoteType, override: overrides[id], assetClass: h.assetClass });
    if (first.lookup) {
      const found = await lookupExpenseRatio(symbol);
      if (found) {
        return {
          id, symbol: h.symbol, name: h.name, value: h.value, expenseRatio: found.ratio, source: 'provider' as const,
          provider: found.provider, ...(found.asOf ? { asOf: found.asOf } : {}),
        };
      }
    }
    return { id, symbol: h.symbol, name: h.name, value: h.value, expenseRatio: first.ratio, source: first.source };
  }));
  const fees = summarizeFees(rows);

  // Location: account -> tax bucket, classified with the display name +
  // institution the way getTaxBuckets() does, with the Forecast's per-account
  // reassignments on top.
  const bucketOverrides = parseBucketOverrides(getAllPrefs()['mon.fcBucketOverrides']);
  const bucketOfId = new Map<string, TaxBucket>();
  const idsByName = new Map<string, string[]>();
  for (const acc of accts) {
    bucketOfId.set(acc.id, bucketOverrides[acc.id] ?? taxBucket(`${acc.display} ${acc.org_name ?? ''}`));
    idsByName.set(acc.name, [...(idsByName.get(acc.name) ?? []), acc.id]);
  }
  // getAllocation keys a holding's accounts by their raw provider name, so two
  // accounts with the same raw name ("Brokerage" at two firms) arrive as one
  // entry. When those accounts resolve to the SAME bucket nothing is lost. When
  // they differ (one is a Roth, or was reassigned on the Forecast), the entry is
  // split back per account from the raw positions, matched to the holding the
  // way getAllocation groups them (display symbol, else description).
  const conflicted = new Set<string>();
  for (const [name, ids] of idsByName) {
    if (new Set(ids.map(id => bucketOfId.get(id))).size > 1) conflicted.add(name);
  }
  const positionValue = (accId: string, h: { symbol: string; name: string }) => {
    let v = 0;
    for (const x of positions.get(accId) ?? []) {
      const sym = (x.symbol ?? '').trim();
      const display = sym || effectiveChain('', x.description ?? '')[0] || '';
      const match = h.symbol ? display === h.symbol : !display && (x.description ?? '') === h.name;
      if (match && Number.isFinite(x.marketValue) && x.marketValue > 0) v += x.marketValue;
    }
    return v;
  };
  // Account entries are keyed "id:<account id>" once split, else by raw name.
  const splitAccounts = (h: (typeof holdings)[number]) => h.accounts.flatMap(x => {
    if (!conflicted.has(x.name)) return [{ name: x.name, value: x.value }];
    const ids = idsByName.get(x.name) ?? [];
    const parts = ids.map(id => ({ id, v: positionValue(id, h) }));
    const sum = parts.reduce((t, p) => t + p.v, 0);
    // The raw positions should always account for the entry (they are the same
    // data); if they somehow don't, fall back to the first account's bucket.
    if (!(sum > 0)) return [{ name: `id:${ids[0]}`, value: x.value }];
    return parts.filter(p => p.v > 0).map(p => ({ name: `id:${p.id}`, value: x.value * (p.v / sum) }));
  });
  const bucketOfName = (name: string): TaxBucket => {
    if (name.startsWith('id:')) { const b = bucketOfId.get(name.slice(3)); if (b) return b; }
    const id = idsByName.get(name)?.[0];
    return (id ? bucketOfId.get(id) : undefined) ?? taxBucket(name);
  };
  const location = buildAssetLocation(
    holdings.map(h => ({
      value: h.value,
      accounts: splitAccounts(h),
      classSplit: classSplitFor(h.symbol, h.value, h.assetClass, a.byAssetClass),
      taxExempt: isTaxExemptBond(h.symbol, h.name),
    })),
    bucketOfName,
  );

  return { ...fees, location };
}
