import { describe, it, expect } from 'vitest';
import { observationText, bucketLabel } from './assetLocation.ts';

const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;

describe('observationText', () => {
  it('states where things sit, with the amount', () => {
    expect(observationText({ kind: 'bonds-taxable', amount: 84_000 }, money))
      .toBe('$84,000 of bonds sit in taxable accounts, where their interest is taxed each year.');
    expect(observationText({ kind: 'foreign-sheltered', amount: 12_500 }, money)).toMatch(/^\$12,500 of foreign stock sits in tax-advantaged accounts/);
    expect(observationText({ kind: 'reits-taxable', amount: 3_000 }, money)).toMatch(/^\$3,000 of real-estate funds/);
  });

  it('uses the page formatter, so privacy masking applies', () => {
    expect(observationText({ kind: 'bonds-taxable', amount: 84_000 }, () => '••••••')).toMatch(/^•••••• of bonds/);
  });

  it('never tells the user to buy, sell or move anything', () => {
    for (const kind of ['bonds-taxable', 'reits-taxable', 'foreign-sheltered'] as const) {
      const t = observationText({ kind, amount: 1 }, money)!;
      expect(t).not.toMatch(/\b(buy|sell|move|switch|should|consider|recommend)\b/i);
    }
  });

  it('skips kinds it does not know', () => {
    expect(observationText({ kind: 'something-new' as never, amount: 1 }, money)).toBeNull();
  });
});

describe('bucketLabel', () => {
  it('labels known buckets and passes unknown ones through', () => {
    expect(bucketLabel('pretax')).toBe('Pre-tax');
    expect(bucketLabel('mystery')).toBe('mystery');
  });
});
