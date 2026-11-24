import { describe, it, expect } from 'vitest';
import {
  rebalance, newMoneySplit, roundToSum, driftDisplay, deltaText, newMoneyHelp, negativeClasses, parseNewMoney,
} from './rebalance.ts';
import { RISK_PROFILES, ASSET_CLASS_META } from './riskProfiles.ts';

const sum = (xs: number[]) => xs.reduce((s, v) => s + v, 0);
const row = <T extends { key: string }>(rows: T[], key: string) => {
  const r = rows.find(x => x.key === key);
  if (!r) throw new Error(`no row ${key}`);
  return r;
};
const allFinite = (o: object) => Object.values(o).every(v => typeof v !== 'number' || Number.isFinite(v));

describe('roundToSum', () => {
  it('rounds to whole dollars that add up exactly to the target', () => {
    // −66.67 / +33.33 / +33.33 → floors −67, 33, 33 (sum −1) → one extra dollar
    // to the first of the tied remainders.
    expect(roundToSum([-200 / 3, 100 / 3, 100 / 3], 0)).toEqual([-66, 33, 33]);
  });
  it('keeps already-whole figures as they are', () => {
    expect(roundToSum([100, -40, -60], 0)).toEqual([100, -40, -60]);
  });
  it('never returns −0', () => {
    expect(Object.is(roundToSum([-0], 0)[0], 0)).toBe(true);
  });
  it('handles an empty list', () => {
    expect(roundToSum([], 0)).toEqual([]);
  });
});

