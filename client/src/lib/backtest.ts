import type { SimHistoricalStart, SimInput, SimPathStat } from './forecastSim.ts';
import type { WithdrawalRule } from './withdrawalRules.ts';

// Summaries for the Forecast's "How would this plan have done?" card. Pure: they
// read the per-path statistics runForecastSim returns (SimPathStat) and never run
// the simulation themselves.

// Below this many complete starting years the card says the sample is thin
// instead of quietly reusing (looping) the data.
export const MIN_HISTORICAL_STARTS = 20;

export interface BacktestSummary {
  total: number;
  lasted: number;
  ranOut: SimHistoricalStart[];          // oldest first
  worst: SimHistoricalStart | null;
  medianEndReal: number;                 // median investable savings at the plan's end, today's $
  deepestCut: number;                    // the largest spending cut in any starting year (0–1)
  deepestCutYear: number | null;
}

// The worst starting year: the one that ran out earliest; if none ran out, the one
// with the deepest spending cut; then the smallest ending balance.
function worseThan(a: SimHistoricalStart, b: SimHistoricalStart): boolean {
  const ao = a.ranOutAge != null, bo = b.ranOutAge != null;
  if (ao !== bo) return ao;
  if (ao && bo && a.ranOutAge !== b.ranOutAge) return (a.ranOutAge as number) < (b.ranOutAge as number);
  if (a.deepestCut !== b.deepestCut) return a.deepestCut > b.deepestCut;
  return a.endInvReal < b.endInvReal;
}

// Median by the same rule as the forecast bands (lower middle for an even count).
export function medianOf(values: number[]): number {
  const v = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!v.length) return 0;
  return v[Math.floor((v.length - 1) / 2)];
}

export function summarizeBacktest(starts: SimHistoricalStart[]): BacktestSummary {
  const sorted = [...starts].sort((a, b) => a.startYear - b.startYear);
  let worst: SimHistoricalStart | null = null, deepest: SimHistoricalStart | null = null;
  for (const s of sorted) {
    if (!worst || worseThan(s, worst)) worst = s;
    if (s.deepestCut > 0 && (!deepest || s.deepestCut > deepest.deepestCut)) deepest = s;
  }
  return {
    total: sorted.length,
    lasted: sorted.filter(s => s.ranOutAge == null).length,
    ranOut: sorted.filter(s => s.ranOutAge != null),
    worst,
    medianEndReal: medianOf(sorted.map(s => s.endInvReal)),
    deepestCut: deepest ? deepest.deepestCut : 0,
    deepestCutYear: deepest ? deepest.startYear : null,
  };
}

// For the Monte Carlo runs under a spending rule: how deep the cut was in a typical
// run (median) and in the hardest tenth of runs (90th percentile of the cut).
export function summarizeCuts(paths: SimPathStat[]): { median: number; worstTenth: number; anyCut: number } {
  const cuts = paths.map(p => p.deepestCut).filter(Number.isFinite).sort((a, b) => a - b);
  if (!cuts.length) return { median: 0, worstTenth: 0, anyCut: 0 };
  const at = (p: number) => cuts[Math.min(cuts.length - 1, Math.max(0, Math.floor(p * (cuts.length - 1))))];
  return { median: at(0.5), worstTenth: at(0.9), anyCut: cuts.filter(c => c > 1e-9).length / cuts.length };
}

// Split a list into chunks of `size` (≥ 1), for running the backtest a few
// starting years at a time between frames.
export function chunk<T>(items: T[], size: number): T[][] {
  const n = Math.max(1, Math.floor(size) || 1);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

// --- Saved settings -------------------------------------------------------------
// Stored under their own prefs key (`mon.fcReturnModel`), never inside
// `mon.fcAssumptions`, so they are not shipped to the AI assistant.
export type ReturnModel = 'montecarlo' | 'historical';
export interface BacktestSettings {
  returnModel: ReturnModel; // 'historical' → the whole forecast replays past markets
  stockShare: number;       // share in stocks when the glide path is off
}
export const STOCK_SHARES = [1, 0.8, 0.6, 0.4] as const;
export const DEFAULT_BACKTEST_SETTINGS: BacktestSettings = { returnModel: 'montecarlo', stockShare: 1 };

export function normalizeBacktestSettings(raw: unknown): BacktestSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    returnModel: r.returnModel === 'historical' ? 'historical' : 'montecarlo',
    stockShare: (STOCK_SHARES as readonly number[]).includes(r.stockShare as number) ? (r.stockShare as number) : DEFAULT_BACKTEST_SETTINGS.stockShare,
  };
}

// The extra simulation fields these settings add — an empty object with the
// defaults, so the sim input (and every number) is exactly what it was before.
export function simExtrasFor(settings: BacktestSettings, rule: WithdrawalRule): Partial<SimInput> {
  const out: Partial<SimInput> = {};
  if (settings.returnModel === 'historical') { out.returnModel = 'historical'; out.historicalStockShare = settings.stockShare; }
  if (rule.kind !== 'fixed') out.withdrawal = rule;
  return out;
}
