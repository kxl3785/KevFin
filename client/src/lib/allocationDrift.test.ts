import { describe, it, expect } from 'vitest';
import { investableWeights, driftLabel } from './allocationDrift.ts';

const KEYS = ['Domestic Stock', 'Foreign Stock', 'Bonds'];

describe('investableWeights', () => {
  it('renormalises model classes and reports the share outside the model', () => {
    // 80% investable (40/20/20), 20% real estate of the grand total.
    const r = investableWeights({ 'Domestic Stock': 40, 'Foreign Stock': 20, Bonds: 20, 'Real Estate': 20 }, KEYS);
    expect(r.investablePct['Domestic Stock']).toBeCloseTo(50);
    expect(r.investablePct['Foreign Stock']).toBeCloseTo(25);
    expect(Object.values(r.investablePct).reduce((a, b) => a + b, 0)).toBeCloseTo(100);
    expect(r.outsidePct).toBeCloseTo(20);
    expect(r.comparable).toBe(true);
  });
  it('is not comparable with no investable assets', () => {
    const r = investableWeights({ 'Real Estate': 100 }, KEYS);
    expect(r.comparable).toBe(false);
    expect(r.outsidePct).toBe(100);
  });
});

describe('driftLabel', () => {
  it('words drift in points', () => {
    expect(driftLabel(60, 43)).toEqual({ text: '17 pts below model', under: true });
    expect(driftLabel(10, 13)).toEqual({ text: '3 pts above model', under: false });
  });
  it('is silent inside one point', () => {
    expect(driftLabel(30, 30.6)).toBeNull();
  });
  it('uses singular for one point', () => {
    expect(driftLabel(31, 30)?.text).toBe('1 pt below model');
  });
});