describe('rebalance', () => {
  const targets = { A: 60, B: 30, C: 10 };

  it('works out actual %, drift, band and the dollars to get back (hand-computed)', () => {
    // Total 100,000. Targets 60/30/10 → 60,000 / 30,000 / 10,000.
    const r = rebalance({ A: 70_000, B: 25_000, C: 5_000 }, targets, 5, ['A', 'B', 'C']);
    expect(r.total).toBe(100_000);
    expect(r.comparable).toBe(true);
    expect(r.rows.map(x => x.key)).toEqual(['A', 'B', 'C']);
    expect(row(r.rows, 'A')).toMatchObject({ actualPct: 70, targetPct: 60, driftPts: 10, inBand: false, delta: -10_000 });
    expect(row(r.rows, 'B')).toMatchObject({ actualPct: 25, targetPct: 30, driftPts: -5, inBand: true, delta: 5_000 });
    expect(row(r.rows, 'C')).toMatchObject({ actualPct: 5, targetPct: 10, driftPts: -5, inBand: true, delta: 5_000 });
    expect(r.anyOutOfBand).toBe(true);
    expect(sum(r.rows.map(x => x.delta))).toBe(0);
  });

  it('counts exactly-at-the-edge drift as inside the band', () => {
    // 45 / 55 against 40 / 60 with a 5-point band: both exactly 5 points off.
    const r = rebalance({ A: 45, B: 55 }, { A: 40, B: 60 }, 5);
    expect(r.rows.every(x => x.inBand)).toBe(true);
    expect(r.anyOutOfBand).toBe(false);
    // Edge with float noise: 1/3 of the total against a 28.333…% target with a 5-point band.
    const r2 = rebalance({ A: 1, B: 2 }, { A: 85 / 3, B: 100 - 85 / 3 }, 5);
    expect(row(r2.rows, 'A').inBand).toBe(true);
    // Just past the edge is outside.
    const r3 = rebalance({ A: 45.01, B: 54.99 }, { A: 40, B: 60 }, 5);
    expect(row(r3.rows, 'A').inBand).toBe(false);
  });

  it('with a zero band, any drift is outside', () => {
    const r = rebalance({ A: 50.5, B: 49.5 }, { A: 50, B: 50 }, 0);
    expect(r.rows.every(x => !x.inBand)).toBe(true);
    const onTarget = rebalance({ A: 50, B: 50 }, { A: 50, B: 50 }, 0);
    expect(onTarget.rows.every(x => x.inBand && x.delta === 0)).toBe(true);
  });

  it('amounts sum to exactly zero after rounding, with cents and thirds', () => {
    const r = rebalance({ A: 100.37, B: 0.01, C: 999.99 }, { A: 1, B: 1, C: 1 }, 5);
    expect(sum(r.rows.map(x => x.delta))).toBe(0);
    for (const x of r.rows) {
      const raw = (x.targetPct / 100) * r.total - x.value;
      expect(Number.isInteger(x.delta)).toBe(true);
      expect(Math.abs(x.delta - raw)).toBeLessThan(1);
    }
  });

  it('amounts sum to exactly zero across many random portfolios', () => {
    // Deterministic pseudo-random sequence so a failure is reproducible.
    let seed = 42;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
    for (let t = 0; t < 300; t++) {
      const values: Record<string, number> = {};
      const tg: Record<string, number> = {};
      for (const k of ['A', 'B', 'C', 'D', 'E', 'F']) {
        if (rnd() < 0.8) values[k] = Math.round(rnd() * 5_000_000) / 100;
        if (rnd() < 0.7) tg[k] = Math.round(rnd() * 1000) / 10;
      }
      const r = rebalance(values, tg, 5);
      expect(sum(r.rows.map(x => x.delta))).toBe(0);
      for (const x of r.rows) expect(allFinite(x)).toBe(true);
    }
  });

  it('an empty portfolio gives zero amounts and no NaN', () => {
    const r = rebalance({}, targets, 5, ['A', 'B', 'C']);
    expect(r.total).toBe(0);
    expect(r.comparable).toBe(false);
    expect(r.rows.map(x => x.key)).toEqual(['A', 'B', 'C']);
    for (const x of r.rows) {
      expect(allFinite(x)).toBe(true);
      expect(x.actualPct).toBe(0);
      expect(x.delta).toBe(0);
      expect(x.driftPts).toBe(0);
    }
  });

  it('nothing at all gives no rows', () => {
    const r = rebalance({}, {}, 5);
    expect(r.rows).toEqual([]);
    expect(r.comparable).toBe(false);
    expect(r.anyOutOfBand).toBe(false);
  });

  it('a class held but not in the targets has a 0% target and is trimmed in full', () => {
    const r = rebalance({ A: 600, C: 400 }, { A: 100 }, 5);
    expect(row(r.rows, 'C')).toMatchObject({ targetPct: 0, actualPct: 40, driftPts: 40, inBand: false, delta: -400 });
    expect(row(r.rows, 'A')).toMatchObject({ targetPct: 100, delta: 400 });
  });

  it('a target class not held shows 0% now and the full target amount', () => {
    const r = rebalance({ A: 1000 }, { A: 60, B: 40 }, 5, ['A', 'B']);
    expect(row(r.rows, 'B')).toMatchObject({ value: 0, actualPct: 0, targetPct: 40, driftPts: -40, inBand: false, delta: 400 });
  });

  it('100% in one class', () => {
    const r = rebalance({ A: 250_000 }, { A: 50, B: 30, C: 20 }, 5);
    expect(row(r.rows, 'A')).toMatchObject({ actualPct: 100, driftPts: 50, delta: -125_000 });
    expect(row(r.rows, 'B').delta).toBe(75_000);
    expect(row(r.rows, 'C').delta).toBe(50_000);
    expect(sum(r.rows.map(x => x.delta))).toBe(0);
  });

  it('treats negative and non-finite values and targets as zero', () => {
    const r = rebalance({ A: -500, B: 1000, C: NaN, D: Infinity }, { A: 50, B: 50, C: -10, D: NaN }, 5);
    expect(r.total).toBe(1000);
    expect(r.rows.map(x => x.key).sort()).toEqual(['A', 'B']);
    expect(row(r.rows, 'A')).toMatchObject({ value: 0, delta: 500 });
    expect(row(r.rows, 'B')).toMatchObject({ value: 1000, delta: -500 });
  });

  it('renormalises targets that do not add up to 100', () => {
    const r = rebalance({ A: 100, B: 100 }, { A: 30, B: 10 }, 5);
    expect(row(r.rows, 'A').targetPct).toBeCloseTo(75);
    expect(row(r.rows, 'B').targetPct).toBeCloseTo(25);
    expect(row(r.rows, 'A').delta).toBe(50);
  });

  it('puts the given order first, then other classes by size', () => {
    const r = rebalance({ X: 5, Y: 50, A: 10 }, { B: 100 }, 5, ['A', 'B']);
    expect(r.rows.map(x => x.key)).toEqual(['A', 'B', 'Y', 'X']);
  });
});

