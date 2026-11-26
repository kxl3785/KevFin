import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { HomeGrowth } from './homeGrowth.js';

// getDb() resolves DB_PATH at module load, so each test gets a fresh temp file
// and a re-imported module graph (same pattern as mortgage.test.ts).
let dir: string;
let db: Database.Database;
let getHomeGrowth: (today?: string) => Promise<Record<number, HomeGrowth>>;
let closeDb: () => void;
let fetchMock: ReturnType<typeof vi.fn>;

const TODAY = '2026-06-01';

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kevfin-homegrowth-'));
  process.env.DB_PATH = join(dir, 'test.db');
  vi.resetModules();
  // No test may reach the network: a cached series must be enough.
  fetchMock = vi.fn(async () => { throw new Error('network disabled in tests'); });
  vi.stubGlobal('fetch', fetchMock);
  const schema = await import('../db/schema.js');
  ({ closeDb } = schema);
  db = schema.getDb();
  ({ getHomeGrowth } = await import('./homeGrowth.js'));
}, 60_000);

afterEach(() => {
  vi.unstubAllGlobals();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

function addProperty(address: string, value: number | null): number {
  return Number(db.prepare('INSERT INTO properties (address, zestimate) VALUES (?, ?)').run(address, value).lastInsertRowid);
}
function addPoint(id: number, date: string, value: number) {
  db.prepare('INSERT INTO property_value_history (property_id, date, value) VALUES (?, ?, ?)').run(id, date, value);
}
function cacheZip(zip: string, series: { date: string; value: number }[], fetchedAt = Date.now()) {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(`zhvi_${zip}`, JSON.stringify({ fetchedAt, series }));
}

describe('getHomeGrowth', () => {
  it("uses a home's own entered history, closed with today's value", async () => {
    const id = addProperty('1 Elm St, Austin, TX 78701', 500_000 * 1.05 ** 5);
    addPoint(id, '2021-06-01', 500_000);
    addPoint(id, '2024-06-01', 560_000);
    const g = (await getHomeGrowth(TODAY))[id];
    expect(g.source).toBe('history');
    expect(g.rate).toBeCloseTo(0.05, 3);
    expect(g.to).toBe(TODAY);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to the ZIP's index, whose rate ignores the home's own value", async () => {
    // The index says 6% a year; the home is worth 10× the ZIP's typical value.
    const id = addProperty('2 Oak St, Austin, TX 78702', 4_000_000);
    cacheZip('78702', [
      { date: '2021-04-30', value: 300_000 },
      { date: '2026-04-30', value: 300_000 * 1.06 ** 5 },
    ]);
    const g = (await getHomeGrowth(TODAY))[id];
    expect(g.source).toBe('zip');
    expect(g.rate).toBeCloseTo(0.06, 3);
    expect(g.to).toBe('2026-04-30');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers from an out-of-date cached index instead of waiting for a new one', async () => {
    const id = addProperty('3 Fir St, Austin, TX 78703', 800_000);
    cacheZip('78703', [
      { date: '2020-12-31', value: 400_000 },
      { date: '2025-12-31', value: 440_000 },
    ], Date.now() - 90 * 86_400_000);
    const g = (await getHomeGrowth(TODAY))[id];
    expect(g.source).toBe('zip');
    expect(g.to).toBe('2025-12-31');
  });

  it('prefers the ZIP index when the entered history is under a year long', async () => {
    const id = addProperty('4 Ash St, Austin, TX 78704', 700_000);
    addPoint(id, '2026-01-01', 650_000);
    cacheZip('78704', [
      { date: '2021-04-30', value: 300_000 },
      { date: '2026-04-30', value: 330_000 },
    ]);
    expect((await getHomeGrowth(TODAY))[id].source).toBe('zip');
  });

  it('leaves out a home with no usable history, without failing the others', async () => {
    const known = addProperty('5 Bay St, Austin, TX 78705', 500_000);
    const unknown = addProperty('6 Cedar St, Austin, TX 78706', 500_000); // ZIP never fetched; download fails
    const emptyZip = addProperty('7 Dove St, Austin, TX 78707', 500_000); // ZIP not in Zillow's file
    cacheZip('78705', [
      { date: '2021-04-30', value: 300_000 },
      { date: '2026-04-30', value: 330_000 },
    ]);
    cacheZip('78707', []);
    const out = await getHomeGrowth(TODAY);
    expect(out[known]).toBeDefined();
    expect(out[unknown]).toBeUndefined();
    expect(out[emptyZip]).toBeUndefined();
  });

  it('remembers a looked-up ZIP so the address is only sent to Zillow once', async () => {
    const id = addProperty('8 Elm St', 500_000); // no ZIP typed in
    cacheZip('78708', [
      { date: '2021-04-30', value: 300_000 },
      { date: '2026-04-30', value: 330_000 },
    ]);
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('autocomplete')) {
        return new Response(JSON.stringify({ results: [{ resultType: 'Address', metaData: { zipCode: '78708' } }] }));
      }
      throw new Error('unexpected request');
    });
    expect((await getHomeGrowth(TODAY))[id].source).toBe('zip');
    expect((await getHomeGrowth(TODAY))[id].source).toBe('zip');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
