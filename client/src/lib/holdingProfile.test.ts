import { describe, it, expect } from 'vitest';
import { formatMix, mixToInput, parseMixInput, type MixPart } from './holdingProfile.ts';

const mixOf = (text: string): MixPart[] => {
  const r = parseMixInput(text);
  if ('error' in r) throw new Error(`expected a mix for "${text}", got: ${r.error}`);
  return r.mix;
};
const errorOf = (text: string): string => {
  const r = parseMixInput(text);
  if (!('error' in r)) throw new Error(`expected an error for "${text}"`);
  return r.error;
};
const VTI_BND = [{ ticker: 'VTI', weight: 0.6 }, { ticker: 'BND', weight: 0.4 }];

describe('parseMixInput', () => {
  it('reads a single ticker as the whole holding', () => {
    expect(mixOf('VFFVX')).toEqual([{ ticker: 'VFFVX', weight: 1 }]);
    expect(mixOf('  vffvx ')).toEqual([{ ticker: 'VFFVX', weight: 1 }]);
    expect(mixOf('VFFVX 100%')).toEqual([{ ticker: 'VFFVX', weight: 1 }]);
    expect(mixOf('VFFVX 1')).toEqual([{ ticker: 'VFFVX', weight: 1 }]);
  });

  it('reads the supported mix spellings', () => {
    for (const t of ['vti 60, bnd 40', 'VTI 60% / BND 40%', 'VTI:60 BND:40', 'VTI 0.6, BND 0.4', '60% VTI, 40% BND', 'VTI 60\nBND 40', 'VTI 60; BND 40', 'VTI - 60, BND - 40']) {
      const m = mixOf(t);
      expect(m.map(p => p.ticker), t).toEqual(['VTI', 'BND']);
      expect(m[0].weight, t).toBeCloseTo(0.6, 12);
      expect(m[1].weight, t).toBeCloseTo(0.4, 12);
    }
  });

  it('keeps ticker punctuation', () => {
    expect(mixOf('BRK.B 50, BRK-B 50').map(p => p.ticker)).toEqual(['BRK.B', 'BRK-B']);
  });

  it('accepts rounded fact-sheet figures and normalizes to exactly 1', () => {
    const m = mixOf('VTI 33.3, VXUS 33.3, BND 33.3');
    expect(m.reduce((s, p) => s + p.weight, 0)).toBeCloseTo(1, 12);
    expect(m[0].weight).toBeCloseTo(1 / 3, 12);
    expect(mixOf('VTI 60.4, BND 40').length).toBe(2);
  });

  it('explains a sum that is off', () => {
    expect(errorOf('VTI 60, BND 30')).toBe('Percentages add up to 90%, not 100%.');
    expect(errorOf('VTI 60, BND 41')).toBe('Percentages add up to 101%, not 100%.');
    expect(errorOf('VTI 0.6, BND 0.3')).toBe('Fractions add up to 0.9, not 1.');
  });

  it('explains other mistakes in plain English', () => {
    expect(errorOf('')).toMatch(/Enter a ticker/);
    expect(errorOf('   ')).toMatch(/Enter a ticker/);
    expect(errorOf('VTI 60, BND')).toBe('Give BND a percentage too, like VTI 60, BND 40.');
    expect(errorOf('VTI, BND')).toMatch(/Give VTI a percentage/);
    expect(errorOf('60 40')).toMatch(/needs a ticker/);
    expect(errorOf('VTI 60 40')).toMatch(/“40” needs a ticker before it/);
    expect(errorOf('60% VTI, 40%')).toMatch(/“40” needs a ticker after it/);
    expect(errorOf('VTI 60, vti 40')).toBe('VTI is listed twice.');
    expect(errorOf('VTI 100, BND 0')).toBe('BND’s share must be more than 0.');
    expect(errorOf('VTI 60')).toMatch(/single fund is the whole holding/);
    expect(errorOf('V$TI')).toMatch(/doesn’t look like a ticker/);
    expect(errorOf('ABCDEFGHIJKLMNOP')).toMatch(/doesn’t look like a ticker/);
    const eleven = Array.from({ length: 11 }, (_, i) => `T${i} ${i === 0 ? 0 : 10}`).join(', ');
    expect(errorOf(eleven)).toBe('List at most 10 funds.');
  });
});

describe('formatMix', () => {
  it('shows just the ticker for a one-fund description', () => {
    expect(formatMix([{ ticker: 'VFFVX', weight: 1 }])).toBe('VFFVX');
  });
  it('shows each part with its percent', () => {
    expect(formatMix(VTI_BND)).toBe('VTI 60% · BND 40%');
    expect(formatMix([{ ticker: 'A', weight: 1 / 3 }, { ticker: 'B', weight: 2 / 3 }])).toBe('A 33.3% · B 66.7%');
  });
});

describe('mixToInput', () => {
  it('round-trips through parseMixInput', () => {
    expect(mixToInput(VTI_BND)).toBe('VTI 60, BND 40');
    expect(mixToInput([{ ticker: 'VFFVX', weight: 1 }])).toBe('VFFVX');
    for (const m of [VTI_BND, [{ ticker: 'VFFVX', weight: 1 }], [{ ticker: 'A', weight: 1 / 3 }, { ticker: 'B', weight: 2 / 3 }]]) {
      const back = mixOf(mixToInput(m));
      expect(back.map(p => p.ticker)).toEqual(m.map(p => p.ticker));
      back.forEach((p, i) => expect(p.weight).toBeCloseTo(m[i].weight, 4));
    }
  });
});