describe('newMoneySplit', () => {
  it('money that covers every gap lands each class exactly on target', () => {
    // Total 100 + 1000 = 1100 → targets 550 / 550 → adds 470 / 530.
    const r = newMoneySplit({ A: 80, B: 20 }, { A: 50, B: 50 }, 1000);
    expect(row(r.rows, 'A').add).toBe(470);
    expect(row(r.rows, 'B').add).toBe(530);
    expect(r.reachesTarget).toBe(true);
    expect(row(r.rows, 'A').afterPct).toBeCloseTo(50);
  });

  it('new money larger than every gap: already on target, split by weight', () => {
    const r = newMoneySplit({ A: 600, B: 300, C: 100 }, { A: 60, B: 30, C: 10 }, 10_000);
    expect(r.rows.map(x => x.add)).toEqual([6000, 3000, 1000]);
    expect(r.reachesTarget).toBe(true);
    expect(sum(r.rows.map(x => x.add))).toBe(10_000);
  });

  it('a small amount goes only to the most underweight class', () => {
    // A 80 / B 20 against 50 / 50: $10 all to B.
    const r = newMoneySplit({ A: 80, B: 20 }, { A: 50, B: 50 }, 10);
    expect(row(r.rows, 'A').add).toBe(0);
    expect(row(r.rows, 'B').add).toBe(10);
    expect(r.reachesTarget).toBe(false);
  });

  it('water-fills: tops up the lowest until it meets the next, then both by weight', () => {
    // Targets 50/30/20 of the weights; values A 500, B 100, C 0.
    // value/weight: C 0, B 333.3, A 1000. With $300:
    //   C alone: level = 300 / 0.2 = 1500 > 333.3 → add B.
    //   C+B: level = (300 + 100) / 0.5 = 800 ≤ 1000 → stop.
    //   adds: C 0.2·800 − 0 = 160, B 0.3·800 − 100 = 140, A 0.
    const r = newMoneySplit({ A: 500, B: 100, C: 0 }, { A: 50, B: 30, C: 20 }, 300, ['A', 'B', 'C']);
    expect(r.rows.map(x => x.add)).toEqual([0, 140, 160]);
    expect(r.reachesTarget).toBe(false);
  });

  it('never sells: no add is negative, and an overweight class gets nothing', () => {
    const r = newMoneySplit({ A: 900, B: 100 }, { A: 50, B: 50 }, 500);
    for (const x of r.rows) expect(x.add).toBeGreaterThanOrEqual(0);
    expect(row(r.rows, 'A').add).toBe(0);
    expect(row(r.rows, 'B').add).toBe(500);
  });

  it('adds sum to the whole-dollar amount, even with cents and thirds', () => {
    const r = newMoneySplit({ A: 10.5, B: 0, C: 3.25 }, { A: 1, B: 1, C: 1 }, 1000.4);
    expect(r.amount).toBe(1000);
    expect(sum(r.rows.map(x => x.add))).toBe(1000);
    for (const x of r.rows) expect(Number.isInteger(x.add)).toBe(true);
  });

  it('an empty portfolio splits by target weight', () => {
    const r = newMoneySplit({}, { A: 60, B: 40 }, 5000);
    expect(r.rows.map(x => x.add)).toEqual([3000, 2000]);
    expect(r.reachesTarget).toBe(true);
    expect(row(r.rows, 'A').afterPct).toBeCloseTo(60);
  });

  it('a class held but not in the targets gets none, so the target is never quite reached', () => {
    const r = newMoneySplit({ A: 100, C: 100 }, { A: 100 }, 1000);
    expect(row(r.rows, 'C').add).toBe(0);
    expect(row(r.rows, 'A').add).toBe(1000);
    expect(r.reachesTarget).toBe(false);
    // …but every targeted class was topped up, and C is named as the reason.
    expect(r.coversShortfalls).toBe(true);
    expect(r.heldWithoutTarget).toEqual(['C']);
  });

  it('a target class not held gets money first', () => {
    const r = newMoneySplit({ A: 1000 }, { A: 60, B: 40 }, 200, ['A', 'B']);
    expect(row(r.rows, 'B').add).toBe(200);
    expect(row(r.rows, 'A').add).toBe(0);
  });

  it('100% in one class: new money goes to the others in target proportion', () => {
    // A 1000 against 50/30/20; $500 → B, C split by weight: level = 500 / 0.5 = 1000
    // ≤ A's 1000 / 0.5 = 2000, so B 300, C 200.
    const r = newMoneySplit({ A: 1000 }, { A: 50, B: 30, C: 20 }, 500, ['A', 'B', 'C']);
    expect(r.rows.map(x => x.add)).toEqual([0, 300, 200]);
  });

  it('zero, negative or non-finite amounts add nothing and stay finite', () => {
    for (const amt of [0, -100, NaN, Infinity, 0.4]) {
      const r = newMoneySplit({ A: 80, B: 20 }, { A: 50, B: 50 }, amt);
      expect(r.amount).toBe(0);
      expect(r.rows.every(x => x.add === 0 && allFinite(x))).toBe(true);
      expect(r.reachesTarget).toBe(false);
    }
  });

  it('no targets: nothing is split', () => {
    const r = newMoneySplit({ A: 100 }, {}, 1000);
    expect(r.amount).toBe(0);
    expect(r.rows.every(x => x.add === 0)).toBe(true);
  });

  it('adds always sum to the amount across many random portfolios', () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
    for (let t = 0; t < 300; t++) {
      const values: Record<string, number> = {};
      const tg: Record<string, number> = {};
      for (const k of ['A', 'B', 'C', 'D', 'E']) {
        if (rnd() < 0.8) values[k] = Math.round(rnd() * 1_000_000) / 100;
        if (rnd() < 0.7) tg[k] = Math.round(rnd() * 1000) / 10;
      }
      const amt = Math.round(rnd() * 2_000_000) / 100;
      const r = newMoneySplit(values, tg, amt);
      const hasTarget = Object.values(tg).some(v => v > 0);
      expect(sum(r.rows.map(x => x.add))).toBe(hasTarget ? Math.round(amt) : 0);
      for (const x of r.rows) {
        expect(x.add).toBeGreaterThanOrEqual(0);
        expect(allFinite(x)).toBe(true);
      }
    }
  });
});

