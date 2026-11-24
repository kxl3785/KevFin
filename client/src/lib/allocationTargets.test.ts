import { describe, it, expect } from 'vitest';
import {
  normalizeTargetsPref, customTotal, isCompleteTargets, customModel, parseTargetInput, totalMessage,
  DEFAULT_TARGETS_PREF, DEFAULT_BAND, effectiveTargets, targetWording, withTargetNoun,
} from './allocationTargets.ts';
import { RISK_PROFILES } from './riskProfiles.ts';

describe('normalizeTargetsPref', () => {
  it('falls back to the defaults for missing or wrong-shaped values', () => {
    expect(normalizeTargetsPref(undefined)).toEqual(DEFAULT_TARGETS_PREF);
    expect(normalizeTargetsPref(null)).toEqual(DEFAULT_TARGETS_PREF);
    expect(normalizeTargetsPref([])).toEqual(DEFAULT_TARGETS_PREF);
    expect(normalizeTargetsPref({ mode: 'weird', custom: 'x', band: 'y' })).toEqual(DEFAULT_TARGETS_PREF);
  });
  it('keeps known classes with sensible numbers and drops the rest', () => {
    const p = normalizeTargetsPref({
      mode: 'custom',
      custom: { 'Domestic Stock': 60.04, Bonds: 40, 'Real Estate': 10, Crypto: -1, Commodities: NaN, 'Foreign Stock': 101 },
      band: 3,
    });
    expect(p).toEqual({ mode: 'custom', custom: { 'Domestic Stock': 60, Bonds: 40 }, band: 3 });
  });
  it('accepts a zero band and rejects one outside 0..25', () => {
    expect(normalizeTargetsPref({ band: 0 }).band).toBe(0);
    expect(normalizeTargetsPref({ band: 25 }).band).toBe(25);
    expect(normalizeTargetsPref({ band: 26 }).band).toBe(DEFAULT_BAND);
    expect(normalizeTargetsPref({ band: -1 }).band).toBe(DEFAULT_BAND);
    expect(normalizeTargetsPref({ band: Infinity }).band).toBe(DEFAULT_BAND);
  });
});

describe('customTotal / isCompleteTargets', () => {
  it('adds tenths exactly', () => {
    const c = { 'Domestic Stock': 33.3, 'Foreign Stock': 33.3, Bonds: 33.4 };
    expect(customTotal(c)).toBe(100);
    expect(isCompleteTargets(c)).toBe(true);
  });
  it('is not complete under or over 100', () => {
    expect(isCompleteTargets({ 'Domestic Stock': 99.9 })).toBe(false);
    expect(isCompleteTargets({ 'Domestic Stock': 60, Bonds: 40.1 })).toBe(false);
    expect(isCompleteTargets({})).toBe(false);
  });
  it('ignores classes outside the target list', () => {
    expect(customTotal({ 'Domestic Stock': 100, 'Real Estate': 50 })).toBe(100);
  });
});

describe('customModel', () => {
  it('fills every class, missing = 0', () => {
    expect(customModel({ 'Domestic Stock': 70, Bonds: 30 })).toEqual({
      'Domestic Stock': 70, 'Foreign Stock': 0, Bonds: 30, 'Short Term': 0, Commodities: 0, Crypto: 0,
    });
  });
  it('is null unless the targets add up to 100', () => {
    expect(customModel({ 'Domestic Stock': 70 })).toBeNull();
    expect(customModel({})).toBeNull();
  });
});

