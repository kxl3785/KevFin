// Model-vs-current drift for the Asset Allocation chart.
//
// The model portfolio covers only the investable classes (they sum to 100%),
// while byAssetClass shares are of a grand total that also includes real estate
// and other assets. Comparing them directly makes every class look underweight,
// so drift is computed on the investable slice only, renormalised to 100%.

export interface DriftResult {
  // Class key -> current weight (points, 0..100) of the investable slice.
  investablePct: Record<string, number>;
  // Share of the grand total (0..100) that sits outside the model's classes.
  outsidePct: number;
  // False when there are no investable assets to compare against.
  comparable: boolean;
}

export function investableWeights(curPctOfTotal: Record<string, number>, modelKeys: string[]): DriftResult {
  const inModel = modelKeys.reduce((s, k) => s + (curPctOfTotal[k] ?? 0), 0);
  const all = Object.values(curPctOfTotal).reduce((s, v) => s + v, 0);
  const investablePct: Record<string, number> = {};
  for (const k of modelKeys) investablePct[k] = inModel > 0 ? ((curPctOfTotal[k] ?? 0) / inModel) * 100 : 0;
  return { investablePct, outsidePct: Math.max(0, all - inModel), comparable: inModel > 0 };
}

// "17 pts below model" / "3 pts above model"; null inside the 1-point dead band.
export function driftLabel(modelPct: number, currentInvestablePct: number): { text: string; under: boolean } | null {
  const drift = modelPct - currentInvestablePct; // + = under target
  if (Math.abs(drift) < 1) return null;
  const pts = Math.round(Math.abs(drift));
  return { text: `${pts} ${pts === 1 ? 'pt' : 'pts'} ${drift > 0 ? 'below' : 'above'} model`, under: drift > 0 };
}
