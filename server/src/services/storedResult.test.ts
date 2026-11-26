import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The store is swapped for an in-memory map (JSON round-tripped, as the real
// table does) so this test never touches a database. It outlives a module
// reset, which is how a server restart is played here: the module's memory is
// gone, the stored rows are not.
const table = new Map<string, { fetchedAt: number; payload: string }>();
vi.mock('../db/providerCache.js', () => ({
  readProviderCache: (k: string) => {
    const row = table.get(k);
    return row ? { fetchedAt: row.fetchedAt, payload: JSON.parse(row.payload) } : null;
  },
  writeProviderCache: (k: string, e: { fetchedAt: number; payload: unknown }) => {
    table.set(k, { fetchedAt: e.fetchedAt, payload: JSON.stringify(e.payload) });
  },
  listProviderCache: (prefix: string) => [...table.keys()].filter(k => k.startsWith(prefix)).sort().map(key => ({ key, fetchedAt: table.get(key)!.fetchedAt })),
  deleteProviderCachePrefix: (prefix: string) => { for (const k of [...table.keys()]) if (k.startsWith(prefix)) table.delete(k); },
}));

type Mod = typeof import('./storedResult.js');
let mod: Mod;
let health: typeof import('./lookupHealth.js');

const T0 = Date.UTC(2026, 5, 10, 12, 0, 0); // midday, so a few hours either way stay on one UTC day
const HOUR = 3600 * 1000;
const MIN = 60 * 1000;

// What the computation reads. `fp` is the fingerprint of it; `answer` what a
// computation started now would return.
let fp = { edits: 'e1', feed: 'f1' };
let answer = 'first';
let computes = 0;
const spec = () => ({
  key: 'result:test',
  fingerprint: () => ({ ...fp }),
  compute: async () => { computes++; return { answer, n: computes }; },
});
// Let background recomputes (which nobody awaits) finish.
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

async function boot() {
  vi.resetModules();
  mod = await import('./storedResult.js');
  health = await import('./lookupHealth.js');
}

beforeEach(async () => {
  table.clear();
  fp = { edits: 'e1', feed: 'f1' };
  answer = 'first';
  computes = 0;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  await boot();
});

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('serveStored', () => {
  it('computes once, then serves the stored copy', async () => {
    const a = await mod.serveStored(spec());
    expect(a).toEqual({ value: { answer: 'first', n: 1 }, computedAt: T0, refreshing: false });

    vi.setSystemTime(T0 + HOUR);
    answer = 'would be second';
    const b = await mod.serveStored(spec());
    expect(b).toEqual({ value: { answer: 'first', n: 1 }, computedAt: T0, refreshing: false });
    expect(computes).toBe(1);
  });

  it('after a restart, serves the stored copy at once and refreshes it behind', async () => {
    await mod.serveStored(spec());
    vi.setSystemTime(T0 + MIN);
    await boot(); // the process restarts: memory gone, the stored row remains
    answer = 'second';

    const stale = await mod.serveStored(spec());
    expect(stale).toEqual({ value: { answer: 'first', n: 1 }, computedAt: T0, refreshing: true });

    await settle();
    const fresh = await mod.serveStored(spec());
    expect(fresh).toEqual({ value: { answer: 'second', n: 2 }, computedAt: T0 + MIN, refreshing: false });
    expect(computes).toBe(2);
  });

  it('never serves the stored copy after an edit: the caller waits for a recompute', async () => {
    await mod.serveStored(spec());
    fp.edits = 'e2';
    answer = 'after the edit';
    const b = await mod.serveStored(spec());
    expect(b.value).toEqual({ answer: 'after the edit', n: 2 });
    expect(b.refreshing).toBe(false);
    // ...and that is now the stored copy.
    expect((await mod.serveStored(spec())).value).toEqual({ answer: 'after the edit', n: 2 });
    expect(computes).toBe(2);
  });

  it('serves the stored copy while it recomputes after a sync', async () => {
    await mod.serveStored(spec());
    fp.feed = 'f2';
    answer = 'after the sync';
    const stale = await mod.serveStored(spec());
    expect(stale.value).toEqual({ answer: 'first', n: 1 });
    expect(stale.refreshing).toBe(true);
    await settle();
    expect(await mod.serveStored(spec())).toMatchObject({ value: { answer: 'after the sync', n: 2 }, refreshing: false });
  });

  it('recomputes behind a copy that has aged past freshMs', async () => {
    await mod.serveStored(spec());
    vi.setSystemTime(T0 + 6 * HOUR - MIN);
    expect((await mod.serveStored(spec())).refreshing).toBe(false);

    vi.setSystemTime(T0 + 6 * HOUR + MIN);
    answer = 'second';
    const stale = await mod.serveStored(spec());
    expect(stale).toMatchObject({ value: { answer: 'first' }, computedAt: T0, refreshing: true });
    await settle();
    expect(await mod.serveStored(spec())).toMatchObject({ value: { answer: 'second' }, computedAt: T0 + 6 * HOUR + MIN, refreshing: false });
  });

  it('treats a copy from another UTC day as stale, however recent', async () => {
    vi.setSystemTime(Date.UTC(2026, 5, 10, 23, 50));
    await boot();
    await mod.serveStored(spec());
    vi.setSystemTime(Date.UTC(2026, 5, 11, 0, 10)); // 20 minutes later, a new day: prices have a new end date
    expect((await mod.serveStored(spec())).refreshing).toBe(true);
  });

  it('shares one computation between concurrent first loads', async () => {
    const all = await Promise.all([mod.serveStored(spec()), mod.serveStored(spec()), mod.serveStored(spec())]);
    expect(computes).toBe(1);
    expect(all.map(s => s.value.n)).toEqual([1, 1, 1]);
  });

  it('starts one background recompute however many loads see the stale copy', async () => {
    await mod.serveStored(spec());
    fp.feed = 'f2';
    const all = await Promise.all([mod.serveStored(spec()), mod.serveStored(spec()), mod.serveStored(spec())]);
    expect(all.every(s => s.refreshing && s.value.n === 1)).toBe(true);
    await settle();
    expect(computes).toBe(2);
  });

  it('does not hand a caller the result of a recompute that began before their edit', async () => {
    // A slow first computation, started from the inputs as they were.
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const slow = { ...spec(), compute: async () => { computes++; const seen = answer; await gate; return { answer: seen, n: 1 }; } };
    const early = mod.serveStored(slow);
    await settle();

    // The user edits while it runs, and the page fetches again.
    fp.edits = 'e2';
    answer = 'after the edit';
    const late = await mod.serveStored(spec());
    expect(late.value.answer).toBe('after the edit');

    // The early one still gets its own (older) answer, but it is not stored
    // over the newer one.
    release();
    expect((await early).value.answer).toBe('first');
    expect((await mod.serveStored(spec())).value.answer).toBe('after the edit');
  });

  it('rejects when there is nothing stored and the computation fails, and tries again next time', async () => {
    const failing = { ...spec(), compute: async () => { throw new Error('boom'); } };
    await expect(mod.serveStored(failing)).rejects.toThrow('boom');
    expect((await mod.serveStored(spec())).value.answer).toBe('first');
  });

  it('keeps serving the stored copy when a background recompute fails, without retrying on every load', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await mod.serveStored(spec());
    fp.feed = 'f2';
    let attempts = 0;
    const failing = { ...spec(), compute: async () => { attempts++; throw new Error('provider down'); } };

    expect(await mod.serveStored(failing)).toMatchObject({ value: { answer: 'first' }, refreshing: true });
    await settle();
    // Backed off: the copy is served, but no new attempt is started yet.
    expect(await mod.serveStored(failing)).toMatchObject({ value: { answer: 'first' }, refreshing: false });
    expect(attempts).toBe(1);

    vi.setSystemTime(T0 + 3 * MIN);
    expect((await mod.serveStored(failing)).refreshing).toBe(true);
    await settle();
    expect(attempts).toBe(2);
  });
});

