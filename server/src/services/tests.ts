import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// This file lives in src/services (dev, via tsx) or dist/services (prod build);
// either way the server package root — and node_modules/.bin — is two levels up.
const SERVER_ROOT = path.join(__dirname, '../..');
const VITEST_BIN = path.join(SERVER_ROOT, 'node_modules/.bin/vitest');

// Vitest is a dev dependency, so it is absent from a production install. When the
// binary isn't there the feature is simply unavailable — same posture as the
// optional Claude assistant binary.
export function testsAvailable(): boolean {
  return existsSync(VITEST_BIN);
}

export interface TestCase {
  title: string;
  status: string; // 'passed' | 'failed' | 'skipped' | ...
  durationMs: number;
  failureMessages: string[];
}
export interface TestFile {
  name: string;
  status: string;
  tests: TestCase[];
}
export interface TestRunResult {
  available: boolean;
  success: boolean;
  durationMs: number;
  numTotal: number;
  numPassed: number;
  numFailed: number;
  files: TestFile[];
  error?: string;
}

// Strip terminal color codes so failure messages render cleanly in the browser.
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

// Shape of the Jest-compatible JSON report Vitest writes.
interface RawAssertion { fullName?: string; title?: string; status?: string; duration?: number; failureMessages?: string[] }
interface RawFile { name?: string; status?: string; assertionResults?: RawAssertion[] }
interface RawReport { success?: boolean; numTotalTests?: number; numPassedTests?: number; numFailedTests?: number; testResults?: RawFile[] }

/**
 * Run the server's unit test suite once and return a structured summary. The
 * command is fixed (no user input reaches the shell), runs in a separate process,
 * and uses isolated temp databases, so it never touches the live app or its data.
 */
export async function runTests(): Promise<TestRunResult> {
  const empty = { durationMs: 0, numTotal: 0, numPassed: 0, numFailed: 0, files: [] as TestFile[] };
  if (!testsAvailable()) {
    return { available: false, success: false, ...empty };
  }

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'kevfin-vitest-'));
  const outFile = path.join(tmpDir, 'results.json');
  const started = Date.now();
  try {
    try {
      await execFileAsync(
        VITEST_BIN,
        ['run', '--reporter=json', `--outputFile=${outFile}`],
        {
          cwd: SERVER_ROOT, timeout: 120_000, maxBuffer: 20 * 1024 * 1024,
          // Point DB_PATH at an isolated temp database so a test that opens the
          // default DB never touches the live one — important when this runs on
          // the NAS against real data.
          env: { ...process.env, CI: 'true', DB_PATH: path.join(tmpDir, 'test.db') },
        },
      );
    } catch {
      // Vitest exits non-zero when any test fails (or times out); the JSON report
      // is still written, so fall through and parse it.
    }

    const durationMs = Date.now() - started;
    if (!existsSync(outFile)) {
      return { available: true, success: false, ...empty, durationMs, error: 'Test runner produced no output.' };
    }

    const report = JSON.parse(readFileSync(outFile, 'utf8')) as RawReport;
    const files: TestFile[] = (report.testResults ?? []).map(f => ({
      name: f.name ? path.relative(SERVER_ROOT, f.name) || f.name : '(unknown)',
      status: f.status ?? 'unknown',
      tests: (f.assertionResults ?? []).map(a => ({
        title: a.fullName || a.title || '(unnamed test)',
        status: a.status ?? 'unknown',
        durationMs: a.duration ?? 0,
        failureMessages: (a.failureMessages ?? []).map(stripAnsi),
      })),
    }));

    return {
      available: true,
      success: !!report.success,
      durationMs,
      numTotal: report.numTotalTests ?? 0,
      numPassed: report.numPassedTests ?? 0,
      numFailed: report.numFailedTests ?? 0,
      files,
    };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
