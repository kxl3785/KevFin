import { describe, it, expect } from 'vitest';
import { seasonalItems, seasonalRangeLabel, SEASONAL_MAX_ITEMS } from './seasonalCalendar.js';

const all = { taxable: true, pretax: true, roth: true, hsa: true, college: true };
const titles = (iso: string, h = all) => seasonalItems(new Date(iso + 'T12:00:00Z'), h).map(i => i.title);
const whens = (iso: string, h = all) => seasonalItems(new Date(iso + 'T12:00:00Z'), h).map(i => i.when);

describe('seasonalItems', () => {
  it('January statement: last year\'s taxes and the new year, not year-end planning', () => {
    const t = titles('2027-01-02');
    expect(t).toContain('2026 tax return due');
    expect(t).toContain('Last day for 2026 IRA and HSA contributions');
    expect(t).toContain('Fourth-quarter estimated tax payment');
    expect(t).toContain('Reset contributions for the new year');
    expect(t).toContain('Tax forms arrive');
    expect(t.join('|')).not.toMatch(/harvesting|open enrollment|Charitable/);
  });
  it('April statement: the filing deadline and what follows it', () => {
    const t = titles('2027-04-02');
    expect(t).toEqual([
      '2026 tax return due', 'Last day for 2026 IRA and HSA contributions', 'First-quarter estimated tax payment',
      'Adjust withholding', 'Second-quarter estimated tax payment',
    ]);
  });
  it('July statement: mid-year, without December crowding in', () => {
    const t = titles('2027-07-02');
    expect(t).toContain('Mid-year check');
    expect(t).toContain('Third-quarter estimated tax payment');
    expect(t).toContain('Extended 2026 tax returns due');
    expect(t.join('|')).not.toMatch(/harvesting|Charitable|open enrollment|Roth/);
  });
  it('October statement: year-end, capped, with the most important kept', () => {
    const items = seasonalItems(new Date('2026-10-02T12:00:00Z'), all);
    const t = items.map(i => i.title);
    expect(items).toHaveLength(SEASONAL_MAX_ITEMS);
    for (const want of ['Health-plan open enrollment', 'Tax-loss harvesting and gains planning', 'Workplace retirement contributions',
      'Roth conversions and required distributions', 'Charitable gifts']) expect(t).toContain(want);
    expect(t).not.toContain('Use up health FSA money');           // lowest priority drops first
    expect(t).not.toContain('Reset contributions for the new year'); // January's, not October's
    expect(items.find(i => i.title.startsWith('Tax-loss'))!.detail).toContain('counts for 2026');
  });
  it('is in date order and labels deadlines and windows', () => {
    const w = whens('2026-10-02');
    // A window sits where it opens, a deadline on its date.
    expect(w[0]).toBe('From Oct 1');
    expect(w.indexOf('By Oct 15')).toBeLessThan(w.indexOf('Oct – Dec'));
    expect(w.indexOf('Oct – Dec')).toBeLessThan(w.indexOf('By Dec 31'));
    expect(w[w.length - 1]).toBe('By Jan 15');
  });
  it('drops a deadline once it has passed and keeps it on the day', () => {
    expect(titles('2027-04-15')).toContain('2026 tax return due');
    expect(titles('2027-04-16')).not.toContain('2026 tax return due');
    // Mid-November: the October 15 extension date is gone, year-end is still ahead.
    const nov = titles('2026-11-14');
    expect(nov).not.toContain('Extended 2025 tax returns due');
    expect(nov).toContain('Charitable gifts');
    expect(nov).toContain('Fourth-quarter estimated tax payment');
  });
  it('follows the account mix', () => {
    const none = titles('2026-10-02', {});
    expect(none.join('|')).not.toMatch(/harvesting|Roth|Workplace|Education|Financial aid|estimated/);
    expect(none).toContain('Charitable gifts');
    expect(none).toContain('Health-plan open enrollment');
    expect(titles('2026-10-02', { college: true })).toContain('Financial aid applications open');
    expect(titles('2027-01-02', { roth: true })).toContain('Last day for 2026 IRA contributions');
    const gifts = (h: object) => seasonalItems(new Date('2026-10-02T12:00:00Z'), h).find(i => i.title === 'Charitable gifts')!.detail;
    expect(gifts({ taxable: true })).toContain('appreciated shares');
    expect(gifts({})).not.toContain('appreciated shares');
  });
  it('never states a dollar amount (limits change every year)', () => {
    for (const d of ['2027-01-02', '2027-04-02', '2027-07-02', '2026-10-02'])
      for (const i of seasonalItems(new Date(d + 'T12:00:00Z'), all)) expect(i.title + i.detail).not.toContain('$');
  });
});

describe('seasonalRangeLabel', () => {
  it('names the months covered', () => {
    expect(seasonalRangeLabel(new Date('2027-04-02T00:00:00Z'))).toBe('Apr – Jul 2027');
    expect(seasonalRangeLabel(new Date('2026-10-02T00:00:00Z'))).toBe('Oct 2026 – Jan 2027');
  });
});
