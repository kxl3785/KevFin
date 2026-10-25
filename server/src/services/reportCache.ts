import type Database from 'better-sqlite3';
import { getDb } from '../db/schema.js';
import { generateQuarterlyReport } from './report.js';
import { getReportWindow } from '../util/reportWindow.js';

// The quarterly report is built once and stored in report_cache (one row per
// quarter), so opening it is instant. Generation can take up to ~90 s because of
// the local-Claude sections; an explicit "Regenerate" is the only way to refresh.

export interface StoredReport { html: string; generatedAt: string }

// Test seams: production callers pass nothing.
export interface ReportCacheDeps {
  db?: Database.Database;
  generate?: (now: Date) => Promise<string>;
  now?: Date;
}

// One generation at a time per quarter, so concurrent requests (or a double-click
// on Regenerate) share a single run instead of spawning two Claude processes.
const inflight = new Map<string, Promise<StoredReport>>();

// The stored copy for the current report window's quarter, or null.
export function getStoredReport(deps: ReportCacheDeps = {}): (StoredReport & { quarterLabel: string }) | null {
  const db = deps.db ?? getDb();
  const { quarterLabel } = getReportWindow(deps.now ?? new Date());
  const row = db.prepare('SELECT html, generated_at FROM report_cache WHERE quarter_label = ?')
    .get(quarterLabel) as { html: string; generated_at: string } | undefined;
  return row ? { quarterLabel, html: row.html, generatedAt: row.generated_at } : null;
}

// Serve the stored report; generate (and store) it on a miss or when `fresh`.
// Whatever was generated is kept — even if the AI advisory fell back to the
// deterministic summary — and Regenerate is the escape hatch.
export function getQuarterlyReport(
  { fresh = false }: { fresh?: boolean } = {},
  deps: ReportCacheDeps = {},
): Promise<StoredReport> {
  const now = deps.now ?? new Date();
  const stored = fresh ? null : getStoredReport({ ...deps, now });
  if (stored) return Promise.resolve({ html: stored.html, generatedAt: stored.generatedAt });

  const { quarterLabel } = getReportWindow(now);
  const running = inflight.get(quarterLabel);
  if (running) return running;

  const db = deps.db ?? getDb();
  const generate = deps.generate ?? generateQuarterlyReport;
  const run = (async () => {
    const html = await generate(now);
    const generatedAt = new Date().toISOString();
    db.prepare(
      `INSERT INTO report_cache (quarter_label, html, generated_at) VALUES (?, ?, ?)
       ON CONFLICT(quarter_label) DO UPDATE SET html = excluded.html, generated_at = excluded.generated_at`,
    ).run(quarterLabel, html, generatedAt);
    return { html, generatedAt };
  })().finally(() => inflight.delete(quarterLabel));
  inflight.set(quarterLabel, run);
  return run;
}
