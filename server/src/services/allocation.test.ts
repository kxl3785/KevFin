import { describe, it, expect } from 'vitest';
import { broadNonEquity, fallbackSector } from './allocation.js';

describe('allocation name classification', () => {
  // "Treasury Wine Estates" still matches by name; getAllocation guards that by
  // only applying name rules when quoteType !== 'EQUITY'.
  it('does not treat substring-only matches as commodity funds', () => {
    expect(broadNonEquity('GS', 'Goldman Sachs Group Inc')).toBeNull();
    expect(fallbackSector('GS', 'Goldman Sachs Group Inc', false)).toBe('Cash / Other');
    expect(fallbackSector('SPOIL', 'Spoiler Corp', false)).toBe('Cash / Other');
  });

  it('still classifies real gold / oil / treasury funds', () => {
    expect(broadNonEquity('GLD', 'SPDR Gold Shares')).toBe('Commodities');
    expect(broadNonEquity('USO', 'United States Oil Fund')).toBe('Commodities');
    expect(broadNonEquity('IEF', 'iShares 7-10 Year Treasury Bond ETF')).toBe('Bonds');
    expect(fallbackSector('SGOL', 'abrdn Physical Gold', false)).toBe('Commodities / Alternatives');
    expect(fallbackSector('X', 'US Treasury Fund', false)).toBe('Bonds');
  });
});
