import { describe, it, expect } from 'vitest';
import { broadNonEquity, fallbackSector, looksInternational, looksDomesticEquityFund, lookThroughNotice } from './allocation.js';

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

describe('country fallback heuristics (funds with no constituent countries)', () => {
  it('treats plain US equity funds as domestic', () => {
    expect(looksDomesticEquityFund('FXAIX', 'Fidelity 500 Index Fund')).toBe(true);
    expect(looksDomesticEquityFund('VTI', 'Vanguard Total Stock Market ETF')).toBe(true);
  });
  it('does not call international or mixed-mandate funds domestic', () => {
    expect(looksInternational('VXUS', 'Vanguard Total International Stock ETF')).toBe(true);
    expect(looksDomesticEquityFund('VXUS', 'Vanguard Total International Stock ETF')).toBe(false);
    expect(looksDomesticEquityFund('VFFVX', 'Vanguard Target Retirement 2055 Fund')).toBe(false);
    expect(looksDomesticEquityFund('VT', 'Vanguard Total World Stock ETF')).toBe(false);
  });
});

describe('lookThroughNotice', () => {
  const issue = { issue: 'no-contact' as const, detail: 'needs an email' };
  it('is reported only when a fund lacked deep holdings and the cause is known', () => {
    expect(lookThroughNotice(true, issue)).toEqual(issue);
    expect(lookThroughNotice(false, issue)).toBeUndefined();
    expect(lookThroughNotice(true, null)).toBeUndefined();
  });
});
