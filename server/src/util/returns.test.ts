import { describe, it, expect } from 'vitest';
import {
  annualize, timeWeightedReturn, moneyWeightedReturn, xirr, solveSpanRate, suspiciousJumps, daysBetween,
  dropBalanceGlitches,
} from './returns.js';

describe('daysBetween', () => {
  it('counts calendar days', () => {
    expect(daysBetween('2024-01-01', '2024-01-01')).toBe(0);
    expect(daysBetween('2024-01-01', '2025-01-01')).toBe(366); // leap year
    expect(daysBetween('2024-03-09', '2024-03-11')).toBe(2);   // across a US DST change
  });
});

describe('annualize', () => {
  it('leaves spans of a year or less alone', () => {
    expect(annualize(0.1, 365)).toBeNull();
    expect(annualize(0.1, 30)).toBeNull();
  });
  it('annualises spans over a year', () => {
    // 21% over two years = 10% a year.
    expect(annualize(0.21, 730)).toBeCloseTo(0.1, 10);
    // 366 days is just over a year.
    expect(annualize(0.1, 366)).toBeCloseTo(Math.pow(1.1, 365 / 366) - 1, 12);
  });
  it('is null for a total loss or missing input', () => {
    expect(annualize(-1, 800)).toBeNull();
    expect(annualize(null, 800)).toBeNull();
    expect(annualize(NaN, 800)).toBeNull();
  });
});

describe('timeWeightedReturn', () => {
  it('equals the simple return with no flows', () => {
    const r = timeWeightedReturn([
      { date: '2024-01-01', value: 100 },
      { date: '2024-01-02', value: 104 },
      { date: '2024-01-03', value: 110 },
    ], []);
    expect(r.periodReturn).toBeCloseTo(0.1, 12);
    expect(r.annualized).toBeNull(); // 2-day span
    expect(r.days).toBe(2);
  });

  it('links sub-periods around a deposit (deposit counts from the start of its day)', () => {
    // d1: 30 deposited, value 150 → r1 = 150 / (100 + 30) − 1 = 15.3846…%
    // d2: no flow, value 135      → r2 = 135 / 150 − 1 = −10%
    // TWR = 1.153846… × 0.9 − 1 = 3.8461…%
    const r = timeWeightedReturn(
      [{ date: '2024-01-01', value: 100 }, { date: '2024-01-02', value: 150 }, { date: '2024-01-03', value: 135 }],
      [{ date: '2024-01-02', amount: 30 }],
    );
    expect(r.periodReturn).toBeCloseTo((150 / 130) * 0.9 - 1, 12);
    expect(r.periodReturn).toBeCloseTo(0.0384615, 6);
  });

  it('treats a withdrawal as leaving at the end of its day', () => {
    // 20 taken out on d1, 90 left: (90 + 20) / 100 − 1 = +10%.
    const r = timeWeightedReturn(
      [{ date: '2024-01-01', value: 100 }, { date: '2024-01-02', value: 90 }],
      [{ date: '2024-01-02', amount: -20 }],
    );
    expect(r.periodReturn).toBeCloseTo(0.1, 12);
  });

  it('does not count a deposit just before a jump as gain', () => {
    // 900 lands on d1 (no market move), then +10% on d2. Simple return would say
    // (1100 − 100) / 100 = +1000%; the investments only made 10%.
    const r = timeWeightedReturn(
      [{ date: '2024-01-01', value: 100 }, { date: '2024-01-02', value: 1000 }, { date: '2024-01-03', value: 1100 }],
      [{ date: '2024-01-02', amount: 900 }],
    );
    expect(r.periodReturn).toBeCloseTo(0.1, 12);
  });

  it('handles a full withdrawal', () => {
    // +10% on d1, then everything (110) taken out on d2 → (0 + 110) / 110 − 1 = 0.
    const r = timeWeightedReturn(
      [{ date: '2024-01-01', value: 100 }, { date: '2024-01-02', value: 110 }, { date: '2024-01-03', value: 0 }],
      [{ date: '2024-01-03', amount: -110 }],
    );
    expect(r.periodReturn).toBeCloseTo(0.1, 12);
    expect(r.unexplained).toEqual([]);
  });

  it('handles a zero starting value (first deposit into an empty account)', () => {
    const r = timeWeightedReturn(
      [{ date: '2024-01-01', value: 0 }, { date: '2024-01-02', value: 100 }, { date: '2024-01-03', value: 110 }],
      [{ date: '2024-01-02', amount: 100 }],
    );
    expect(r.periodReturn).toBeCloseTo(0.1, 12);
  });

  it('flags value that appears from nothing instead of counting it as gain', () => {
    const r = timeWeightedReturn(
      [{ date: '2024-01-01', value: 0 }, { date: '2024-01-02', value: 500 }, { date: '2024-01-03', value: 550 }],
      [],
    );
    expect(r.unexplained).toEqual(['2024-01-02']);
    expect(r.periodReturn).toBeCloseTo(0.1, 12); // only the measurable d2 move
  });

  it('ignores flows on the first valuation day and after the last', () => {
    const r = timeWeightedReturn(
      [{ date: '2024-01-01', value: 100 }, { date: '2024-01-02', value: 110 }],
      [{ date: '2024-01-01', amount: 50 }, { date: '2023-12-31', amount: 50 }, { date: '2024-01-03', amount: -999 }],
    );
    expect(r.periodReturn).toBeCloseTo(0.1, 12);
  });

  it('lets money arrive at the end of its day (joining a combined total)', () => {
    // 100 grows 10% a day; on day 2 another 200 joins, already valued at the
    // close. Counting it from the start of the day would dilute day 2 to 3.3%.
    const r = timeWeightedReturn(
      [{ date: '2024-01-01', value: 100 }, { date: '2024-01-02', value: 310 }, { date: '2024-01-03', value: 341 }],
      [{ date: '2024-01-02', amount: 200, timing: 'end' }],
    );
    expect(r.periodReturn).toBeCloseTo(0.21, 12);
  });

  it('assigns a flow inside a gap to the next valuation', () => {
    // No balance on Jan 2–4; the Jan 3 deposit belongs to the Jan 5 sub-period.
    const r = timeWeightedReturn(
      [{ date: '2024-01-01', value: 100 }, { date: '2024-01-05', value: 160 }],
      [{ date: '2024-01-03', amount: 50 }],
    );
    expect(r.periodReturn).toBeCloseTo(160 / 150 - 1, 12);
  });

  it('is null for a single data point, empty input, or a zero-day span', () => {
    expect(timeWeightedReturn([{ date: '2024-01-01', value: 100 }], []).periodReturn).toBeNull();
    expect(timeWeightedReturn([], []).periodReturn).toBeNull();
    expect(timeWeightedReturn([{ date: '2024-01-01', value: 100 }, { date: '2024-01-01', value: 120 }], []).periodReturn).toBeNull();
  });

  it('annualises only spans over a year', () => {
    const r = timeWeightedReturn([{ date: '2022-01-01', value: 100 }, { date: '2024-01-01', value: 121 }], []);
    expect(r.days).toBe(730);
    expect(r.annualized).toBeCloseTo(0.1, 10);
  });

  it('never produces NaN or Infinity', () => {
    const r = timeWeightedReturn(
      [{ date: '2024-01-01', value: 0 }, { date: '2024-01-02', value: 0 }, { date: '2024-01-03', value: NaN }],
      [{ date: '2024-01-02', amount: NaN }],
    );
    expect(r.periodReturn).toBeNull();
    expect(r.annualized).toBeNull();
  });
});

