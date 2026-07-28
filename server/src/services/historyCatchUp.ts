import { getDb } from '../db/schema.js';
import { getMeta, setMeta } from './meta.js';
import { backfillHistory } from './backfill.js';

// Automatic history repair.
//
// Net-worth history used to only ever be rebuilt when the user noticed
// something wrong and clicked "Backfill". That left three ways to sit on bad
// data indefinitely: a fresh install with nothing behind it, a server that was
// off for a stretch (daily snapshots simply never happened), and history that
// was written correctly-at-the-time by a version of the code we've since found
// a bug in. This decides — cheaply, from counts already in the DB — whether any
// of those hold, and repairs at most one of them per run.

const LAST_BACKFILL = 'last_backfill';
const BACKFILL_VERSION = 'backfill_version';

/**
 * Bump when a fix changes what a correct history looks like, so every install
 * rebuilds itself exactly once on the next start (or next daily refresh).
 *
 * 2 — prices were requested from Yahoo under a malformed symbol, so every
 *     backfill since then held brokerage positions flat instead of pricing
 *     them; and real-estate equity was computed against today's mortgage
 *     balance on every historical date.
 */
export const CURRENT_BACKFILL_VERSION = 2;

// A rebuild is expensive (a price series per ticker, plus transactions and home
// values), so outside of a one-time repair it runs at most weekly.
const MIN_DAYS_BETWEEN_RUNS = 7;
// Recent history is what the dashboard actually shows, so completeness is judged
// over this trailing window rather than the whole 5 years.
const COVERAGE_WINDOW_DAYS = 120;
// Below this share of days present, the series reads as broken rather than merely
// sparse. Generous on purpose: a couple of missed days is not worth a rebuild.
const MIN_COVERAGE = 0.6;

export type BackfillMode = 'full' | 'missing';
export interface BackfillDecision {
  run: boolean;
  mode: BackfillMode;
  reason: string;
}

export interface BackfillFacts {
  hasSources: boolean;      // any account, property or manual asset to reconstruct from
  snapshotCount: number;    // total rows in net_worth_snapshots
  coveredDays: number;      // distinct dates present in the trailing window
  windowDays: number;       // size of that window
  storedVersion: number | null;
  lastRunISO: string | null;
  now: Date;
}

const SKIP = (reason: string): BackfillDecision => ({ run: false, mode: 'missing', reason });

/**
 * Pure decision: given what's in the DB, should history be rebuilt, and how?
 *
 * 'full' overwrites every date — used only when the stored history is known to
 * be wrong or there is effectively none. 'missing' is additive: it fills gaps
 * and leaves observed snapshots alone, because a reconstruction (which assumes
 * today's holdings were always held) is a weaker record than a real one.
 */
export function decideBackfill(f: BackfillFacts): BackfillDecision {
  // Nothing to reconstruct from — a rebuild would just write zeroes.
  if (!f.hasSources) return SKIP('no accounts or properties yet');

  // A known-bad-history repair outranks everything and ignores the throttle; it
  // self-limits because the version stamp is written on success.
  if (f.storedVersion !== CURRENT_BACKFILL_VERSION) {
    return {
      run: true,
      mode: 'full',
      reason: `history predates backfill v${CURRENT_BACKFILL_VERSION} (stored: ${f.storedVersion ?? 'none'})`,
    };
  }

  // Effectively no history: a fresh install, or a wipe. Nothing to preserve, so
  // build the whole window.
  if (f.snapshotCount < 2) {
    return { run: true, mode: 'full', reason: `only ${f.snapshotCount} snapshot(s) on record` };
  }

  const daysSince = f.lastRunISO ? daysBetween(f.lastRunISO, f.now) : Infinity;
  if (daysSince < MIN_DAYS_BETWEEN_RUNS) {
    return SKIP(`last backfill was ${daysSince.toFixed(1)}d ago`);
  }

  const coverage = f.windowDays > 0 ? f.coveredDays / f.windowDays : 1;
  if (coverage < MIN_COVERAGE) {
    return {
      run: true,
      mode: 'missing',
      reason: `only ${f.coveredDays}/${f.windowDays} of the last ${f.windowDays} days have a snapshot`,
    };
  }

  return SKIP(`history looks complete (${f.coveredDays}/${f.windowDays} recent days)`);
}

function daysBetween(iso: string, now: Date): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return Infinity; // unparseable stamp — treat as never run
  return (now.getTime() - t) / 86_400_000;
}

/** Read the facts `decideBackfill` needs. Counts only; no network, no scan. */
export function readBackfillFacts(now: Date = new Date()): BackfillFacts {
  const db = getDb();
  const one = <T>(sql: string, ...args: unknown[]) => db.prepare(sql).get(...args) as T;

  const { n: accounts } = one<{ n: number }>('SELECT COUNT(*) AS n FROM accounts WHERE hidden = 0');
  const { n: properties } = one<{ n: number }>('SELECT COUNT(*) AS n FROM properties');
  const { n: manual } = one<{ n: number }>('SELECT COUNT(*) AS n FROM manual_assets');
  const { n: snapshotCount } = one<{ n: number }>('SELECT COUNT(*) AS n FROM net_worth_snapshots');

  const from = new Date(now.getTime() - COVERAGE_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const { n: coveredDays } = one<{ n: number }>(
    'SELECT COUNT(DISTINCT date) AS n FROM net_worth_snapshots WHERE date >= ?',
    from,
  );

  const storedRaw = getMeta(BACKFILL_VERSION);
  const parsed = storedRaw == null ? NaN : Number(storedRaw);

  return {
    hasSources: accounts + properties + manual > 0,
    snapshotCount,
    coveredDays,
    windowDays: COVERAGE_WINDOW_DAYS,
    storedVersion: Number.isFinite(parsed) ? parsed : null,
    lastRunISO: getMeta(LAST_BACKFILL),
    now,
  };
}

/**
 * Record that history is current as of now, at this code version. Called after
 * any full rebuild — including the manual "Backfill" button, so an explicit
 * rebuild isn't immediately followed by an automatic one saying the same thing.
 */
export function stampBackfill(): void {
  setMeta(LAST_BACKFILL, new Date().toISOString());
  setMeta(BACKFILL_VERSION, String(CURRENT_BACKFILL_VERSION));
}

/**
 * Rebuild net-worth history if it's missing, gap-ridden, or was written by a
 * version of the code we've since fixed. Safe to call on every start and after
 * every daily refresh — it decides from counts first and only then does work.
 */
export async function catchUpHistory(): Promise<void> {
  const decision = decideBackfill(readBackfillFacts());
  if (!decision.run) {
    console.log(`[history] no backfill needed — ${decision.reason}`);
    return;
  }

  console.log(`[history] auto-backfill (${decision.mode}): ${decision.reason}`);
  const written = await backfillHistory({ onlyMissing: decision.mode === 'missing' });

  // Stamped only on success, so a failed run retries rather than being recorded
  // as done. The version stamp is what keeps a repair from running twice.
  stampBackfill();
  console.log(`[history] auto-backfill wrote ${written} snapshot(s)`);
}