describe('a recompute that never finishes', () => {
  it('stops counting after a while, so the stored copy is not "refreshing" for good', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await mod.serveStored(spec());
    fp.feed = 'f2';
    const hung = { ...spec(), compute: () => new Promise<{ answer: string; n: number }>(() => {}) }; // a provider request that never returns
    expect((await mod.serveStored(hung)).refreshing).toBe(true);
    vi.setSystemTime(T0 + MIN);
    expect((await mod.serveStored(spec())).refreshing).toBe(true); // still the same one: no second recompute yet
    expect(computes).toBe(1);

    vi.setSystemTime(T0 + 6 * MIN);
    answer = 'second';
    expect(await mod.serveStored(spec())).toMatchObject({ value: { answer: 'first' }, refreshing: true });
    await settle();
    expect(await mod.serveStored(spec())).toMatchObject({ value: { answer: 'second' }, refreshing: false });
  });
});

describe('a result built while a provider lookup was failing', () => {
  const degradedSpec = () => ({ ...spec(), compute: async () => { computes++; health.noteLookupFailure(); return { answer, n: computes }; } });

  it('is kept only briefly', async () => {
    const a = await mod.serveStored(degradedSpec());
    expect(a.value.n).toBe(1); // the caller still gets it: it is the best answer there is

    vi.setSystemTime(T0 + MIN);
    expect((await mod.serveStored(spec())).refreshing).toBe(false);
    vi.setSystemTime(T0 + 3 * MIN); // a healthy result would be good for hours
    answer = 'second';
    expect(await mod.serveStored(spec())).toMatchObject({ value: { answer: 'first' }, refreshing: true });
    await settle();
    expect(await mod.serveStored(spec())).toMatchObject({ value: { answer: 'second' }, refreshing: false });
  });

  it('never replaces a good copy of the same inputs', async () => {
    await mod.serveStored(spec());
    vi.setSystemTime(T0 + 7 * HOUR); // aged: the next load recomputes behind
    answer = 'built on a failed lookup';
    expect((await mod.serveStored(degradedSpec())).refreshing).toBe(true);
    await settle();

    const after = await mod.serveStored(degradedSpec());
    expect(after).toMatchObject({ value: { answer: 'first', n: 1 }, computedAt: T0, refreshing: false });
    expect(computes).toBe(2); // and it is not re-attempted on every load

    // Once the provider is back, a later load refreshes it.
    vi.setSystemTime(T0 + 7 * HOUR + 3 * MIN);
    answer = 'second';
    expect((await mod.serveStored(spec())).refreshing).toBe(true);
    await settle();
    expect((await mod.serveStored(spec())).value.answer).toBe('second');
  });

  it('does replace a copy from before a sync: new balances beat a perfect look-through', async () => {
    await mod.serveStored(spec());
    fp.feed = 'f2';
    answer = 'new balances';
    await mod.serveStored(degradedSpec());
    await settle();
    expect((await mod.serveStored(spec())).value.answer).toBe('new balances');
  });
});

