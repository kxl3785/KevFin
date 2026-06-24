import { getDb } from '../db/schema.js';
import { fetchHoldings, type Holding } from './simplefin.js';
import { fetchDailyCloses, effectiveChain, accountProxyTickers, closeAsOf, type PricePoint } from './prices.js';

export interface PerfPoint { date: string; value: number }

export interface PerfSeries {
  id: string;
  label: string;
  type: 'account' | 'benchmark';
  accounts: string[];   // constituent account names (empty for benchmarks)
  points: PerfPoint[];
  cagr: number;
  totalReturn: number;
}

export interface PerformanceData {
  series: PerfSeries[];
  startDate: string;
  endDate: string;
}

const BENCHMARKS: { id: string; label: string }[] = [
  { id: 'SPY',   label: 'S&P 500 (SPY)' },
  { id: 'QQQ',   label: 'Nasdaq 100 (QQQ)' },
  { id: 'VFFVX', label: 'Target Date 2055 (VFFVX)' },
  { id: 'BND',   label: 'Total Bond Market (BND)' },
];

// Always fetch 5 years so switching ranges uses the warm in-process cache.
const MAX_LOOKBACK_DAYS = 1825;

function sampleDates(startDate: string, endDate: string, stepDays: number): string[] {
  const out: string[] = [];
  const d = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + stepDays);
  }
  if (out[out.length - 1] !== endDate) out.push(endDate);
  return out;
}

// Total-return (distribution-adjusted) closes, so coupon-heavy assets like bond
// funds reflect their real return instead of a near-flat price line.
function forwardFill(dates: string[], series: PricePoint[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const d of dates) {
    const v = closeAsOf(series, d, 'adjClose');
    if (v != null) out.set(d, v);
  }
  return out;
}

function computeCagr(startVal: number, endVal: number, days: number): number {
  if (startVal <= 0 || endVal <= 0 || days <= 0) return 0;
  return Math.pow(endVal / startVal, 365 / days) - 1;
}

// Reconstructed value for one account at one date.
// Uses current holdings scaled by price movement; uninvested cash is held flat.
function accountValueAt(
  acctId: string,
  acctBalance: number,
  holdingsByAccount: Map<string, Holding[]>,
  filledMap: Map<string, Map<string, number>>,
  latestClose: Map<string, number>,
  date: string,
): number {
  const holdings = holdingsByAccount.get(acctId) ?? [];
  const holdingsTotal = holdings.reduce((s, h) => s + h.marketValue, 0);
  const cash = acctBalance - holdingsTotal;

  let total = cash;
  for (const h of holdings) {
    const chain = effectiveChain(h.symbol, h.description);
    let matched = false;
    for (const ticker of chain) {
      const at = filledMap.get(ticker)?.get(date);
      const latest = latestClose.get(ticker);
      if (at != null && latest && latest > 0) {
        total += h.marketValue * (at / latest);
        matched = true;
        break;
      }
    }
    if (!matched) total += h.marketValue; // no price data → hold flat
  }
  return total;
}

// Fetch a single arbitrary ticker as a normalised benchmark-style series, or
// null when no price history is available — used to validate (and supply) the
// custom index comparisons a user adds in the performance chart.
export async function getSymbolSeries(symbol: string, days = MAX_LOOKBACK_DAYS): Promise<PerfSeries | null> {
  const key = symbol.trim().toUpperCase();
  const today = new Date().toISOString().slice(0, 10);

  const fetchStart = new Date();
  fetchStart.setUTCDate(fetchStart.getUTCDate() - MAX_LOOKBACK_DAYS);
  const fetchStartDate = fetchStart.toISOString().slice(0, 10);

  const sliceStart = new Date();
  sliceStart.setUTCDate(sliceStart.getUTCDate() - days);
  const startDate = sliceStart.toISOString().slice(0, 10);
  const dates = sampleDates(startDate, today, 7);

  const raw = await fetchDailyCloses(key, fetchStartDate, today);
  if (raw.length === 0) return null;

  const filled = forwardFill(dates, raw);
  const rawVals = dates.map(d => filled.get(d) ?? null);
  const firstValid = rawVals.find((v): v is number => v != null);
  if (firstValid == null) return null;

  const points: PerfPoint[] = rawVals.map((v, i) => ({
    date: dates[i],
    value: v != null ? Math.round((v / firstValid) * 10000) / 100 : 100,
  }));
  const endVal = (rawVals[rawVals.length - 1] ?? firstValid) as number;

  return {
    id: `sym:${key}`,
    label: key,
    type: 'benchmark',
    accounts: [],
    points,
    cagr: computeCagr(firstValid, endVal, days),
    totalReturn: (endVal - firstValid) / firstValid,
  };
}