const META = ASSET_CLASS_META.map(m => m.key as string);
const moderate = RISK_PROFILES.moderate.model; // 38 / 22 / 30 / 6 / 4 / Crypto 0
const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;

describe('newMoneySplit with a held 0%-target class (RB-1 / RBUI-1)', () => {
  // Targeted holdings sit exactly on the Moderate mix (100,000 split 38/22/30/6/4);
  // $1,000 of crypto has a 0% target.
  const onMix = { 'Domestic Stock': 38_000, 'Foreign Stock': 22_000, Bonds: 30_000, 'Short Term': 6_000, Commodities: 4_000, Crypto: 1_000 };

  it('a large amount tops up every targeted kind; no amount reaches target, and Crypto is named', () => {
    const s = newMoneySplit(onMix, moderate, 1_000_000, META);
    // Already on the mix, so the $1,000,000 splits by weight: 380k / 220k / 300k / 60k / 40k, Crypto none.
    expect(s.rows.map(r => r.add)).toEqual([380_000, 220_000, 300_000, 60_000, 40_000, 0]);
    expect(s.reachesTarget).toBe(false); // Crypto stays $1,000 over its $0 target
    expect(s.coversShortfalls).toBe(true);
    expect(s.heldWithoutTarget).toEqual(['Crypto']);
    // Domestic ends at 418,000 of 1,101,000 = 37.97%, just under 38%.
    expect(row(s.rows, 'Domestic Stock').afterPct).toBeCloseTo((418_000 / 1_101_000) * 100, 6);
    // Same at $100 million: still covered, still not "reached".
    const huge = newMoneySplit(onMix, moderate, 100_000_000, META);
    expect(huge.coversShortfalls).toBe(true);
    expect(huge.reachesTarget).toBe(false);
  });

  it('a small amount that cannot top everything up does not cover the shortfalls', () => {
    // Domestic 50,000 is overweight; $1,000 goes to the other four only:
    // level = (1,000 + 62,000) / 0.62 = 101,612.90 → Foreign 354.84, Bonds 483.87,
    // Short Term 96.77, Commodities 64.52 (rounded to sum to 1,000).
    const s = newMoneySplit({ ...onMix, 'Domestic Stock': 50_000 }, moderate, 1_000, META);
    expect(s.rows.map(r => r.add)).toEqual([0, 355, 484, 97, 64, 0]);
    expect(s.coversShortfalls).toBe(false);
    expect(s.reachesTarget).toBe(false);
    expect(s.heldWithoutTarget).toEqual(['Crypto']);
  });

  it('without the crypto, the same money reaches target and nothing is listed', () => {
    const { Crypto: _c, ...noCrypto } = onMix;
    const s = newMoneySplit(noCrypto, moderate, 1_000_000, META);
    expect(s.reachesTarget).toBe(true);
    expect(s.coversShortfalls).toBe(true);
    expect(s.heldWithoutTarget).toEqual([]);
  });

  it('dust under 50 cents in a 0%-target class is ignored', () => {
    const s = newMoneySplit({ ...onMix, Crypto: 0.4 }, moderate, 1_000_000, META);
    expect(s.heldWithoutTarget).toEqual([]);
    expect(s.reachesTarget).toBe(true);
  });

  it('the help line says which case applies', () => {
    const label = (k: string) => (k === 'Crypto' ? 'Crypto' : k);
    const covered = newMoneyHelp(newMoneySplit(onMix, moderate, 1_000_000, META), usd, label);
    expect(covered).toBe('How $1,000,000 would split so every kind with a target is topped up evenly, without selling anything. ' +
      'Crypto has a 0% target and this never sells, so the other kinds land slightly under their targets.');
    expect(covered).not.toMatch(/isn't enough/);
    const short = newMoneyHelp(newMoneySplit({ ...onMix, 'Domestic Stock': 50_000 }, moderate, 1_000, META), usd, label);
    expect(short).toMatch(/^How \$1,000 would split to move toward the targets without selling anything\. It isn't enough to top up every kind/);
    expect(short).toMatch(/Crypto has a 0% target/);
    // Unchanged wording when nothing is held outside the targets.
    expect(newMoneyHelp(newMoneySplit({ A: 80, B: 20 }, { A: 50, B: 50 }, 1000), usd))
      .toBe('How $1,000 would split so every kind lands on target, without selling anything.');
    expect(newMoneyHelp(newMoneySplit({ A: 80, B: 20 }, { A: 50, B: 50 }, 10), usd))
      .toBe("How $10 would split to move toward the targets without selling anything. It isn't enough to reach every target, so the kinds furthest below come first.");
    // Two held 0%-target classes read as a list.
    expect(newMoneyHelp({ amount: 5, reachesTarget: false, coversShortfalls: true, heldWithoutTarget: ['X', 'Y'] }, usd))
      .toMatch(/X and Y have a 0% target/);
  });
});

describe('driftDisplay (RB-2)', () => {
  it('a row just past the band edge shows two decimals, never "5 points" beside "Outside band"', () => {
    // 45,040 / 54,960 against 40 / 60 with ±5: drift +5.04 / −5.04, both outside.
    const r = rebalance({ A: 45_040, B: 54_960 }, { A: 40, B: 60 }, 5);
    expect(row(r.rows, 'A').inBand).toBe(false);
    expect(driftDisplay(row(r.rows, 'A'), 5)).toEqual({ nowText: '45.04%', driftText: '5.04 points above' });
    expect(driftDisplay(row(r.rows, 'B'), 5)).toEqual({ nowText: '54.96%', driftText: '5.04 points below' });
  });
  it('a drift too small for two decimals reads "just over"', () => {
    const r = rebalance({ A: 45_004, B: 54_996 }, { A: 40, B: 60 }, 5);
    expect(driftDisplay(row(r.rows, 'A'), 5)).toEqual({ nowText: '45.00%', driftText: 'just over 5 points above' });
    expect(driftDisplay({ actualPct: 50.001, driftPts: 0.001, inBand: false }, 0).driftText).toBe('slightly above');
  });
  it('keeps one decimal everywhere else', () => {
    const r = rebalance({ A: 70_000, B: 25_000, C: 5_000 }, { A: 60, B: 30, C: 10 }, 5, ['A', 'B', 'C']);
    expect(driftDisplay(row(r.rows, 'A'), 5)).toEqual({ nowText: '70.0%', driftText: '10 points above' });
    expect(driftDisplay(row(r.rows, 'B'), 5)).toEqual({ nowText: '25.0%', driftText: '5 points below' });
    expect(driftDisplay({ actualPct: 41, driftPts: 1, inBand: true }, 5).driftText).toBe('1 point above');
    expect(driftDisplay({ actualPct: 40.03, driftPts: 0.03, inBand: true }, 5)).toEqual({ nowText: '40.0%', driftText: 'on target' });
    // In band at 4.96 rounds to "5 points" — consistent, since the edge counts as inside.
    expect(driftDisplay({ actualPct: 44.96, driftPts: 4.96, inBand: true }, 5).driftText).toBe('5 points above');
    // Zero band: a tiny drift is outside, so it isn't called "on target".
    expect(driftDisplay({ actualPct: 50.03, driftPts: 0.03, inBand: false }, 0).driftText).toBe('0.03 points above');
  });
});

describe('deltaText (RBUI-5)', () => {
  it('a delta that rounds to $0 reads "Under $1", never "−$0"', () => {
    // $1 in Domestic Stock under Moderate: four kinds are far outside the band
    // yet each needs less than a dollar.
    const r = rebalance({ 'Domestic Stock': 1 }, moderate, 5, META);
    const zeroOut = r.rows.filter(x => !x.inBand && x.delta === 0);
    expect(zeroOut.length).toBeGreaterThan(0);
    for (const x of zeroOut) expect(deltaText(x.delta, usd)).toBe('Under $1');
    expect(deltaText(5_000, usd)).toBe('+$5,000');
    expect(deltaText(-5_040, usd)).toBe('−$5,040');
    // The page's privacy masking still applies.
    expect(deltaText(-5_040, () => '••••••')).toBe('−••••••');
    expect(deltaText(0, () => '••••••')).toBe('Under ••••••');
  });
});

describe('negativeClasses (RB-3)', () => {
  it('lists kinds that net below zero, which rebalance() counts as $0', () => {
    const values = { 'Domestic Stock': 100_000, Bonds: 50_000, 'Short Term': -10_000, Crypto: -0.4 };
    expect(negativeClasses(values, META)).toEqual([{ key: 'Short Term', value: -10_000 }]);
    // The worksheet total leaves the negative out: 100,000 / 150,000 = 66.67%.
    const r = rebalance(values, { 'Domestic Stock': 60, Bonds: 30, 'Short Term': 10 }, 5, META);
    expect(r.total).toBe(150_000);
    expect(negativeClasses({ A: 5 })).toEqual([]);
  });
});

describe('parseNewMoney (RB-5 / RBUI-4)', () => {
  it('reads plain amounts, commas, cents and a leading $', () => {
    expect(parseNewMoney('10000')).toEqual({ value: 10_000 });
    expect(parseNewMoney(' 10,000 ')).toEqual({ value: 10_000 });
    expect(parseNewMoney('$1,234.56')).toEqual({ value: 1234.56 });
    expect(parseNewMoney('$ 20')).toEqual({ value: 20 });
    expect(parseNewMoney('.5')).toEqual({ value: 0.5 });
    expect(parseNewMoney('0')).toEqual({ value: 0 });
  });
  it('blank means no new money', () => {
    expect(parseNewMoney('')).toBeNull();
    expect(parseNewMoney('   ')).toBeNull();
  });
  it('refuses "10k", "1e6" and other text instead of misreading it', () => {
    for (const t of ['10k', '1e6', '1.5m', '1.2.3', '1,00', 'abc', '$', '10 000']) {
      expect(parseNewMoney(t)).toEqual({ error: 'Enter a dollar amount, like 10,000.' });
    }
    expect(parseNewMoney('-500')).toEqual({ error: 'Enter an amount of zero or more.' });
    expect(parseNewMoney('$-500')).toEqual({ error: 'Enter an amount of zero or more.' });
  });
});
