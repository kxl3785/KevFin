import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Validation is pure; storage runs against a throwaway IN-MEMORY database
// (DB_PATH=':memory:' — no file is created), never the real data/kevfin.db.
type Mod = typeof import('./holdingProfiles.js');
let mod: Mod;
let setPref: typeof import('./prefs.js').setPref;
let closeDb: () => void;
let prevDbPath: string | undefined;

beforeEach(async () => {
  prevDbPath = process.env.DB_PATH;
  process.env.DB_PATH = ':memory:';
  vi.resetModules();
  const schema = await import('../db/schema.js');
  expect(schema.DB_PATH).toBe(':memory:');
  ({ closeDb } = schema);
  ({ setPref } = await import('./prefs.js'));
  mod = await import('./holdingProfiles.js');
}, 60_000);

afterEach(() => {
  vi.useRealTimers();
  closeDb();
  if (prevDbPath === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = prevDbPath;
});

describe('profileKey', () => {
  it('is the trimmed symbol, or the trimmed name when untickered (same as allocation holdingId)', () => {
    expect(mod.profileKey(' PDZJ ', 'BJC Trust')).toBe('PDZJ');
    expect(mod.profileKey('', '  Target 2040 Portfolio ')).toBe('Target 2040 Portfolio');
    expect(mod.profileKey('   ', 'Name')).toBe('Name');
  });
});

describe('primaryTicker', () => {
  it('is the heaviest part, ties going to the first', () => {
    expect(mod.primaryTicker([{ ticker: 'BND', weight: 0.4 }, { ticker: 'VTI', weight: 0.6 }])).toBe('VTI');
    expect(mod.primaryTicker([{ ticker: 'VTI', weight: 0.5 }, { ticker: 'BND', weight: 0.5 }])).toBe('VTI');
    expect(mod.primaryTicker([{ ticker: 'VFFVX', weight: 1 }])).toBe('VFFVX');
  });
});

describe('parseProfileBody', () => {
  it('accepts a single ticker and upper-cases it', () => {
    expect(mod.parseProfileBody({ id: ' PDZJ ', mix: [{ ticker: 'vffvx', weight: 1 }] }))
      .toEqual({ id: 'PDZJ', mix: [{ ticker: 'VFFVX', weight: 1 }] });
  });

  it('accepts a mix and normalizes the weights to exactly 1', () => {
    const r = mod.parseProfileBody({ id: 'X', mix: [{ ticker: 'VTI', weight: 0.333 }, { ticker: 'VXUS', weight: 0.333 }, { ticker: 'BND', weight: 0.333 }] });
    expect('mix' in r && r.mix).toBeTruthy();
    if (!('mix' in r) || !r.mix) return;
    expect(r.mix.reduce((s, p) => s + p.weight, 0)).toBeCloseTo(1, 12);
    expect(r.mix[0].weight).toBeCloseTo(1 / 3, 12);
  });

  it('treats null or a missing mix as a clear', () => {
    expect(mod.parseProfileBody({ id: 'X', mix: null })).toEqual({ id: 'X', mix: null });
    expect(mod.parseProfileBody({ id: 'X' })).toEqual({ id: 'X', mix: null });
  });

  it('requires an id of at most 200 characters', () => {
    expect(mod.parseProfileBody({ mix: null })).toHaveProperty('error');
    expect(mod.parseProfileBody({ id: '   ', mix: null })).toHaveProperty('error');
    expect(mod.parseProfileBody({ id: 'x'.repeat(201), mix: null })).toHaveProperty('error');
    expect(mod.parseProfileBody({ id: 'x'.repeat(200), mix: null })).not.toHaveProperty('error');
    expect(mod.parseProfileBody(null)).toHaveProperty('error');
    expect(mod.parseProfileBody('nope')).toHaveProperty('error');
  });

  it('refuses malformed mixes', () => {
    const bad = (mix: unknown) => expect(mod.parseProfileBody({ id: 'X', mix })).toHaveProperty('error');
    bad('VTI');                                                    // not a list
    bad([]);                                                       // empty
    bad(Array.from({ length: 11 }, (_, i) => ({ ticker: `T${i}`, weight: 1 / 11 }))); // too many
    bad([{ ticker: 'VT I', weight: 1 }]);                          // not a ticker
    bad([{ ticker: '', weight: 1 }]);
    bad([{ ticker: '.VTI', weight: 1 }]);
    bad([{ ticker: 'ABCDEFGHIJKLMNOP', weight: 1 }]);              // 16 chars
    bad([{ ticker: 'VTI', weight: 0.5 }, { ticker: 'vti', weight: 0.5 }]); // duplicate
    bad([{ ticker: 'VTI', weight: 0 }, { ticker: 'BND', weight: 1 }]);     // zero weight
    bad([{ ticker: 'VTI', weight: -0.2 }, { ticker: 'BND', weight: 1.2 }]);
    bad([{ ticker: 'VTI', weight: '1' }]);                         // string weight
    bad([{ ticker: 'VTI', weight: Number.NaN }]);
    bad([{ ticker: 'VTI', weight: 60 }, { ticker: 'BND', weight: 40 }]);   // percents, not fractions
    bad([{ ticker: 'VTI', weight: 0.6 }, { ticker: 'BND', weight: 0.3 }]); // sums to 0.9
    bad([null]);
  });

  it('allows rounding slack of 0.005 on the sum', () => {
    expect(mod.parseProfileBody({ id: 'X', mix: [{ ticker: 'VTI', weight: 0.6 }, { ticker: 'BND', weight: 0.404 }] })).not.toHaveProperty('error');
    expect(mod.parseProfileBody({ id: 'X', mix: [{ ticker: 'VTI', weight: 0.6 }, { ticker: 'BND', weight: 0.406 }] })).toHaveProperty('error');
  });

  it('accepts ticker punctuation used by real symbols', () => {
    for (const t of ['BRK.B', 'BRK-B', 'EURUSD=X', '0700.HK', 'ES=F']) {
      expect(mod.parseProfileBody({ id: 'X', mix: [{ ticker: t, weight: 1 }] })).not.toHaveProperty('error');
    }
  });
});

describe('storage', () => {
  it('starts empty', () => {
    expect(mod.getHoldingProfiles().size).toBe(0);
    expect(mod.getHoldingProfile('PDZJ', 'Trust')).toBeNull();
  });

  it('saves, reads back by symbol or by name, and clears', () => {
    mod.setHoldingProfile('PDZJ', [{ ticker: 'VFFVX', weight: 1 }]);
    mod.setHoldingProfile('Target 2040 Portfolio', [{ ticker: 'VTI', weight: 0.6 }, { ticker: 'BND', weight: 0.4 }]);
    expect(mod.getHoldingProfile(' PDZJ ', 'anything')).toEqual([{ ticker: 'VFFVX', weight: 1 }]);
    expect(mod.getHoldingProfile('', 'Target 2040 Portfolio')).toEqual([{ ticker: 'VTI', weight: 0.6 }, { ticker: 'BND', weight: 0.4 }]);
    expect(mod.getHoldingProfiles().size).toBe(2);

    mod.setHoldingProfile('PDZJ', null);
    expect(mod.getHoldingProfile('PDZJ', '')).toBeNull();
    expect(mod.getHoldingProfiles().size).toBe(1);
  });

  it('is tolerant of unreadable JSON', () => {
    setPref(mod.PROFILES_PREF, '{not json');
    expect(mod.getHoldingProfiles().size).toBe(0);
    setPref(mod.PROFILES_PREF, '[1,2,3]');
    vi.useFakeTimers({ now: Date.now() + 5000 }); // past the short read cache
    expect(mod.getHoldingProfiles().size).toBe(0);
  });

  it('skips bad entries but keeps good ones', () => {
    setPref(mod.PROFILES_PREF, JSON.stringify({
      GOOD: [{ ticker: 'vti', weight: 1 }],
      BADSUM: [{ ticker: 'VTI', weight: 0.5 }],
      NOTLIST: 'VTI',
      '  ': [{ ticker: 'VTI', weight: 1 }],
    }));
    const all = mod.getHoldingProfiles();
    expect([...all.keys()]).toEqual(['GOOD']);
    expect(all.get('GOOD')).toEqual([{ ticker: 'VTI', weight: 1 }]);
  });

  it('a save after a bad pref replaces it cleanly', () => {
    setPref(mod.PROFILES_PREF, '{not json');
    mod.setHoldingProfile('PDZJ', [{ ticker: 'VFFVX', weight: 1 }]);
    expect([...mod.getHoldingProfiles().keys()]).toEqual(['PDZJ']);
    expect(mod.getHoldingProfile('PDZJ', '')).toEqual([{ ticker: 'VFFVX', weight: 1 }]);
  });
});
