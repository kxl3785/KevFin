import { useEffect, useMemo, useState } from 'react';
import type { SimInput } from '../../lib/forecastSim.ts';
import {
  hashInputs, AnswerCache, normalizeTargets,
  DEFAULT_TARGETS, ESTIMATED_SIMS, SOLVER_RUNS, type PlanAnswersResult, type SolveTargets,
} from '../../lib/forecastSolve.ts';
import { runSolveJob } from '../../lib/solveDriver.ts';
import { usePersistentState } from '../../hooks/usePersistentState.ts';

// The "What your plan supports" solve, shared by the headline tiles at the top of
// the Forecast page and the card further down that holds its settings and
// guardrails. One solve feeds both, so they always show the same answers.
//
// The answers come from many simulations (lib/forecastSolve.ts). They are worked
// out a moment after the inputs stop changing, on a background thread so the page
// stays responsive (lib/solveDriver.ts), and remembered per set of inputs, so going
// back to a plan already solved shows its answers at once. While a new solve runs
// the previous answers stay up, marked stale.

const DEBOUNCE_MS = 1200;
const answerCache = new AnswerCache<PlanAnswersResult>(16);

export interface PlanAnswersState {
  result: PlanAnswersResult | null;  // the latest answers (possibly for older inputs)
  stale: boolean;                    // `result` was worked out for other inputs; a new one is coming
  progress: number | null;           // 0–1 while solving, else null
  failed: boolean;
  targets: SolveTargets;
  setTargets: (t: SolveTargets) => void;
  ready: boolean;                    // the inputs have loaded
}

export function usePlanAnswers(input: SimInput | null): PlanAnswersState {
  const [targetsRaw, setTargets] = usePersistentState<SolveTargets>('mon.fcSolveTargets', DEFAULT_TARGETS);
  const targets = useMemo(() => normalizeTargets(targetsRaw), [targetsRaw]);

  const key = useMemo(() => (input ? hashInputs({ input, targets, runs: SOLVER_RUNS }) : null), [input, targets]);
  const [result, setResult] = useState<{ key: string; value: PlanAnswersResult } | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!input || !key) return;
    const hit = answerCache.get(key);
    if (hit) { setResult({ key, value: hit }); setProgress(null); setFailed(false); return; }
    setProgress(0);
    let cancel = () => {};
    const timer = setTimeout(() => {
      cancel = runSolveJob({ kind: 'plan', input, targets }, {
        onProgress: n => setProgress(Math.min(0.99, n / ESTIMATED_SIMS)),
        onDone: v => { answerCache.set(key, v); setResult({ key, value: v }); setProgress(null); setFailed(false); },
        onError: () => { setProgress(null); setFailed(true); },
      });
    }, DEBOUNCE_MS);
    return () => { clearTimeout(timer); cancel(); };
  }, [input, key, targets]);

  return {
    result: result?.value ?? null,
    stale: !!result && result.key !== key,
    progress, failed, targets, setTargets, ready: !!input,
  };
}
