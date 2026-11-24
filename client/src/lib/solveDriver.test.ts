import { describe, it, expect, afterEach } from 'vitest';
import type { SimInput } from './forecastSim.ts';
import { solvePlan, runToEnd, DEFAULT_TARGETS, type PlanAnswersResult } from './forecastSolve.ts';
import { runSolveJob } from './solveDriver.ts';

// The page hands every solve to runSolveJob (XR-7): on a worker when it can, on
// its own thread in slices when it can't — the same answers either way.
const plan = (): SimInput => ({
  A: {
    endAge: 90, annualSpending: 70000, eduInflation: 0.05,
    collegeStartAge: 18, collegeYears: 4, collegeCostPerYear: 0,
    gradStartAge: 22, gradYears: 2, gradCostPerYear: 0, gradCoverage: 0,
    effTaxRate: 0.24, investReturn: 0.07, volatility: 0.15, realEstateGrowth: 0.04, retireTaxRate: 0.15,
  },
  currentAge0: 40, infl: 0.03, costPerKid: 0, kidIndependentAge: 22, kidAges: [], events: [],
  earners: [{ currentAge: 40, income: 180000, retireAge: 65, raisePct: 0.02, ssEnabled: true, ssClaimAge: 67, ssAnnual: 36000, employerMatch: 12000, enabled: true }],
  pools0: { taxable: 150000, pretax: 300000, roth: 50000, hsa: 0, college: 0 },
  contribByBucket: { taxable: 0, pretax: 23000, roth: 0, hsa: 0, college: 0 },
  baseRE: 0, hsaLast: true, collegeOn: false, gradOn: false, spendingAdjust: 1, yearNow: 2026, runs: 30,
});
const job = () => ({ kind: 'plan' as const, input: plan(), targets: DEFAULT_TARGETS, runs: 30 });
const expected = () => runToEnd(solvePlan(plan(), DEFAULT_TARGETS, 30));

// A stand-in Worker: records what the driver does and lets the test answer.
class FakeWorker {
  static last: FakeWorker | null = null;
  url: string; posted: unknown[] = []; terminated = false;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: { preventDefault: () => void }) => void) | null = null;
  constructor(url: URL | string) { this.url = String(url); FakeWorker.last = this; }
  postMessage(m: unknown) { this.posted.push(m); }
  terminate() { this.terminated = true; }
}
const g = globalThis as unknown as { Worker?: unknown };
afterEach(() => { delete g.Worker; FakeWorker.last = null; });

describe('runSolveJob', () => {
  it('with no Worker support, runs on the page\'s thread and gives solvePlan\'s answers', async () => {
    const out = await new Promise<PlanAnswersResult>(resolve => { runSolveJob(job(), { onDone: resolve }); });
    expect(out).toEqual(expected());
  });

  it('hands the job to the worker and relays its progress and result', () => {
    g.Worker = FakeWorker;
    const progress: number[] = []; let done: unknown = null;
    runSolveJob(job(), { onDone: v => { done = v; }, onProgress: n => progress.push(n) });
    const w = FakeWorker.last!;
    expect(w.url).toMatch(/forecastSolve\.worker\.ts$/);
    expect(w.posted).toEqual([job()]);
    w.onmessage!({ data: { type: 'progress', n: 7 } });
    w.onmessage!({ data: { type: 'done', value: { ok: 1 } } });
    expect(progress).toEqual([7]);
    expect(done).toEqual({ ok: 1 });
    expect(w.terminated).toBe(true);
  });

  it('a worker that fails to start falls back to the page\'s thread', async () => {
    g.Worker = FakeWorker;
    const out = new Promise<PlanAnswersResult>(resolve => { runSolveJob(job(), { onDone: resolve }); });
    FakeWorker.last!.onerror!({ preventDefault: () => {} });
    expect(await out).toEqual(expected());
  });

  it('an error after the worker started is reported, not retried', () => {
    g.Worker = FakeWorker;
    let err: unknown = null; let done = false;
    runSolveJob(job(), { onDone: () => { done = true; }, onError: e => { err = e; } });
    const w = FakeWorker.last!;
    w.onmessage!({ data: { type: 'progress', n: 1 } });
    w.onmessage!({ data: { type: 'error', message: 'boom' } });
    expect((err as Error).message).toBe('boom');
    expect(done).toBe(false);
  });

  it('cancel ends the worker and nothing fires afterwards', () => {
    g.Worker = FakeWorker;
    let fired = false;
    const cancel = runSolveJob(job(), { onDone: () => { fired = true; }, onProgress: () => { fired = true; } });
    const w = FakeWorker.last!;
    cancel();
    expect(w.terminated).toBe(true);
    w.onmessage!({ data: { type: 'done', value: {} } });
    expect(fired).toBe(false);
  });
});
