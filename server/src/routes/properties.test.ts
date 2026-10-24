import { describe, it, expect } from 'vitest';
import { parsePropertyPatch } from './properties.js';

describe('parsePropertyPatch', () => {
  it('rejects a zero/negative mortgage term (would zero the liability)', () => {
    expect(parsePropertyPatch({ mortgage_term_years: 0 })).toHaveProperty('error');
    expect(parsePropertyPatch({ mortgage_term_years: -5 })).toHaveProperty('error');
    expect(parsePropertyPatch({ mortgage_term_years: '0' })).toHaveProperty('error');
    expect(parsePropertyPatch({ mortgage_term_years: 30 })).toEqual({ updates: [['mortgage_term_years', 30]] });
  });

  it('rejects a mortgage_start that is not a real YYYY-MM-DD date', () => {
    for (const bad of ['garbage', '2020-13-45', '1/2/2020', 20200101, '']) {
      expect(parsePropertyPatch({ mortgage_start: bad })).toHaveProperty('error');
    }
    expect(parsePropertyPatch({ mortgage_start: '2020-06-01' })).toEqual({ updates: [['mortgage_start', '2020-06-01']] });
    expect(parsePropertyPatch({ mortgage_start: null })).toEqual({ updates: [['mortgage_start', null]] });
  });

  it('coerces numeric strings, rejects junk, and clears with null', () => {
    expect(parsePropertyPatch({ value: '450000' })).toEqual({ updates: [['zestimate', 450000]] });
    expect(parsePropertyPatch({ value: '495,000' })).toHaveProperty('error');
    expect(parsePropertyPatch({ value: '' })).toHaveProperty('error');
    expect(parsePropertyPatch({ value: true })).toHaveProperty('error');
    expect(parsePropertyPatch({ value: null })).toEqual({ updates: [['zestimate', null]] });
  });

  it('maps a cleared mortgage_balance to 0 (the column is NOT NULL)', () => {
    expect(parsePropertyPatch({ mortgage_balance: null })).toEqual({ updates: [['mortgage_balance', 0]] });
  });
});
