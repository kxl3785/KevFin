import { describe, it, expect } from 'vitest';
import {
  getReportWindow, quarterMonthKeys, REPORT_WINDOW_DAYS, computePeriodFigures, outlookHorizon, addDaysIso, nearestObservation, priorWindow,
} from './reportWindow.js';

describe('getReportWindow', () => {
  it('opens on day 1 of a new quarter and reports the quarter that just ended', () => {
    const w = getReportWindow(new Date('2026-07-01T09:00:00Z'));
    expect(w.open).toBe(true);
    expect(w.quarterLabel).toBe('Q2 2026');
    expect(w.periodStart).toBe('2026-04-01');
    expect(w.periodEnd).toBe('2026-06-30');
    expect(w.windowEndsAt).toBe('2026-07-03T23:59:59.000Z');
  });

  it('stays open through the last day of the window', () => {
    expect(getReportWindow(new Date(`2026-07-0${REPORT_WINDOW_DAYS}T23:00:00Z`)).open).toBe(true);
  });

  it('closes once the window has passed but still reports the prior quarter', () => {
    const w = getReportWindow(new Date('2026-07-09T12:00:00Z'));
    expect(w.open).toBe(false);
    expect(w.quarterLabel).toBe('Q2 2026');
    expect(w.windowEndsAt).toBeNull();
  });

  it('rolls back across the year boundary in early January', () => {
    const w = getReportWindow(new Date('2026-01-02T00:00:00Z'));
    expect(w.open).toBe(true);
    expect(w.quarter).toBe(4);
    expect(w.year).toBe(2025);
    expect(w.periodStart).toBe('2025-10-01');
    expect(w.periodEnd).toBe('2025-12-31');
  });

  it('is closed mid-quarter and points at the previous completed quarter', () => {
    const w = getReportWindow(new Date('2026-05-15T00:00:00Z'));
    expect(w.open).toBe(false);
    expect(w.quarterLabel).toBe('Q1 2026');
    expect(w.periodStart).toBe('2026-01-01');
    expect(w.periodEnd).toBe('2026-03-31');
  });

  it('opens for Q3 at the start of October', () => {
    const w = getReportWindow(new Date('2026-10-01T06:00:00Z'));
    expect(w.open).toBe(true);
    expect(w.quarterLabel).toBe('Q3 2026');
    expect(w.periodEnd).toBe('2026-09-30');
  });

  it('lists the three month keys of the reported quarter', () => {
    const w = getReportWindow(new Date('2026-07-01T00:00:00Z'));
    expect(quarterMonthKeys(w)).toEqual(['2026-04', '2026-05', '2026-06']);
  });
});

const q2 = { periodStart: '2026-04-01', periodEnd: '2026-06-30' };
const snap = (date: string, net_worth: number) => ({ date, net_worth });

describe('computePeriodFigures', () => {
  it('uses the period-end snapshot, not a later one', () => {
    const f = computePeriodFigures([
      snap('2026-03-31', 100), snap('2026-06-30', 110), snap('2026-07-02', 150),
    ], q2);
    expect(f.endSnap?.date).toBe('2026-06-30');
    expect(f.change).toBe(10);
    expect(f.changePct).toBeCloseTo(0.1);
  });

  it('measures from the prior quarter close when it is near the period start', () => {
    const f = computePeriodFigures([snap('2026-03-31', 100), snap('2026-04-02', 105), snap('2026-06-30', 120)], q2);
    expect(f.startSnap?.date).toBe('2026-03-31');
    expect(f.change).toBe(20);
  });

  it('falls back to the first in-period snapshot (and reports its date) when the prior close is stale', () => {
    const f = computePeriodFigures([snap('2026-01-15', 90), snap('2026-04-20', 100), snap('2026-06-30', 120)], q2);
    expect(f.startSnap?.date).toBe('2026-04-20');
    expect(f.change).toBe(20);
  });

  it('has no change when the only snapshot is the end snapshot', () => {
    const f = computePeriodFigures([snap('2026-06-30', 120)], q2);
    expect(f.change).toBeNull();
    expect(f.changePct).toBeNull();
  });

  it('omits year-over-year when history is shorter than a year', () => {
    const f = computePeriodFigures([snap('2026-04-20', 100), snap('2026-06-30', 120)], q2);
    expect(f.yoyPct).toBeNull();
  });

  it('omits year-over-year when the nearest snapshot is more than 7 days from the cutoff', () => {
    // cutoff = 2025-06-30; closest is 2025-07-20 (20 days off)
    const f = computePeriodFigures([snap('2025-07-20', 100), snap('2026-06-30', 120)], q2);
    expect(f.yoyPct).toBeNull();
  });

  it('computes year-over-year from a snapshot within a week of the cutoff', () => {
    const f = computePeriodFigures([snap('2025-07-03', 100), snap('2026-06-30', 125)], q2);
    expect(f.yoySnap?.date).toBe('2025-07-03');
    expect(f.yoyPct).toBeCloseTo(0.25);
  });

  it('handles empty history', () => {
    const f = computePeriodFigures([], q2);
    expect(f.endSnap).toBeNull();
    expect(f.change).toBeNull();
    expect(f.yoyPct).toBeNull();
  });
});

describe('outlookHorizon', () => {
  it('describes the real generation date and following periods (Q4)', () => {
    const h = outlookHorizon(new Date('2026-10-02T00:00:00Z'));
    expect(h.generatedOn).toBe('October 2, 2026');
    expect(h.restOfYear).toBe('the remainder of 2026 (Q4)');
    expect(h.nextPeriod).toBe('early 2027');
  });
  it('spans the remaining quarters earlier in the year', () => {
    expect(outlookHorizon(new Date('2027-01-02T00:00:00Z')).restOfYear).toBe('the remainder of 2027 (Q1 through Q4)');
  });
});

describe('addDaysIso', () => {
  it('shifts across month boundaries', () => {
    expect(addDaysIso('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('nearestObservation', () => {
  const obs = [{ date: '2026-03-20', balance: 1 }, { date: '2026-04-03', balance: 2 }, { date: '2026-04-20', balance: 3 }];
  it('picks the closest reading within the tolerance', () => {
    expect(nearestObservation(obs, '2026-04-01')?.balance).toBe(2);
  });
  it('returns null when nothing is within ~7 days', () => {
    expect(nearestObservation(obs, '2026-05-15')).toBeNull();
    expect(nearestObservation([], '2026-04-01')).toBeNull();
  });
});

describe('priorWindow', () => {
  it('steps back one quarter, across the year boundary too', () => {
    expect(priorWindow(getReportWindow(new Date('2026-07-01T00:00:00Z')))).toMatchObject({ quarterLabel: 'Q1 2026', periodStart: '2026-01-01', periodEnd: '2026-03-31' });
    expect(priorWindow(getReportWindow(new Date('2026-04-01T00:00:00Z')))).toMatchObject({ quarterLabel: 'Q4 2025', periodEnd: '2025-12-31' });
  });
});
