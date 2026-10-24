import { describe, it, expect } from 'vitest';
import { accountValueAt } from './performance.js';

// Positions are today's holdings scaled by price movement. Before a ticker's
// first price, the position must be lead-filled with its first close — not held
// flat at today's value, which fakes a jump on the day the data begins.
describe('accountValueAt', () => {
  const holdings = new Map([[
    'a1',
    [{ symbol: 'NEW', description: 'New Fund', marketValue: 1000, costBasis: null, shares: null, acquired: null }],
  ]]);
  const latest = new Map([['NEW', 200]]);
  const first = new Map([['NEW', 100]]);
  // NEW has prices only from 2024-03-01 on.
  const filled = new Map([['NEW', new Map([['2024-03-01', 100], ['2024-06-01', 200]])]]);

  it('uses the price ratio where data exists', () => {
    expect(accountValueAt('a1', 1500, holdings, filled, latest, first, '2024-03-01')).toBe(500 + 500);
    expect(accountValueAt('a1', 1500, holdings, filled, latest, first, '2024-06-01')).toBe(500 + 1000);
  });

  it('lead-fills with the first close before inception (no false jump)', () => {
    expect(accountValueAt('a1', 1500, holdings, filled, latest, first, '2024-01-01')).toBe(500 + 500);
  });

  it('still holds flat when there is no price data at all', () => {
    expect(accountValueAt('a1', 1500, holdings, new Map(), new Map(), new Map(), '2024-01-01')).toBe(1500);
  });
});
