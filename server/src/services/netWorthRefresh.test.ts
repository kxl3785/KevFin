import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

// A refresh where one provider fails must still snapshot what synced, then raise an
// error whose message names the failed sources and is safe to put in a response body.
let dir: string;
let closeDb: () => void;
let db: Database.Database;

const simplefin = vi.fn<() => Promise<void>>();
const plaid = vi.fn<() => Promise<void>>();
const zillow = vi.fn<() => Promise<void>>();
vi.mock('./simplefin.js', () => ({ refreshAllAccounts: () => simplefin() }));
vi.mock('./plaid.js', () => ({ refreshAllPlaid: () => plaid() }));
vi.mock('./zillow.js', () => ({ refreshAllProperties: () => zillow() }));

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kevfin-refresh-'));
  process.env.DB_PATH = join(dir, 'test.db');
  vi.resetModules();
  simplefin.mockResolvedValue(undefined);
  plaid.mockResolvedValue(undefined);
  zillow.mockResolvedValue(undefined);
  const schema = await import('../db/schema.js');
  ({ closeDb } = schema);
  db = schema.getDb();
}, 60_000);

afterEach(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); });

describe('refreshAndSnapshot', () => {
  it('snapshots, then names the failed sources without leaking the raw error', async () => {
    // Imported after vi.resetModules so it's the same class netWorth.js sees (instanceof).
    const { ProviderRefreshError } = await import('./refreshErrors.js');
    plaid.mockRejectedValue(new ProviderRefreshError('Plaid', 3, [{ label: 'Chase', reason: 'ITEM_LOGIN_REQUIRED' }]));
    zillow.mockRejectedValue(new Error('GET https://api.example.com?apikey=SECRET-123 failed'));
    const { refreshAndSnapshot, RefreshFailedError } = await import('./netWorth.js');

    const err = await refreshAndSnapshot().then(() => null, e => e);
    expect(err).toBeInstanceOf(RefreshFailedError);
    expect(err.message).toBe("Couldn't refresh Chase (Plaid: ITEM_LOGIN_REQUIRED), real estate — everything else synced.");
    expect(err.message).not.toContain('SECRET');
    expect(err.sources).toEqual(['Plaid', 'real estate']);
    // the snapshot still happened despite the failures
    expect((db.prepare('SELECT COUNT(*) AS n FROM net_worth_snapshots').get() as { n: number }).n).toBe(1);
  });

  it('resolves quietly when every source succeeds', async () => {
    const { refreshAndSnapshot } = await import('./netWorth.js');
    await expect(refreshAndSnapshot()).resolves.toBeUndefined();
  });
});

describe('describeRefreshFailures', () => {
  it('lists each failed item with its provider and reason, and falls back to the source name', async () => {
    const { describeRefreshFailures } = await import('./netWorth.js');
    const { ProviderRefreshError } = await import('./refreshErrors.js');
    const m = new Map<string, unknown>([
      ['SimpleFIN', new ProviderRefreshError('SimpleFIN', 1, [{ label: 'Schwab', reason: 'HTTP 403' }])],
      ['Plaid', 'not a provider error'],
    ]);
    expect(describeRefreshFailures(m)).toBe("Couldn't refresh Schwab (SimpleFIN: HTTP 403), Plaid — everything else synced.");
  });

  it('caps the list at three and counts the rest', async () => {
    const { describeRefreshFailures } = await import('./netWorth.js');
    const { ProviderRefreshError } = await import('./refreshErrors.js');
    const failures = ['A', 'B', 'C', 'D', 'E'].map(label => ({ label, reason: 'ITEM_LOGIN_REQUIRED' }));
    const m = new Map<string, unknown>([['Plaid', new ProviderRefreshError('Plaid', 5, failures)]]);
    expect(describeRefreshFailures(m)).toBe(
      "Couldn't refresh A (Plaid: ITEM_LOGIN_REQUIRED), B (Plaid: ITEM_LOGIN_REQUIRED), C (Plaid: ITEM_LOGIN_REQUIRED), +2 more — everything else synced.");
  });
});
