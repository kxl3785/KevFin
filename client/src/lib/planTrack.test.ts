import { describe, it, expect } from 'vitest';
import { makePin, canTrack, planPoints, planAt, actualSince, planVsActual, dayToMs, monthTicks, YEAR_MS, type PinnedBaseline } from './planTrack.ts';

// A pin made at local noon on 1 Jan 2026 with a $500k start: the median grows by
// $50k a year, the range ±$40k around it after year one, ±$80k after year two.
const AT = new Date(2026, 0, 1, 12).getTime();
const bands = [
  { age: 40, p10: 510000, p50: 550000, band: 80000, invP50: 450000 },
  { age: 41, p10: 520000, p50: 600000, band: 160000, invP50: 500000 },
];
const pin = (over: Partial<PinnedBaseline> = {}): PinnedBaseline => ({
  ...makePin(bands, { futureNW: 600000, successPct: 88, startNW: 500000, recordedNW: 520000, at: AT }),
  ...over,
});
const day = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

describe('makePin', () => {
  it('keeps the existing median fields and adds the range and starting values', () => {
    const p = pin();
    expect(p.bands[0]).toEqual({ age: 40, p50: 550000, invP50: 450000, p10: 510000, p90: 590000 });
    expect(p.futureNW).toBe(600000);
    expect(p.successPct).toBe(88);
    expect(p.startNW).toBe(500000);
    expect(p.recordedNW).toBe(520000);
  });

  it('omits a recorded net worth that is missing, and never stores NaN', () => {
    const p = makePin(bands, { futureNW: 1, successPct: 1, startNW: NaN, recordedNW: null, at: AT });
    expect('recordedNW' in p).toBe(false);
    expect(p.startNW).toBe(0);
  });
});

describe('canTrack', () => {
  it('rejects pins saved before plan tracking (no start or range) and junk', () => {
    const old = { bands: [{ age: 40, p50: 1, invP50: 1 }], futureNW: 1, successPct: 50, at: AT };
    expect(canTrack(old)).toBe(false);
    expect(canTrack(null)).toBe(false);
    expect(canTrack({ ...pin(), bands: [] })).toBe(false);
    expect(canTrack(pin())).toBe(true);
    expect(planVsActual(old, [{ date: '2026-06-01', net_worth: 1 }])).toBeNull();
  });
});

describe('planPoints / planAt', () => {
  it('dates band i at pin + (i + 1) years and starts at the pinned net worth', () => {
    const pts = planPoints(pin() as PinnedBaseline & { startNW: number });
    expect(pts.map(p => p.t)).toEqual([AT, AT + YEAR_MS, AT + 2 * YEAR_MS]);
    expect(pts[0]).toEqual({ t: AT, lo: 500000, med: 500000, hi: 500000 });
    expect(pts[2]).toEqual({ t: AT + 2 * YEAR_MS, lo: 520000, med: 600000, hi: 680000 });
  });

  it('interpolates in a straight line and holds flat outside the plan', () => {
    const pts = planPoints(pin() as PinnedBaseline & { startNW: number });
    // A quarter of the way through year one: 500k + 0.25 × 50k; range 0.25 × ±40k.
    const q = planAt(pts, AT + YEAR_MS / 4)!;
    expect(q.med).toBeCloseTo(512500, 6);
    expect(q.lo).toBeCloseTo(502500, 6);
    expect(q.hi).toBeCloseTo(522500, 6);
    expect(planAt(pts, AT - 1000)!.med).toBe(500000);
    expect(planAt(pts, AT + 10 * YEAR_MS)!.med).toBe(600000);
    expect(planAt([], AT)).toBeNull();
    expect(planAt(pts, NaN)).toBeNull();
  });
});

describe('actualSince', () => {
  const base = pin() as PinnedBaseline & { startNW: number };
  it('keeps days from the pin onward, oldest first, shifted for left-out holdings', () => {
    const hist = [
      { date: '2026-03-01', net_worth: 560000 },
      { date: '2025-12-31', net_worth: 999999 },   // before the pin
      { date: '2026-01-01', net_worth: 520000 },   // pin day
      { date: 'junk', net_worth: 1 },
      { date: '2026-02-01', net_worth: NaN },
    ];
    // Recorded 520k vs forecast 500k at the pin → 20k left out; subtract it.
    expect(actualSince(base, hist).map(p => [day(p.t), p.nw])).toEqual([['2026-01-01', 500000], ['2026-03-01', 540000]]);
  });

  it('applies no shift when the pin has no recorded net worth', () => {
    const p = { ...base, recordedNW: undefined };
    expect(actualSince(p, [{ date: '2026-02-01', net_worth: 530000 }])[0].nw).toBe(530000);
  });

  it('thins a long history but keeps the first and last day', () => {
    const hist = Array.from({ length: 1000 }, (_, i) => ({ date: day(AT + i * 864e5), net_worth: 500000 + i }));
    const out = actualSince({ ...base, recordedNW: undefined }, hist, 50);
    expect(out.length).toBe(50);
    expect(out[0].nw).toBe(500000);
    expect(out[49].nw).toBe(500999);
  });

  it('parses dates as local days', () => {
    expect(dayToMs('2026-01-01')).toBe(AT);
    expect(dayToMs('')).toBeNull();
  });
});