describe('suspiciousJumps', () => {
  it('flags a lone jump that stays', () => {
    const j = suspiciousJumps([
      { date: 'a', ret: 0.01 }, { date: 'b', ret: 0.5 }, { date: 'c', ret: -0.01 },
    ]);
    expect(j.map(x => x.date)).toEqual(['b']);
  });
  it('does not flag a drop that the next day undoes (posting-date lag)', () => {
    // A deposit counted a day before it showed in the balance: −33% then +50%.
    const j = suspiciousJumps([
      { date: 'a', ret: 0 }, { date: 'b', ret: -1 / 3 }, { date: 'c', ret: 0.5 }, { date: 'd', ret: 0 },
    ]);
    expect(j).toEqual([]);
  });
  it('is quiet exactly at the threshold and on empty input', () => {
    expect(suspiciousJumps([{ date: 'a', ret: 0.2 }])).toEqual([]);
    expect(suspiciousJumps([])).toEqual([]);
  });
});

describe('xirr', () => {
  it('matches the textbook spreadsheet example (37.34%)', () => {
    // The XIRR example from spreadsheet documentation; known answer 0.373362535.
    const r = xirr([
      { date: '2008-01-01', amount: -10000 },
      { date: '2008-03-01', amount: 2750 },
      { date: '2008-10-30', amount: 4250 },
      { date: '2009-02-15', amount: 3250 },
      { date: '2009-04-01', amount: 2750 },
    ]);
    expect(r).not.toBeNull();
    expect(r!).toBeCloseTo(0.373362535, 6);
  });

  it('gives exactly 10% for 100 → 110 over 365 days', () => {
    expect(xirr([{ date: '2023-01-01', amount: -100 }, { date: '2024-01-01', amount: 110 }])).toBeCloseTo(0.1, 10);
  });

  it('handles a loss', () => {
    expect(xirr([{ date: '2023-01-01', amount: -100 }, { date: '2024-01-01', amount: 80 }])).toBeCloseTo(-0.2, 10);
  });

  it('finds the same root by bisection alone', () => {
    const cfs = [
      { date: '2008-01-01', amount: -10000 },
      { date: '2008-03-01', amount: 2750 },
      { date: '2008-10-30', amount: 4250 },
      { date: '2009-02-15', amount: 3250 },
      { date: '2009-04-01', amount: 2750 },
    ];
    const newton = solveSpanRate(cfs)!;
    const bisect = solveSpanRate(cfs, { skipNewton: true })!;
    expect(bisect.rate).toBeCloseTo(newton.rate, 9);
    expect(Math.pow(1 + bisect.rate, 365 / bisect.days) - 1).toBeCloseTo(0.373362535, 6);
  });

  it('returns null when there is no solution or too little data', () => {
    expect(xirr([{ date: '2023-01-01', amount: -100 }, { date: '2024-01-01', amount: -50 }])).toBeNull(); // all out
    expect(xirr([{ date: '2023-01-01', amount: 100 }])).toBeNull();
    expect(xirr([])).toBeNull();
    expect(xirr([{ date: '2023-01-01', amount: -100 }, { date: '2023-01-01', amount: 110 }])).toBeNull(); // zero span
  });

  it('stays in range on a near-total loss (Newton would step below −100%)', () => {
    // The raw Newton step from 0 lands at −19900%; it must be pulled back inside.
    const s = solveSpanRate([{ date: '2023-01-01', amount: -100 }, { date: '2023-06-01', amount: 0.5 }]);
    expect(s).not.toBeNull();
    expect(s!.rate).toBeCloseTo(-0.995, 8);
  });
});