export async function getPerformance(days = 365): Promise<PerformanceData> {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);

  const fetchStart = new Date();
  fetchStart.setUTCDate(fetchStart.getUTCDate() - MAX_LOOKBACK_DAYS);
  const fetchStartDate = fetchStart.toISOString().slice(0, 10);

  const sliceStart = new Date();
  sliceStart.setUTCDate(sliceStart.getUTCDate() - days);
  const startDate = sliceStart.toISOString().slice(0, 10);

  const dates = sampleDates(startDate, today, 7);

  const accts = db
    .prepare('SELECT id, name, custom_name, org_name, balance FROM accounts WHERE category = ? AND hidden = 0')
    .all('brokerage') as { id: string; name: string; custom_name: string | null; org_name: string; balance: number }[];

  const holdingsByAccount = await fetchHoldings();

  // Some brokerages (e.g. Frec) report a balance but no per-position holdings, so
  // there's nothing to grow and the reconstruction stays flat. For an account
  // with no holdings, proxy the whole balance with an index inferred from its
  // name (e.g. "S&P 500®" → IVV); accounts with real holdings are untouched.
  const holdingsForPerf = new Map<string, Holding[]>();
  for (const acct of accts) {
    const hs = holdingsByAccount.get(acct.id) ?? [];
    if (hs.length === 0) {
      const proxy = accountProxyTickers(acct.custom_name ?? acct.name);
      holdingsForPerf.set(acct.id, proxy.length > 0
        ? [{ symbol: proxy[0], description: acct.name, marketValue: acct.balance }]
        : []);
    } else {
      holdingsForPerf.set(acct.id, hs);
    }
  }

  // Tickers: all holding chains across every brokerage account + benchmarks.
  const tickers = new Set<string>(BENCHMARKS.map(b => b.id));
  for (const acct of accts) {
    for (const h of holdingsForPerf.get(acct.id) ?? []) {
      effectiveChain(h.symbol, h.description).forEach(t => tickers.add(t));
    }
  }

  const rawSeries = new Map<string, PricePoint[]>();
  await Promise.all([...tickers].map(async sym =>
    rawSeries.set(sym, await fetchDailyCloses(sym, fetchStartDate, today))
  ));

  const filledMap = new Map<string, Map<string, number>>();
  for (const [sym, series] of rawSeries) filledMap.set(sym, forwardFill(dates, series));

  const latestClose = new Map<string, number>();
  for (const [sym, series] of rawSeries) {
    if (series.length > 0) {
      const last = series[series.length - 1];
      latestClose.set(sym, last.adjClose ?? last.close);
    }
  }

  const result: PerfSeries[] = [];

  // ---- Per-institution series (grouped by org_name) ----
  const orgGroups = new Map<string, typeof accts>();
  for (const acct of accts) {
    const group = orgGroups.get(acct.org_name) ?? [];
    group.push(acct);
    orgGroups.set(acct.org_name, group);
  }

  for (const [orgName, orgAccts] of orgGroups) {
    const rawVals = dates.map(date =>
      orgAccts.reduce(
        (sum, acct) => sum + accountValueAt(acct.id, acct.balance, holdingsForPerf, filledMap, latestClose, date),
        0,
      )
    );

    const startVal = rawVals[0];
    if (!startVal || startVal <= 0) continue;

    const points: PerfPoint[] = rawVals.map((v, i) => ({
      date: dates[i],
      value: Math.round((v / startVal) * 10000) / 100,
    }));

    const endVal = rawVals[rawVals.length - 1];
    result.push({
      id: `org:${orgName}`,
      label: orgName,
      type: 'account',
      accounts: orgAccts.map(a => a.custom_name ?? a.name),
      points,
      cagr: computeCagr(startVal, endVal, days),
      totalReturn: (endVal - startVal) / startVal,
    });
  }

  // ---- Total across all accounts (dollar-weighted, so it reflects the real
  // blended portfolio rather than an average of normalised lines) ----
  const totalRaw = dates.map(date =>
    accts.reduce(
      (sum, a) => sum + accountValueAt(a.id, a.balance, holdingsForPerf, filledMap, latestClose, date),
      0,
    )
  );
  const totalStart = totalRaw[0];
  if (totalStart && totalStart > 0) {
    const totalEnd = totalRaw[totalRaw.length - 1];
    result.unshift({
      id: 'total',
      label: 'All Accounts',
      type: 'account',
      accounts: accts.map(a => a.custom_name ?? a.name),
      points: totalRaw.map((v, i) => ({ date: dates[i], value: Math.round((v / totalStart) * 10000) / 100 })),
      cagr: computeCagr(totalStart, totalEnd, days),
      totalReturn: (totalEnd - totalStart) / totalStart,
    });
  }

  // ---- Benchmark series ----
  for (const bench of BENCHMARKS) {
    const filled = filledMap.get(bench.id) ?? new Map<string, number>();
    const rawVals = dates.map(d => filled.get(d) ?? null);

    const firstValid = rawVals.find((v): v is number => v != null);
    if (firstValid == null) continue;

    const points: PerfPoint[] = rawVals.map((v, i) => ({
      date: dates[i],
      value: v != null ? Math.round((v / firstValid) * 10000) / 100 : 100,
    }));

    const endVal = (rawVals[rawVals.length - 1] ?? firstValid) as number;
    result.push({
      id: bench.id,
      label: bench.label,
      type: 'benchmark',
      accounts: [],
      points,
      cagr: computeCagr(firstValid, endVal, days),
      totalReturn: (endVal - firstValid) / firstValid,
    });
  }

  return {
    series: result,
    startDate: dates[0] ?? startDate,
    endDate: dates[dates.length - 1] ?? today,
  };
}
