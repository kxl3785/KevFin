import { describe, it, expect } from 'vitest';
import { billingCycleMonths, nextChargeDate, lastChargeRise } from './recurringSchedule.ts';

describe('billingCycleMonths', () => {
  it('monthly, quarterly and annual cycles', () => {
    expect(billingCycleMonths(['2026-04-02', '2026-05-02', '2026-06-02'])).toBe(1);
    expect(billingCycleMonths(['2025-10-15', '2026-01-15', '2026-04-15'])).toBe(3);
    expect(billingCycleMonths(['2026-03-01'], true)).toBe(12);
  });
  it('a skipped month does not change a monthly cycle', () => {
    expect(billingCycleMonths(['2026-01-05', '2026-02-05', '2026-04-05', '2026-05-05', '2026-06-05'])).toBe(1);
  });
  it('two charges in one month count once; a single charge has no cycle', () => {
    expect(billingCycleMonths(['2026-06-01', '2026-06-20'])).toBeNull();
    expect(billingCycleMonths(['2026-06-01'])).toBeNull();
  });
});

describe('nextChargeDate', () => {
  it('one cycle after the latest charge, same day of the month', () => {
    expect(nextChargeDate(['2026-06-02', '2026-05-02', '2026-04-02'], false, '2026-06-10')).toEqual({ date: '2026-07-02', late: false });
  });
  it('clamps to the end of a shorter month', () => {
    expect(nextChargeDate(['2025-12-31', '2026-01-31'], false, '2026-02-01')!.date).toBe('2026-02-28');
  });
  it('annual bills come back a year on', () => {
    expect(nextChargeDate(['2026-03-14'], true, '2026-06-01')).toEqual({ date: '2027-03-14', late: false });
  });
  it('is late when the date passed more than a week ago', () => {
    expect(nextChargeDate(['2026-05-02', '2026-06-02'], false, '2026-07-05')!.late).toBe(false);
    expect(nextChargeDate(['2026-05-02', '2026-06-02'], false, '2026-07-10')!.late).toBe(true);
  });
  it('nothing to go on', () => {
    expect(nextChargeDate([], false, '2026-06-01')).toBeNull();
    expect(nextChargeDate(['2026-06-01'], false, '2026-06-02')).toBeNull();
  });
});

describe('lastChargeRise', () => {
  it('measures against the Usually figure the row shows, when given', () => {
    const charges = [c('2026-03-08', 130), c('2026-04-08', 130), c('2026-05-08', 131), c('2026-06-08', 168.12)];
    // Median of the earlier charges is 130 (+29%); against the shown 136.82 it is +23%.
    expect(Math.round(lastChargeRise(charges)!.pct * 100)).toBe(29);
    const r = lastChargeRise(charges, 136.82)!;
    expect(r.usual).toBe(136.82);
    expect(Math.round(r.pct * 100)).toBe(23);
    // A shown figure the last charge doesn't clear by 10% raises no flag.
    expect(lastChargeRise(charges, 160)).toBeNull();
  });
  const c = (date: string, amount: number) => ({ date, amount });
  it('flags a last charge 12% above the usual amount', () => {
    const r = lastChargeRise([c('2026-03-08', 133.34), c('2026-04-08', 133.34), c('2026-05-08', 133.34), c('2026-06-08', 149.46)]);
    expect(r).not.toBeNull();
    expect(r!.usual).toBe(133.34);
    expect(Math.round(r!.pct * 100)).toBe(12);
  });
  it('ignores small wobble, drops, and too little history', () => {
    expect(lastChargeRise([c('2026-04-01', 10), c('2026-05-01', 10), c('2026-06-01', 11.5)])).toBeNull(); // +15% but only $1.50
    expect(lastChargeRise([c('2026-04-01', 100), c('2026-05-01', 100), c('2026-06-01', 105)])).toBeNull(); // +5%
    expect(lastChargeRise([c('2026-04-01', 100), c('2026-05-01', 100), c('2026-06-01', 80)])).toBeNull();
    expect(lastChargeRise([c('2026-05-01', 100), c('2026-06-01', 150)])).toBeNull();
  });
  it('the usual amount is the median, so one odd month does not move it', () => {
    const r = lastChargeRise([c('2026-02-01', 50), c('2026-03-01', 50), c('2026-04-01', 200), c('2026-05-01', 50), c('2026-06-01', 60)]);
    expect(r!.usual).toBe(50);
  });
  it('reads amounts by size whatever their sign', () => {
    expect(lastChargeRise([c('2026-04-01', -100), c('2026-05-01', -100), c('2026-06-01', -120)])!.pct).toBeCloseTo(0.2);
  });
});
