import { describe, it, expect } from 'vitest';
import { fmtMoneyShort, inputDisplayText, inputEditText, tableRowIndices, capYAxis, layoutPins } from './forecastDisplay.ts';

describe('fmtMoneyShort', () => {
  it('writes three significant figures with k / M / B', () => {
    expect(fmtMoneyShort(227772)).toBe('$228k');
    expect(fmtMoneyShort(1082888)).toBe('$1.08M');
    expect(fmtMoneyShort(12_480_000)).toBe('$12.5M');
    expect(fmtMoneyShort(4_538_431)).toBe('$4.54M');
    expect(fmtMoneyShort(9520)).toBe('$9.52k');
    expect(fmtMoneyShort(2_400_000_000)).toBe('$2.4B');
  });
  it('drops trailing zeros and keeps small amounts whole', () => {
    expect(fmtMoneyShort(97000)).toBe('$97k');
    expect(fmtMoneyShort(1_000_000)).toBe('$1M');
    expect(fmtMoneyShort(950)).toBe('$950');
    expect(fmtMoneyShort(0)).toBe('$0');
    expect(fmtMoneyShort(0.4)).toBe('$0');
  });
  it('moves a value that rounds up to the next unit', () => {
    expect(fmtMoneyShort(999_999)).toBe('$1M');
    expect(fmtMoneyShort(999_600)).toBe('$1M');
    expect(fmtMoneyShort(999.6)).toBe('$1k');
    expect(fmtMoneyShort(999.4)).toBe('$999');
  });
  it('uses a true minus sign for negatives', () => {
    expect(fmtMoneyShort(-60000)).toBe('−$60k');
    expect(fmtMoneyShort(-0.2)).toBe('$0');
  });
});

describe('number box text', () => {
  it('edits as plain digits, scaled by mul and rounded to cents', () => {
    expect(inputEditText(71772)).toBe('71772');
    expect(inputEditText(0.02, 100)).toBe('2');
    expect(inputEditText(0.0725, 100)).toBe('7.25');
    expect(inputEditText(1 / 3)).toBe('0.33');
  });
  it('shows money with $ and separators', () => {
    expect(inputDisplayText(71772, 1, 'money')).toBe('$71,772');
    expect(inputDisplayText(120000, 1, 'money')).toBe('$120,000');
    expect(inputDisplayText(1234.5, 1, 'money')).toBe('$1,234.5');
    expect(inputDisplayText(-60000, 1, 'money')).toBe('−$60,000');
    expect(inputDisplayText(0, 1, 'money')).toBe('$0');
  });
  it('shows percentages with % and no separators', () => {
    expect(inputDisplayText(0.02, 100, 'percent')).toBe('2%');
    expect(inputDisplayText(0.075, 100, 'percent')).toBe('7.5%');
    expect(inputDisplayText(12.5, 1, 'percent')).toBe('12.5%');
  });
  it('leaves ages and years bare: no $, no separators', () => {
    expect(inputDisplayText(65)).toBe('65');
    expect(inputDisplayText(2045)).toBe('2045');
    expect(inputDisplayText(12000, 1, 'plain')).toBe('12000');
  });
});

describe('tableRowIndices', () => {
  const ages = Array.from({ length: 51 }, (_, i) => 40 + i); // 40 … 90
  it('takes every interval-th year plus the last', () => {
    const idx = tableRowIndices(ages, 10, 40);
    expect(idx.map(i => ages[i])).toEqual([40, 50, 60, 70, 80, 90]);
  });
  it('always includes the retirement year', () => {
    expect(tableRowIndices(ages, 5, 67).map(i => ages[i])).toEqual([40, 45, 50, 55, 60, 65, 67, 70, 75, 80, 85, 90]);
    expect(tableRowIndices(ages, 10, 62).map(i => ages[i])).toContain(62);
  });
  it('every year is every row', () => {
    expect(tableRowIndices(ages, 1, 65)).toHaveLength(51);
  });
  it('treats a junk interval as every year', () => {
    expect(tableRowIndices([40, 41, 42], 0, 99)).toEqual([0, 1, 2]);
  });
  it('keeps the last year once when it is also the retirement year', () => {
    expect(tableRowIndices([40, 41, 42, 43], 5, 43)).toEqual([0, 3]);
  });
});

describe('capYAxis', () => {
  it('caps the axis near the median when the band runs far above it', () => {
    const cap = capYAxis({ medianMax: 13e6, rangeMax: 36e6, min: 500e3 });
    expect(cap).not.toBeNull();
    expect(cap!.domain[0]).toBe(0);
    // A modest multiple of the median's top: the median uses most of the plot.
    expect(cap!.domain[1]).toBeGreaterThanOrEqual(13e6 * 1.25);
    expect(cap!.domain[1]).toBeLessThanOrEqual(13e6 * 1.6);
    expect(13e6 / cap!.domain[1]).toBeGreaterThan(0.6);
    expect(cap!.ticks[0]).toBe(0);
    expect(cap!.ticks[cap!.ticks.length - 1]).toBe(cap!.domain[1]);
  });
  it('leaves the axis alone when the band already fits', () => {
    expect(capYAxis({ medianMax: 1e6, rangeMax: 1.2e6, min: 0 })).toBeNull();
  });
  it('keeps a negative low end', () => {
    const cap = capYAxis({ medianMax: 1e6, rangeMax: 5e6, min: -200e3 });
    expect(cap!.domain[0]).toBeLessThanOrEqual(-200e3);
  });
  it('does nothing for an empty or non-positive median', () => {
    expect(capYAxis({ medianMax: 0, rangeMax: 5e6, min: 0 })).toBeNull();
    expect(capYAxis({ medianMax: NaN, rangeMax: 5e6, min: 0 })).toBeNull();
  });
});

describe('layoutPins', () => {
  it('leaves pins that are far enough apart where they are', () => {
    expect(layoutPins([100, 200, 300], 24, 0, 1000)).toEqual([100, 200, 300]);
  });
  it('pushes overlapping pins apart by the gap', () => {
    expect(layoutPins([100, 105, 110], 24, 0, 1000)).toEqual([100, 124, 148]);
  });
  it('pulls a row back from the right edge', () => {
    expect(layoutPins([980, 990, 995], 24, 0, 1000)).toEqual([952, 976, 1000]);
  });
  it('clamps into the lane', () => {
    expect(layoutPins([-20, 1200], 24, 10, 900)).toEqual([10, 900]);
  });
  it('spreads a row too long for the lane evenly', () => {
    const out = layoutPins([50, 50, 50, 50], 40, 0, 90);
    expect(out[0]).toBe(0);
    expect(out[3]).toBe(90);
  });
  it('handles no pins', () => {
    expect(layoutPins([], 24, 0, 100)).toEqual([]);
  });
});