describe('parseTargetInput', () => {
  it('reads whole numbers, one decimal, a trailing % and blank as 0', () => {
    expect(parseTargetInput('40')).toEqual({ value: 40 });
    expect(parseTargetInput(' 12.5 ')).toEqual({ value: 12.5 });
    expect(parseTargetInput('40%')).toEqual({ value: 40 });
    expect(parseTargetInput('.5')).toEqual({ value: 0.5 });
    expect(parseTargetInput('')).toEqual({ value: 0 });
    expect(parseTargetInput('0')).toEqual({ value: 0 });
    expect(parseTargetInput('100')).toEqual({ value: 100 });
  });
  it('rejects negatives, over 100, extra decimals and junk', () => {
    for (const t of ['-5', '100.1', '101', 'abc', '1,000', '1e2']) expect(parseTargetInput(t)).toHaveProperty('error');
    expect(parseTargetInput('12.25')).toEqual({ error: 'Use at most one decimal place.' });
  });
  it('ignores trailing zeros after the point (RB-6)', () => {
    expect(parseTargetInput('12.50')).toEqual({ value: 12.5 });
    expect(parseTargetInput('40.00')).toEqual({ value: 40 });
    expect(parseTargetInput('40.')).toEqual({ value: 40 });
    expect(parseTargetInput('7.500%')).toEqual({ value: 7.5 });
    expect(parseTargetInput('100.00')).toEqual({ value: 100 });
    // Two significant decimals are still refused, and over 100 still is.
    expect(parseTargetInput('12.55')).toEqual({ error: 'Use at most one decimal place.' });
    expect(parseTargetInput('12.550')).toEqual({ error: 'Use at most one decimal place.' });
    expect(parseTargetInput('100.10')).toHaveProperty('error');
    expect(parseTargetInput('.')).toHaveProperty('error');
  });
});

describe('totalMessage', () => {
  it('words the running total', () => {
    expect(totalMessage(100)).toEqual({ text: 'Adds up to 100%', complete: true });
    expect(totalMessage(98.5)).toEqual({ text: '1.5 points left to assign', complete: false });
    expect(totalMessage(99)).toEqual({ text: '1 point left to assign', complete: false });
    expect(totalMessage(102)).toEqual({ text: '2 points over 100%', complete: false });
    expect(totalMessage(0)).toEqual({ text: '100 points left to assign', complete: false });
  });
});

describe('effectiveTargets', () => {
  const growth = RISK_PROFILES.growth;
  it('with the default setting, is exactly the risk profile model (unchanged behaviour)', () => {
    expect(effectiveTargets(DEFAULT_TARGETS_PREF, growth)).toEqual({ model: growth.model, source: 'profile' });
    expect(effectiveTargets(DEFAULT_TARGETS_PREF, growth).model).toBe(growth.model);
    expect(effectiveTargets(DEFAULT_TARGETS_PREF, null)).toEqual({ model: null, source: null });
  });
  it('saved custom targets are ignored while the profile is chosen', () => {
    const pref = { mode: 'profile' as const, custom: { 'Domestic Stock': 100 }, band: 5 };
    expect(effectiveTargets(pref, growth).source).toBe('profile');
  });
  it('uses custom targets when chosen and complete', () => {
    const pref = { mode: 'custom' as const, custom: { 'Domestic Stock': 70, Bonds: 30 }, band: 5 };
    const r = effectiveTargets(pref, growth);
    expect(r.source).toBe('custom');
    expect(r.model?.['Domestic Stock']).toBe(70);
    expect(r.model?.Crypto).toBe(0);
    expect(effectiveTargets(pref, null).source).toBe('custom');
  });
  it('falls back to the profile when chosen custom targets do not add up to 100', () => {
    const pref = { mode: 'custom' as const, custom: { 'Domestic Stock': 70 }, band: 5 };
    expect(effectiveTargets(pref, growth).source).toBe('profile');
    expect(effectiveTargets(pref, null)).toEqual({ model: null, source: null });
  });
});

describe('targetWording / withTargetNoun (RB-4 / RBUI-3)', () => {
  it('keeps the "model" wording for a risk profile and says "target" for your own', () => {
    expect(targetWording('profile')).toEqual({ bar: 'Model', noun: 'model', footnoteLead: 'Model compares' });
    expect(targetWording(null)).toEqual({ bar: 'Model', noun: 'model', footnoteLead: 'Model compares' });
    expect(targetWording('custom')).toEqual({ bar: 'Target', noun: 'target', footnoteLead: 'Targets compare' });
  });
  it('swaps only the trailing noun of a drift label', () => {
    expect(withTargetNoun('12 pts below model', 'target')).toBe('12 pts below target');
    expect(withTargetNoun('1 pt above model', 'target')).toBe('1 pt above target');
    expect(withTargetNoun('3 pts above model', 'model')).toBe('3 pts above model');
  });
});
