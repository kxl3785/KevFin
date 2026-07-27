import { describe, it, expect } from 'vitest';
import { decideBackfill, CURRENT_BACKFILL_VERSION, type BackfillFacts } from './historyCatchUp.js';

const NOW = new Date('2026-07-27T06:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

// A healthy install: sources present, history complete, already at the current
// version, backfilled recently.
const healthy = (over: Partial<BackfillFacts> = {}): BackfillFacts => ({
  hasSources: true,
  snapshotCount: 1800,
  coveredDays: 118,
  windowDays: 120,
  storedVersion: CURRENT_BACKFILL_VERSION,
  lastRunISO: daysAgo(1),
  now: NOW,
  ...over,
});

describe('decideBackfill', () => {
  it('leaves a healthy history alone', () => {
    expect(decideBackfill(healthy()).run).toBe(false);
  });

  it('does nothing before there is anything to reconstruct from', () => {
    // A rebuild on an empty DB would just write a wall of zeroes.
    const d = decideBackfill(healthy({ hasSources: false, snapshotCount: 0, storedVersion: null }));
    expect(d.run).toBe(false);
    expect(d.reason).toMatch(/no accounts or properties/);
  });

  it('builds the full window on a fresh install', () => {
    const d = decideBackfill(healthy({ snapshotCount: 0, coveredDays: 0, lastRunISO: null }));
    expect(d).toMatchObject({ run: true, mode: 'full' });
  });

  it('treats a single snapshot as no history', () => {
    expect(decideBackfill(healthy({ snapshotCount: 1, coveredDays: 1, lastRunISO: null })).run).toBe(true);
  });

  // The version stamp is how a correctness fix reaches installs that already
  // have plausible-looking-but-wrong history on disk.
  it('repairs history written by an older code version', () => {
    const d = decideBackfill(healthy({ storedVersion: 1 }));
    expect(d).toMatchObject({ run: true, mode: 'full' });
    expect(d.reason).toMatch(/predates backfill v/);
  });

  it('repairs history that carries no version stamp at all', () => {
    expect(decideBackfill(healthy({ storedVersion: null })).run).toBe(true);
  });

  it('runs the version repair even inside the throttle window', () => {
    // A repair must not be deferred a week just because something ran yesterday.
    expect(decideBackfill(healthy({ storedVersion: 1, lastRunISO: daysAgo(0.5) })).run).toBe(true);
  });

  it('does not repair twice once the version is current', () => {
    expect(decideBackfill(healthy({ storedVersion: CURRENT_BACKFILL_VERSION })).run).toBe(false);
  });

  // Downtime leaves holes: the daily snapshot simply never ran those days.
  it('fills gaps additively rather than rewriting observed history', () => {
    const d = decideBackfill(healthy({ coveredDays: 40, lastRunISO: daysAgo(30) }));
    expect(d).toMatchObject({ run: true, mode: 'missing' });
    expect(d.reason).toMatch(/40\/120/);
  });

  it('tolerates a few missed days without a rebuild', () => {
    expect(decideBackfill(healthy({ coveredDays: 110, lastRunISO: daysAgo(30) })).run).toBe(false);
  });

  it('throttles gap-filling to once a week', () => {
    const gappy = { coveredDays: 40 };
    expect(decideBackfill(healthy({ ...gappy, lastRunISO: daysAgo(3) })).run).toBe(false);
    expect(decideBackfill(healthy({ ...gappy, lastRunISO: daysAgo(8) })).run).toBe(true);
  });

  it('treats a never-run or unparseable stamp as overdue', () => {
    expect(decideBackfill(healthy({ coveredDays: 40, lastRunISO: null })).run).toBe(true);
    expect(decideBackfill(healthy({ coveredDays: 40, lastRunISO: 'not a date' })).run).toBe(true);
  });

  it('never divides by a zero-length window', () => {
    const d = decideBackfill(healthy({ windowDays: 0, coveredDays: 0, lastRunISO: daysAgo(90) }));
    expect(d.run).toBe(false);
    expect(Number.isNaN(Number(d.reason.match(/\d+/)?.[0]))).toBe(false);
  });
});
