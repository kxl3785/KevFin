import { describe, it, expect } from 'vitest';
import { niceStep, axisScale, fmtAxisMoney, dateTicks } from './axis.ts';

describe('niceStep', () => {
  it('rounds up to 1/2/2.5/5 × 10ⁿ', () => {
    expect(niceStep(1)).toBe(1);
    expect(niceStep(1.5)).toBe(2);
    expect(niceStep(2.1)).toBe(2.5);
    expect(niceStep(3)).toBe(5);
    expect(niceStep(7)).toBe(10);
    expect(niceStep(23_000)).toBe(25_000);
    expect(niceStep(180_000)).toBe(200_000);
  });

  it('survives degenerate input', () => {
    expect(niceStep(0)).toBe(1);
    expect(niceStep(-5)).toBe(1);
    expect(niceStep(NaN)).toBe(1);
  });
});

describe('axisScale', () => {
  it('pins the floor to 0 when zero-based', () => {
    const { domain, ticks } = axisScale(0, 663_738, { zeroBased: true });
    expect(domain[0]).toBe(0);
    expect(domain[1]).toBeGreaterThanOrEqual(663_738);
    expect(ticks[0]).toBe(0);
  });

  // The old fixed $100k step put a small portfolio inside one $0–$100k band,
  // so every point sat crushed on the baseline with no readable movement.
  it('zooms in on a small portfolio instead of using a $100k band', () => {
    const { domain, step } = axisScale(38_000, 44_000);
    expect(step).toBeLessThanOrEqual(2_500);
    expect(domain[0]).toBeGreaterThan(30_000);
    expect(domain[1] - domain[0]).toBeLessThan(20_000);
  });

  // ...and the same step made a $40k move on a $1.4M portfolio invisible.
  it('zooms in on a narrow move at the top of the range', () => {
    const { domain } = axisScale(1_380_000, 1_420_000);
    expect(domain[1] - domain[0]).toBeLessThanOrEqual(100_000);
  });

  it('every tick lands exactly on the step', () => {
    const { ticks, step } = axisScale(1_380_000, 1_420_000);
    for (const t of ticks) expect(Math.abs(t / step - Math.round(t / step))).toBeLessThan(1e-9);
    expect(new Set(ticks).size).toBe(ticks.length);
  });

  it('opens a window around a dead-flat series', () => {
    const { domain, ticks } = axisScale(500_000, 500_000);
    expect(domain[1]).toBeGreaterThan(domain[0]);
    expect(ticks.length).toBeGreaterThan(1);
  });

  // A single snapshot on a brand-new install: min === max === 0.
  it('produces a drawable axis with no data', () => {
    const { domain, ticks } = axisScale(0, 0, { zeroBased: true });
    expect(domain[1]).toBeGreaterThan(domain[0]);
    expect(ticks.length).toBeGreaterThan(1);
    expect(ticks.every(Number.isFinite)).toBe(true);
  });

  it('handles a negative net worth', () => {
    const { domain, ticks } = axisScale(-40_000, 12_000);
    expect(domain[0]).toBeLessThanOrEqual(-40_000);
    expect(domain[1]).toBeGreaterThanOrEqual(12_000);
    expect(ticks.some(t => t < 0)).toBe(true);
  });

  it('never emits an unbounded tick list', () => {
    expect(axisScale(0, 1e12, { zeroBased: true }).ticks.length).toBeLessThanOrEqual(25);
    expect(axisScale(Infinity, NaN).ticks.length).toBeLessThanOrEqual(25);
  });
});

describe('fmtAxisMoney', () => {
  it('renders round money compactly', () => {
    expect(fmtAxisMoney(0, 100_000)).toBe('$0');
    expect(fmtAxisMoney(750_000, 250_000)).toBe('$750k');
    expect(fmtAxisMoney(1_500_000, 500_000)).toBe('$1.5M');
    expect(fmtAxisMoney(2_000_000, 1_000_000)).toBe('$2M');
  });

  // A $250k step needs two decimals or 1.25M and 1.5M both print as "1.3M".
  it('takes its precision from the step', () => {
    expect(fmtAxisMoney(1_250_000, 250_000)).toBe('$1.25M');
    expect(fmtAxisMoney(1_500_000, 250_000)).toBe('$1.50M');
  });

  it('does not render $0 as "$0k"', () => {
    expect(fmtAxisMoney(0, 1_000)).toBe('$0');
    expect(fmtAxisMoney(400, 100)).toBe('$400');
  });

  it('keeps the minus outside the dollar sign', () => {
    expect(fmtAxisMoney(-40_000, 20_000)).toBe('-$40k');
  });
});

describe('dateTicks', () => {
  const daily = (from: string, n: number) => {
    const out: string[] = [];
    const d = new Date(from + 'T00:00:00Z');
    for (let i = 0; i < n; i++) {
      out.push(d.toISOString().slice(0, 10));
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return out;
  };

  // The dashboard rendered "26-03" twice in a row, because recharts picks ticks
  // by index and two of them fell in the same month.
  it('never repeats a label', () => {
    const { ticks, label } = dateTicks(daily('2026-01-01', 210));
    const labels = ticks.map(label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('honours the tick budget', () => {
    const { ticks } = dateTicks(daily('2024-01-01', 900), 5);
    expect(ticks.length).toBeLessThanOrEqual(5);
  });

  it('labels months inside a short window and years across a long one', () => {
    const { label: short } = dateTicks(daily('2026-01-01', 120));
    expect(short('2026-03-15')).toBe('Mar ’26');

    const { label: long } = dateTicks(daily('2019-01-01', 2600));
    expect(long('2021-06-15')).toBe('2021');
  });

  it('reads the label off the string, never a parsed Date', () => {
    // 'YYYY-MM-DD' parsed as UTC midnight and formatted locally slips to the
    // previous month for anyone west of UTC — slicing cannot.
    const { label } = dateTicks(['2026-01-01', '2026-03-01']);
    expect(label('2026-03-01')).toBe('Mar ’26');
  });

  it('handles an empty series', () => {
    expect(dateTicks([]).ticks).toEqual([]);
  });
});
