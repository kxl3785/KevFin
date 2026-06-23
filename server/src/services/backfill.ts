import { getDb } from '../db/schema.js';
import { fetchTransactions, fetchHoldings, type TxnDelta } from './simplefin.js';
import { fetchPlaidTransactions } from './plaid.js';
import { fetchZhviHistories } from './zhvi.js';
import { fetchDailyCloses, effectiveChain, closeAsOf, type PricePoint } from './prices.js';

const DAYS_BACK = 1825; // ~5 years of daily snapshots (enables 3Y/5Y ranges)

interface AccountRow {
  id: string;
  balance: number;
  category: string;
}
interface PropertyRow {
  id: number;
  address: string;
  zestimate: number | null;
  mortgage_balance: number;
}

/** Daily date strings for the last N days, oldest first (excludes today). */
function dailyDates(n: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = n; i >= 1; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// Build a forward-filled close for every date from a chain of price series
// (primary first). The primary is used wherever it has real data; for dates
// before its earliest point, the next series is spliced in — scaled to connect
// continuously at the boundary. Returns the filled map and the latest close.
function buildSplicedFilled(dates: string[], chain: PricePoint[][]): { at: Map<string, number>; latest: number } {
  const at = new Map<string, number>();
  const series = chain.filter(s => s.length > 0);
  if (series.length === 0) return { at, latest: 0 };

  // Cumulative scale so each older series connects to the spliced value at the
  // newer series' start date.
  const scale = new Array(series.length).fill(1);
  for (let k = 1; k < series.length; k++) {
    const boundary = series[k - 1][0].date;
    const newerVal = series[k - 1][0].close * scale[k - 1];
    const olderVal = closeAsOf(series[k], boundary) ?? series[k][0].close;
    scale[k] = olderVal ? newerVal / olderVal : scale[k - 1];
  }

  for (const d of dates) {
    // first (newest) series that has real data at/before this date
    let k = series.findIndex(s => s[0].date <= d);
    if (k === -1) k = series.length - 1; // older than everything → oldest, leading-filled
    const c = closeAsOf(series[k], d) ?? series[k][0].close;
    at.set(d, c * scale[k]);
  }

  const latest = at.get(dates[dates.length - 1]) ?? series[0][series[0].length - 1].close;
  return { at, latest };
}

// Reconstruct an account's balance as of `date` by removing transactions after it.
function balanceAsOf(current: number, txns: TxnDelta[], date: string): number {
  let bal = current;
  for (const t of txns) {
    if (t.date > date) bal -= t.delta;
  }
  return bal;
}

/**
 * Backfill monthly net-worth snapshots from all sources.
 * - cash/banking/credit/other accounts: reconstructed from transactions (accurate)
 * - brokerage accounts: each holding scaled by its ticker's historical price
 *   (Stooq); cash and non-tickered holdings (529s, crypto) held flat
 * - real estate: tax-assessment history scaled to the current Zestimate (Zillow
 *   exposes no Zestimate history; assessed values are the best proxy), minus mortgage
 * - manual assets: held at current value
 * Returns the number of historical snapshots written.
 */
export async function backfillHistory(): Promise<number> {
  const db = getDb();
  const dates = dailyDates(DAYS_BACK);
  const earliest = dates[0];
  const sinceUnix = Math.floor(new Date(earliest + 'T00:00:00Z').getTime() / 1000);

  const accounts = db.prepare('SELECT id, balance, category FROM accounts WHERE hidden = 0').all() as AccountRow[];
  const properties = db
    .prepare('SELECT id, address, zestimate, mortgage_balance FROM properties')
    .all() as PropertyRow[];
  const { manual_total } = db
    .prepare('SELECT COALESCE(SUM(value),0) AS manual_total FROM manual_assets')
    .get() as { manual_total: number };

  const today = new Date().toISOString().slice(0, 10);

  // Gather transactions, holdings, and per-property home-value history (ZHVI).
  const [sfTxns, plaidTxns, holdingsByAccount, valueHistories] = await Promise.all([
    fetchTransactions(sinceUnix),
    fetchPlaidTransactions(earliest, today),
    fetchHoldings(),
    fetchZhviHistories(properties.map(p => p.address)),
  ]);
  const txnsByAccount = new Map<string, TxnDelta[]>();
  for (const [id, list] of sfTxns) txnsByAccount.set(id, list);
  for (const [id, list] of plaidTxns) txnsByAccount.set(id, [...(txnsByAccount.get(id) ?? []), ...list]);

  // Fetch a daily price series for every distinct ticker, then forward-fill it
  // across our snapshot dates for O(1) lookups.
  // Effective ticker chain = substituted proxy / real symbol / description proxy
  // (e.g. untickered target-date 529 → ['ITDD','AOA']; PDZJ 401k → ['VFFVX']).
  const effChain = (h: { symbol: string; description: string }): string[] =>
    effectiveChain(h.symbol, h.description);

  // Fetch a daily series for every distinct ticker across all chains.
  const tickers = new Set<string>();
  for (const a of accounts) {
    if (a.category !== 'brokerage') continue;
    for (const h of holdingsByAccount.get(a.id) ?? []) effChain(h).forEach(t => tickers.add(t));
  }
  const rawSeries = new Map<string, PricePoint[]>();
  await Promise.all(
    [...tickers].map(async sym => rawSeries.set(sym, await fetchDailyCloses(sym, earliest, today)))
  );

  // Build one spliced, forward-filled price map per distinct chain.
  const filledByChain = new Map<string, { at: Map<string, number>; latest: number }>();
  const chainKey = (chain: string[]) => chain.join('|');
  function getFilled(chain: string[]) {
    if (chain.length === 0) return null;
    const key = chainKey(chain);
    if (!filledByChain.has(key)) {
      const spliced = buildSplicedFilled(dates, chain.map(s => rawSeries.get(s) ?? []));
      filledByChain.set(key, spliced);
    }
    const f = filledByChain.get(key)!;
    return f.latest > 0 ? f : null;
  }

  // Per brokerage account: value(date) = cash (flat) + Σ holding scaled by its
  // chain's price movement. Holdings with no priceable chain stay flat.
  const brokerageValueAsOf = new Map<string, (date: string) => number>();
  for (const a of accounts) {
    if (a.category !== 'brokerage') continue;
    const holdings = holdingsByAccount.get(a.id) ?? [];
    const holdingsTotal = holdings.reduce((s, h) => s + h.marketValue, 0);
    const cashFlat = a.balance - holdingsTotal; // non-holding cash in the account
    brokerageValueAsOf.set(a.id, (date: string) => {
      let total = cashFlat;
      for (const h of holdings) {
        const fp = getFilled(effChain(h));
        const at = fp?.at.get(date);
        total += fp && at ? h.marketValue * (at / fp.latest) : h.marketValue;
      }
      return total;
    });
  }

  // Build a per-property value function: the ZIP's ZHVI home-value curve scaled
  // so its latest point equals the current Zestimate, linearly interpolated
  // between the (monthly) points. Falls back to the flat Zestimate if ZHVI is
  // unavailable for the ZIP.
  const dayNum = (d: string) => new Date(d + 'T00:00:00Z').getTime() / 86400_000;
  const propValueAsOf = properties.map((p, i) => {
    const hist = valueHistories[i] ?? [];
    const latest = hist.length ? hist[hist.length - 1].value : 0;
    const ratio = latest > 0 && p.zestimate ? p.zestimate / latest : 1;
    return (date: string): number => {
      if (hist.length === 0) return p.zestimate ?? 0;           // no history → hold current
      if (date <= hist[0].date) return hist[0].value * ratio;   // before first assessment
      if (date >= hist[hist.length - 1].date) return hist[hist.length - 1].value * ratio; // after last
      // interpolate within the bracketing assessment pair
      for (let k = 1; k < hist.length; k++) {
        if (date <= hist[k].date) {
          const a = hist[k - 1], b = hist[k];
          const f = (dayNum(date) - dayNum(a.date)) / (dayNum(b.date) - dayNum(a.date));
          return (a.value + (b.value - a.value) * f) * ratio;
        }
      }
      return hist[hist.length - 1].value * ratio;
    };
  });

  const upsert = db.prepare(`
    INSERT INTO net_worth_snapshots (date, accounts_total, real_estate_total, net_worth)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      accounts_total = excluded.accounts_total,
      real_estate_total = excluded.real_estate_total,
      net_worth = excluded.net_worth
  `);

  const writeAll = db.transaction((days: string[]) => {
    for (const date of days) {
      let accountsTotal = manual_total; // manual assets held flat
      for (const a of accounts) {
        if (a.category === 'brokerage') {
          const fn = brokerageValueAsOf.get(a.id);
          accountsTotal += fn ? fn(date) : a.balance;
        } else {
          accountsTotal += balanceAsOf(a.balance, txnsByAccount.get(a.id) ?? [], date);
        }
      }

      let realEstateTotal = 0;
      properties.forEach((p, i) => {
        realEstateTotal += propValueAsOf[i](date) - p.mortgage_balance;
      });

      upsert.run(date, accountsTotal, realEstateTotal, accountsTotal + realEstateTotal);
    }
  });
  writeAll(dates);

  console.log(`[backfill] wrote ${dates.length} daily snapshots back to ${earliest}`);
  return dates.length;
}
