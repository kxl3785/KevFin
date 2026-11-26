import { describe, it, expect } from 'vitest';
import { growthPctText, growthNote, growthExplanation, type HomeGrowth } from './homeGrowth.ts';

const five: HomeGrowth = { rate: 0.0618, years: 5, from: '2021-11-26', to: '2026-11-26', source: 'history' };

describe('growthPctText', () => {
  it('keeps one decimal at most', () => {
    expect(growthPctText(0.04)).toBe('4%');
    expect(growthPctText(0.0618)).toBe('6.2%');
  });
  it('uses a real minus sign, and never "−0%"', () => {
    expect(growthPctText(-0.013)).toBe('−1.3%');
    expect(growthPctText(-0.0001)).toBe('0%');
  });
});

describe('growthNote', () => {
  it('names the period and the rate for a home with history', () => {
    expect(growthNote(five, 0.04)).toBe('5-yr avg, 6.2%/yr');
    expect(growthNote({ ...five, years: 3.46 }, 0.04)).toBe('3.5-yr avg, 6.2%/yr');
  });
  it("falls back to the Forecast's rate", () => {
    expect(growthNote(undefined, 0.04)).toBe('est. at 4%/yr');
  });
});

describe('growthExplanation', () => {
  it('says which history the rate came from, and over what period', () => {
    const own = growthExplanation(five, 0.04);
    expect(own).toContain('6.2% a year');
    expect(own).toContain('Nov 2021 to Nov 2026');
    expect(own).toContain('entered for this home');
    const zip = growthExplanation({ ...five, source: 'zip', to: '2026-10-31', from: '2021-10-31' }, 0.04);
    expect(zip).toContain('ZIP code');
    expect(zip).toContain('Oct 2021 to Oct 2026');
  });
  it('explains the fallback', () => {
    expect(growthExplanation(undefined, 0.04)).toContain('Forecast → Home');
  });
});