describe('planVsActual', () => {
  // Six months in (2 Jul 2026, 182 days ≈ 0.498 yr). Hand-computed from the pin:
  // median 500k + 50k·f ≈ 524,914; range 500k + 10k·f ≈ 504,983 to 500k + 90k·f ≈ 544,846.
  const t = dayToMs('2026-07-02')!;
  const f = (t - AT) / YEAR_MS;
  const med = 500000 + 50000 * f, lo = 500000 + 10000 * f, hi = 500000 + 90000 * f;
  const at = (recorded: number) => planVsActual(pin(), [{ date: '2026-07-02', net_worth: recorded }], t)!.latest!;

  it('ahead and inside the range', () => {
    const r = at(560000);
    expect(r.med).toBeCloseTo(med, 6);
    expect(r.lo).toBeCloseTo(lo, 6);
    expect(r.hi).toBeCloseTo(hi, 6);
    expect(r.actual).toBe(540000);                 // 560k recorded − 20k left out
    expect(r.diff).toBeCloseTo(540000 - med, 6);
    expect(r.diffPct).toBeCloseTo((540000 - med) / med, 9);
    expect(r.position).toBe('ahead');
    expect(r.inRange).toBe(true);
  });

  it('ahead and above the range; behind and below it', () => {
    expect(at(600000)).toMatchObject({ position: 'ahead', inRange: false });
    const b = at(520000);                          // 500k actual < 504,983 low edge
    expect(b.position).toBe('behind');
    expect(b.diff).toBeLessThan(0);
    expect(b.inRange).toBe(false);
  });

  it('within half a percent of the median reads as on plan', () => {
    expect(at(med + 20000 + 1000).position).toBe('onPlan');      // +1,000 ≈ +0.19%
    expect(at(med + 20000 + 0.006 * med).position).toBe('ahead'); // +0.6%
  });

  it('rows run from the pin to a year past today, sorted, finite, with the actual joined in', () => {
    const r = planVsActual(pin(), [{ date: '2026-07-02', net_worth: 560000 }], t)!;
    expect(r.pinnedAt).toBe(AT);
    expect(r.rows[0].t).toBe(AT);
    expect(r.rows[r.rows.length - 1].t).toBe(Math.round(t + YEAR_MS));
    for (let i = 1; i < r.rows.length; i++) expect(r.rows[i].t).toBeGreaterThan(r.rows[i - 1].t);
    for (const row of r.rows) for (const v of [row.lo, row.band, row.med]) { expect(Number.isFinite(v)).toBe(true); }
    expect(r.rows.every(row => row.band >= 0)).toBe(true);
    expect(r.rows.filter(row => row.actual != null).map(row => row.actual)).toEqual([540000]);
  });

  it('no recorded days since the pin → rows but no reading; never past the plan end', () => {
    const r = planVsActual(pin(), [], AT + 5 * YEAR_MS)!;
    expect(r.latest).toBeNull();
    expect(r.rows[r.rows.length - 1].t).toBe(AT + 2 * YEAR_MS);
  });
});


describe('the day of the pin (COORD-1)', () => {
  // Pinned at 8 am and at 8 pm on 24 Nov 2026 with $666,712 forecast and recorded,
  // and the day's recorded figure equal to it. The plan must read exactly the
  // pinned figure that day: on plan, and inside its (zero-width) range.
  for (const hour of [8, 20]) {
    it(`pinned at ${hour}:00 — on plan and inside the range, the same figure both sides`, () => {
      const at = new Date(2026, 10, 24, hour).getTime();
      const p = makePin(bands, { futureNW: 600000, successPct: 88, startNW: 666712, recordedNW: 666712, at });
      const r = planVsActual(p, [{ date: '2026-11-24', net_worth: 666712 }], at)!;
      expect(r.latest).toMatchObject({ actual: 666712, med: 666712, lo: 666712, hi: 666712, diff: 0, position: 'onPlan', inRange: true });
      expect(r.pinnedAt).toBe(at);
      expect(r.rows[0].t).toBe(new Date(2026, 10, 24, 12).getTime());
    });
  }

  it('"on plan" is never also "outside the likely range"', () => {
    // A day after the pin the range is ~0.3% of a year wide; $500 off a $500k
    // median is 0.1% — on plan, and so counted inside.
    const t = AT + 864e5;
    const r = planVsActual(pin({ recordedNW: 500000 }), [{ date: day(t), net_worth: planAt(planPoints(pin() as PinnedBaseline & { startNW: number }), t)!.hi + 500 }], t)!;
    expect(r.latest!.position).toBe('onPlan');
    expect(r.latest!.inRange).toBe(true);
  });
});

describe('monthTicks (COORD-2)', () => {
  const label = (t: number) => new Date(t).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
  it('never repeats a month label and keeps to the tick budget', () => {
    const t0 = new Date(2026, 10, 24, 12).getTime();
    for (const months of [1, 4, 13, 30, 70, 200]) {
      const t1 = new Date(2026, 10 + months, 24, 12).getTime();
      const ticks = monthTicks(t0, t1, 5);
      expect(ticks.length).toBeGreaterThan(0);
      expect(ticks.length).toBeLessThanOrEqual(5);
      expect(new Set(ticks.map(label)).size).toBe(ticks.length);
      for (const k of ticks) { expect(new Date(k).getDate()).toBe(1); expect(k).toBeGreaterThanOrEqual(t0); expect(k).toBeLessThanOrEqual(t1); }
    }
  });
  it('monthly when it fits; yearly ticks land on January', () => {
    expect(monthTicks(new Date(2027, 7, 27).getTime(), new Date(2027, 10, 27).getTime(), 5).map(label)).toEqual(['Sep 27', 'Oct 27', 'Nov 27']);
    const yearly = monthTicks(new Date(2026, 10, 24).getTime(), new Date(2031, 10, 24).getTime(), 5);
    expect(yearly.map(t => new Date(t).getMonth())).toEqual([0, 0, 0, 0, 0]);
  });
  it('nothing for a bad span', () => {
    expect(monthTicks(10, 5)).toEqual([]);
    expect(monthTicks(NaN, 5)).toEqual([]);
  });
});
