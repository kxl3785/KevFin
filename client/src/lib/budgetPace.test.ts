import { describe, it, expect } from 'vitest';
import { monthPace, paceSeries, categoryLeft, barColor, billState } from './budgetPace.ts';

describe('monthPace', () => {
  it('day 23 of 30: under an even pace, projected month end, per-day allowance', () => {
    const p = monthPace(1786, 3795, 23, 30);
    expect(p.inProgress).toBe(true);
    expect(p.dayFrac).toBeCloseTo(23 / 30);
    expect(p.daysLeft).toBe(8); // days 23..30, today included
    expect(p.left).toBe(2009);
    expect(p.perDay).toBeCloseTo(2009 / 8);
    expect(p.paceToday).toBeCloseTo(3795 * 23 / 30);
    expect(p.vsPace).toBeCloseTo(3795 * 23 / 30 - 1786);
    expect(p.projected).toBeCloseTo(1786 / 23 * 30);
    expect(p.projectedVsBudget).toBeCloseTo(3795 - 1786 / 23 * 30);
  });

  it('a completed month: no per-day figure, the projection is the actual total', () => {
    const p = monthPace(3300, 3000, null, 30);
    expect(p.inProgress).toBe(false);
    expect(p.dayFrac).toBe(1);
    expect(p.daysLeft).toBe(0);
    expect(p.perDay).toBeNull();
    expect(p.projected).toBe(3300);
    expect(p.left).toBe(-300);
    expect(p.projectedVsBudget).toBe(-300);
  });

  it('over budget mid-month gives no per-day figure', () => {
    const p = monthPace(500, 400, 10, 31);
    expect(p.left).toBe(-100);
    expect(p.perDay).toBeNull();
    expect(p.vsPace!).toBeLessThan(0);
  });

  it('without a budget only the projection is known', () => {
    const p = monthPace(600, 0, 15, 30);
    expect(p.usedFrac).toBeNull();
    expect(p.left).toBeNull();
    expect(p.paceToday).toBeNull();
    expect(p.vsPace).toBeNull();
    expect(p.projectedVsBudget).toBeNull();
    expect(p.projected).toBe(1200);
  });

  it('the last day of the month still has today left', () => {
    const p = monthPace(100, 300, 31, 31);
    expect(p.daysLeft).toBe(1);
    expect(p.perDay).toBe(200);
  });
});

describe('paceSeries', () => {
  it('rises evenly to the full budget on the last day', () => {
    const s = paceSeries(3000, 30);
    expect(s).toHaveLength(30);
    expect(s[0]).toEqual({ day: 1, pace: 100 });
    expect(s[14].pace).toBe(1500);
    expect(s[29]).toEqual({ day: 30, pace: 3000 });
  });
});

describe('categoryLeft / barColor', () => {
  it('reads what is left, near the limit, or over', () => {
    expect(categoryLeft(357, 500)).toMatchObject({ state: 'under', left: 143 });
    expect(categoryLeft(450, 500).state).toBe('near');
    expect(categoryLeft(512, 500)).toMatchObject({ state: 'over', left: -12 });
    expect(categoryLeft(500, 500).state).toBe('near'); // exactly at the limit is not over
    expect(categoryLeft(80, 0).state).toBe('none');
  });
  it('colours follow the state', () => {
    expect(barColor(10, 0)).toBe('var(--budget-open)');
    expect(barColor(100, 500)).toBe('var(--green)');
    expect(barColor(450, 500)).toBe('var(--amber)');
    expect(barColor(600, 500)).toBe('var(--red)');
  });
});

describe('billState', () => {
  it('paid once the usual amount (or close to it) has posted', () => {
    expect(billState(185, 185, true)).toBe('paid');
    expect(billState(170, 185, true)).toBe('paid');
    expect(billState(40, 0, false)).toBe('paid'); // no usual amount known
  });
  it('part-paid, due, or not charged', () => {
    expect(billState(90, 185, true)).toBe('partial');
    expect(billState(0, 185, true)).toBe('due');
    expect(billState(0, 185, false)).toBe('none');
  });
  it('in a completed month any charge is paid, even one under the usual amount', () => {
    expect(billState(110, 137, false)).toBe('paid'); // a low Gas & Electric bill
    expect(billState(90, 185, false)).toBe('paid');
    expect(billState(0.004, 185, false)).toBe('none'); // float dust isn't a charge
  });
});