describe('refreshStored', () => {
  it('leaves a current copy alone', async () => {
    await mod.serveStored(spec());
    mod.refreshStored(spec());
    await settle();
    expect(computes).toBe(1);
  });

  it('recomputes a stale copy with nobody waiting, so the next load is served current', async () => {
    await mod.serveStored(spec());
    fp.feed = 'f2';
    answer = 'second';
    mod.refreshStored(spec());
    mod.refreshStored(spec()); // already running for these inputs: no second one
    await settle();
    expect(computes).toBe(2);
    expect(await mod.serveStored(spec())).toMatchObject({ value: { answer: 'second' }, refreshing: false });
    expect(computes).toBe(2);
  });

  it('is joined by a load that arrives while it runs after an edit', async () => {
    await mod.serveStored(spec());
    fp.edits = 'e2';
    answer = 'after the edit';
    mod.refreshStored(spec());
    const during = await mod.serveStored(spec());
    expect(during.value).toEqual({ answer: 'after the edit', n: 2 });
    expect(computes).toBe(2);
  });
});

describe('clearStoredResults', () => {
  it('forgets every stored result, in memory and in the table', async () => {
    await mod.serveStored(spec());
    expect(mod.storedResultKeys()).toEqual(['result:test']);
    mod.clearStoredResults();
    expect(mod.storedResultKeys()).toEqual([]);
    answer = 'second';
    expect((await mod.serveStored(spec())).value.answer).toBe('second');
  });
});
