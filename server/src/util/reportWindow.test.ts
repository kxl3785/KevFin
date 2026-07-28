import { describe, it, expect } from 'vitest';
import { getReportWindow, quarterMonthKeys, REPORT_WINDOW_DAYS } from './reportWindow.js';

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
