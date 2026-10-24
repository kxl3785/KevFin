import { describe, it, expect, afterEach, vi } from 'vitest';
import { fetchZestimate } from './zillow.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.OPENWEBNINJA_KEY;
  delete process.env.APILLOW_KEY;
});

describe('fetchZestimate', () => {
  it('falls back to APILLOW when the primary provider throws (network error)', async () => {
    process.env.OPENWEBNINJA_KEY = 'x';
    process.env.APILLOW_KEY = 'y';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const json = (b: unknown) => ({ ok: true, status: 200, json: async () => b, text: async () => '' });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('openwebninja')) throw new TypeError('fetch failed');
      if (url.includes('/v1/properties')) return json({ job_id: 'j1' });
      return json({ status: 'complete', results: [{ property: { zestimate: 123456 } }] });
    }));
    // APILLOW polls with a 1.3s sleep; fake timers keep the test instant.
    vi.useFakeTimers();
    const p = fetchZestimate('1 Elm St');
    await vi.advanceTimersByTimeAsync(2000);
    expect(await p).toBe(123456);
    vi.useRealTimers();
  });

  it('returns null (does not throw) when every provider throws', async () => {
    process.env.OPENWEBNINJA_KEY = 'x';
    process.env.APILLOW_KEY = 'y';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    expect(await fetchZestimate('1 Elm St')).toBeNull();
  });
});
