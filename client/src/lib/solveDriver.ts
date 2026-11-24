import { jobGenerator, runInSlices, type SolveJob, type SolveJobResult, type SolveMessage } from './forecastSolve.ts';

// Runs a solver job (lib/forecastSolve.ts) on a background thread, so the page
// stays smooth however long the simulations take. Each job gets its own worker,
// ended when the job finishes or is cancelled. Where a worker can't be used (no
// Worker support, the worker fails to start, or the inputs can't be copied to
// it) the same job runs on the page's thread in short slices instead — slower to
// feel, same answers.
//
// Returns a cancel function; no callback fires after a cancel.

export function runSolveJob<J extends SolveJob>(job: J, opts: {
  onDone: (v: SolveJobResult<J>) => void;
  onProgress?: (n: number) => void;
  onError?: (e: unknown) => void;
}): () => void {
  let cancelled = false;
  let cancelMain: (() => void) | null = null;
  let worker: Worker | null = null;
  const onMainThread = () => {
    if (cancelled || cancelMain) return;
    cancelMain = runInSlices(jobGenerator(job) as Generator<number, SolveJobResult<J>>, opts);
  };
  const end = () => { if (worker) { worker.terminate(); worker = null; } };

  if (typeof Worker === 'undefined') { onMainThread(); }
  else {
    try {
      worker = new Worker(new URL('./forecastSolve.worker.ts', import.meta.url), { type: 'module' });
    } catch { worker = null; }
    if (!worker) onMainThread();
    else {
      let heard = false;
      worker.onmessage = (e: MessageEvent<SolveMessage>) => {
        heard = true;
        if (cancelled) return;
        const m = e.data;
        if (m.type === 'progress') opts.onProgress?.(m.n);
        else if (m.type === 'done') { end(); opts.onDone(m.value as SolveJobResult<J>); }
        else { end(); opts.onError?.(new Error(m.message)); }
      };
      worker.onerror = (e: ErrorEvent) => {
        e.preventDefault?.();
        end();
        if (cancelled) return;
        // It never started (blocked, or failed to load): do the job here instead.
        if (!heard) onMainThread(); else opts.onError?.(e);
      };
      try { worker.postMessage(job); } catch { end(); onMainThread(); }
    }
  }
  return () => { cancelled = true; end(); cancelMain?.(); };
}
