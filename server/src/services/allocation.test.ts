import { describe, it, expect } from 'vitest';
import { broadNonEquity, fallbackSector, looksInternational, looksDomesticEquityFund, lookThroughNotice, bondHolding, sortBondHoldings } from './allocation.js';

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

describe('bond card "Held in" list', () => {
  const accts = (o: Record<string, number>) => new Map(Object.entries(o).map(([k, v]) => [k, { value: v }]));

  it('spreads a fund\'s bond dollars over its accounts by their share of the position', () => {
    // A 60/40 fund worth $100k: $40k of bonds, held 75/25 in two accounts.
    const h = bondHolding('VBIAX', 'Vanguard Balanced Index', 40_000, 100_000, accts({ Roth: 25_000, '401k': 75_000 }));
    expect(h.value).toBe(40_000);
    expect(h.accounts).toEqual([{ name: '401k', value: 30_000 }, { name: 'Roth', value: 10_000 }]);
    expect(h.accounts.reduce((s, a) => s + a.value, 0)).toBeCloseTo(h.value);
  });

  it('handles a zero-value position without dividing by zero', () => {
    expect(bondHolding('BND', 'Bond', 0, 0, accts({ IRA: 0 })).accounts).toEqual([]);
  });

  it('lists positions largest first', () => {
    const list = sortBondHoldings([
      bondHolding('A', 'a', 5, 5, accts({ x: 5 })),
      bondHolding('B', 'b', 50, 50, accts({ x: 50 })),
      bondHolding('C', 'c', 20, 20, accts({ x: 20 })),
    ]);
    expect(list.map(h => h.symbol)).toEqual(['B', 'C', 'A']);
  });
});
