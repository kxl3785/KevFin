import { getDb } from '../db/schema.js';
import { fetchHoldings } from './simplefin.js';
import { fetchDailyCloses, effectiveChain, closeAsOf, type PricePoint } from './prices.js';

export interface PerfPoint { date: string; value: number }

export interface PerfSeries {
  id: string;
  label: string;
  type: 'account' | 'benchmark';
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

// Always fetch from 5 years back so the cache is always sufficient for any
// requested range (1Y/3Y/5Y). Subsequent range changes use the warm cache.
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

function forwardFill(dates: string[], series: PricePoint[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const d of dates) {
    const v = closeAsOf(series, d);
    if (v != null) out.set(d, v);
  }
  return out;
}

function computeCagr(startVal: number, endVal: number, days: number): number {
  if (startVal <= 0 || endVal <= 0 || days <= 0) return 0;
  return Math.pow(endVal / startVal, 365 / days) - 1;
}

export async function getPerformance(days = 365): Promise<PerformanceData> {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);

  // Fetch window: always MAX_LOOKBACK so the in-process price cache is reusable.
  const fetchStart = new Date();
  fetchStart.setUTCDate(fetchStart.getUTCDate() - MAX_LOOKBACK_DAYS);
  const fetchStartDate = fetchStart.toISOString().slice(0, 10);

  // Slice window: the range actually displayed.
  const sliceStart = new Date();
  sliceStart.setUTCDate(sliceStart.getUTCDate() - days);
  const startDate = sliceStart.toISOString().slice(0, 10);

  // Weekly sample dates within the display window.
  const dates = sampleDates(startDate, today, 7);

  const accts = db
    .prepare('SELECT id, name, custom_name, org_name, balance FROM accounts WHERE category = ? AND hidden = 0')
    .all('brokerage') as { id: string; name: string; custom_name: string | null; org_name: string; balance: number }[];

  const holdingsByAccount = await fetchHoldings();

  // Collect every ticker needed: all holding chains + all benchmarks.
  const tickers = new Set<string>(BENCHMARKS.map(b => b.id));
  for (const acct of accts) {
    for (const h of holdingsByAccount.get(acct.id) ?? []) {
      effectiveChain(h.symbol, h.description).forEach(t => tickers.add(t));
    }
  }

  // Fetch all price series (in-process cache means subsequent calls are free).
  const rawSeries = new Map<string, PricePoint[]>();
  await Promise.all([...tickers].map(async sym =>
    rawSeries.set(sym, await fetchDailyCloses(sym, fetchStartDate, today))
  ));

  // Forward-filled weekly maps (one per ticker).
  const filledMap = new Map<string, Map<string, number>>();
  for (const [sym, series] of rawSeries) {
    filledMap.set(sym, forwardFill(dates, series));
  }

  // Latest close per ticker — used to normalise holding values to current market.
  const latestClose = new Map<string, number>();
  for (const [sym, series] of rawSeries) {
    if (series.length > 0) latestClose.set(sym, series[series.length - 1].close);
  }

  const result: PerfSeries[] = [];

  // ---- Per-account series ----
  for (const acct of accts) {
    const holdings = holdingsByAccount.get(acct.id) ?? [];
    const holdingsTotal = holdings.reduce((s, h) => s + h.marketValue, 0);
    const cash = acct.balance - holdingsTotal; // uninvested cash held flat

    const valueAt = (date: string): number => {
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
        if (!matched) total += h.marketValue; // no price data — hold flat
      }
      return total;
    };

    const rawVals = dates.map(d => valueAt(d));
    const startVal = rawVals[0];
    if (!startVal || startVal <= 0) continue;

    const points: PerfPoint[] = rawVals.map((v, i) => ({
      date: dates[i],
      value: Math.round((v / startVal) * 10000) / 100, // normalised to 100.xx
    }));

    const endVal = rawVals[rawVals.length - 1];
    const label = acct.custom_name ?? acct.name;

    result.push({
      id: acct.id,
      label,
      type: 'account',
      points,
      cagr: computeCagr(startVal, endVal, days),
      totalReturn: (endVal - startVal) / startVal,
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