describe('moneyWeightedReturn', () => {
  it('equals the simple return with no flows', () => {
    const r = moneyWeightedReturn([{ date: '2024-01-01', value: 100 }, { date: '2024-03-01', value: 110 }], []);
    expect(r.periodReturn).toBeCloseTo(0.1, 10);
    expect(r.annualized).toBeNull();
  });

  it('weights a deposit just before a jump by when it arrived', () => {
    // −100 on day 0, −900 on day 1, +1100 on day 2 (span T = 2 days).
    // With x = (1+R)^(−1/2): −100 − 900x + 1100x² = 0
    //   x = (900 + √(900² + 4·1100·100)) / 2200 = 0.9172882…, 1 + R = 1/x² = 1.188467…
    const r = moneyWeightedReturn(
      [{ date: '2024-01-01', value: 100 }, { date: '2024-01-02', value: 1000 }, { date: '2024-01-03', value: 1100 }],
      [{ date: '2024-01-02', amount: 900 }],
    );
    const x = (900 + Math.sqrt(900 * 900 + 4 * 1100 * 100)) / 2200;
    expect(r.periodReturn).toBeCloseTo(1 / (x * x) - 1, 8);
    expect(r.periodReturn).toBeCloseTo(0.188467, 5);
  });

  it('handles a full withdrawal', () => {
    // −100 in, +110 out two days later, nothing left: 10% over the span.
    const r = moneyWeightedReturn(
      [{ date: '2024-01-01', value: 100 }, { date: '2024-01-02', value: 110 }, { date: '2024-01-03', value: 0 }],
      [{ date: '2024-01-03', amount: -110 }],
    );
    expect(r.periodReturn).toBeCloseTo(0.1, 10);
  });

  it('measures an account that starts empty from its first deposit', () => {
    const r = moneyWeightedReturn(
      [{ date: '2024-01-01', value: 0 }, { date: '2024-01-11', value: 100 }, { date: '2024-01-21', value: 110 }],
      [{ date: '2024-01-11', amount: 100 }],
    );
    expect(r.days).toBe(10);
    expect(r.periodReturn).toBeCloseTo(0.1, 10);
  });

  it('annualises a multi-year span (the XIRR)', () => {
    const r = moneyWeightedReturn([{ date: '2022-01-01', value: 100 }, { date: '2024-01-01', value: 121 }], []);
    expect(r.periodReturn).toBeCloseTo(0.21, 10);
    expect(r.annualized).toBeCloseTo(0.1, 10);
  });

  it('is null for a single data point or all-zero values', () => {
    expect(moneyWeightedReturn([{ date: '2024-01-01', value: 100 }], []).periodReturn).toBeNull();
    expect(moneyWeightedReturn([{ date: '2024-01-01', value: 0 }, { date: '2024-02-01', value: 0 }], []).periodReturn).toBeNull();
  });
});

// A provider occasionally sends an empty balance that gets stored as 0. One
// such day used to read as −100% and could never be linked back in.
describe('timeWeightedReturn with a zero-balance sync glitch', () => {
  const days = (from: string, values: number[]) => values.map((value, i) => {
    const d = new Date(from + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + i);
    return { date: d.toISOString().slice(0, 10), value };
  });

  it('skips a lone 0 between two normal balances', () => {
    // 10000, 10100, [0], 10200, 10300 with no flows → 10300 / 10000 − 1 = +3%.
    const r = timeWeightedReturn(days('2026-11-01', [10000, 10100, 0, 10200, 10300]), []);
    expect(r.periodReturn).toBeCloseTo(0.03, 12);
    expect(r.glitches).toEqual(['2026-11-03']);
    expect(r.daily.every(d => d.ret > -0.5)).toBe(true);
  });

  it('skips a run of zeros and gets 0% for a flat account', () => {
    expect(timeWeightedReturn(days('2026-11-01', [10000, 0, 10000]), []).periodReturn).toBeCloseTo(0, 12);
    expect(timeWeightedReturn(days('2026-11-01', [10000, 0, 0, 11000]), []).periodReturn).toBeCloseTo(0.1, 12);
  });

  it('keeps a 0 that a recorded full withdrawal explains', () => {
    // 10100 withdrawn on Nov 3 (balance 0), redeposited Nov 4:
    // 1.01 × (0 + 10100)/10100 × 10200/(0 + 10100) × 10300/10200 = 1.03.
    const r = timeWeightedReturn(
      days('2026-11-01', [10000, 10100, 0, 10200, 10300]),
      [{ date: '2026-11-03', amount: -10100 }, { date: '2026-11-04', amount: 10100 }],
    );
    expect(r.periodReturn).toBeCloseTo(0.03, 12);
    expect(r.glitches).toEqual([]);
  });

  it('still drops a 0 when the only withdrawal is small next to the balance', () => {
    // 500 out of 10000 can't explain a balance of 0: treated as a bad sync.
    // Merged sub-period: (10000 + 500) / 10000 − 1 = +5%.
    const r = timeWeightedReturn(days('2026-11-01', [10000, 0, 10000]), [{ date: '2026-11-02', amount: -500 }]);
    expect(r.glitches).toEqual(['2026-11-02']);
    expect(r.periodReturn).toBeCloseTo(0.05, 12);
  });

  it('keeps a 0 at the start (empty account) and at the end (nothing after it)', () => {
    expect(dropBalanceGlitches(days('2026-11-01', [0, 100, 110]), []).dropped).toEqual([]);
    const end = timeWeightedReturn(days('2026-11-01', [100, 110, 0]), []);
    expect(end.glitches).toEqual([]);
    expect(end.periodReturn).toBeCloseTo(-1, 12);   // the caller decides this isn't measurable
  });
});

describe('timeWeightedReturn annualises over the invested span', () => {
  it('matches the money-weighted rate for a single deposit into an empty account', () => {
    // Empty from 2025-01-01, 1,000 deposited 2025-04-11 (day 100), worth 1,100
    // on 2026-08-24 (day 600). Money was invested for 500 days, so both rates
    // are 1.1^(365/500) − 1 = 7.2054%; over 600 days it would be 5.97%.
    const vals = [
      { date: '2025-01-01', value: 0 },
      { date: '2025-04-11', value: 1000 },
      { date: '2026-08-24', value: 1100 },
    ];
    const flows = [{ date: '2025-04-11', amount: 1000 }];
    const t = timeWeightedReturn(vals, flows);
    const m = moneyWeightedReturn(vals, flows);
    expect(t.periodReturn).toBeCloseTo(0.1, 12);
    expect(t.days).toBe(500);
    expect(m.days).toBe(500);
    expect(t.annualized).toBeCloseTo(Math.pow(1.1, 365 / 500) - 1, 10);
    expect(t.annualized).toBeCloseTo(0.0720540, 6);
    expect(t.annualized).toBeCloseTo(m.annualized!, 8);
    expect(t.startDate).toBe('2025-01-01');
  });

  it('is unchanged when the account starts with money in it', () => {
    const r = timeWeightedReturn([{ date: '2022-01-01', value: 100 }, { date: '2024-01-01', value: 121 }], []);
    expect(r.days).toBe(730);
    expect(r.annualized).toBeCloseTo(0.1, 10);
  });
});
