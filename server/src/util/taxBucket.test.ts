import { describe, it, expect } from 'vitest';
import { taxBucket, TAX_BUCKETS } from './taxBucket.js';

describe('taxBucket', () => {
  it('classifies HSA accounts, even when also named like a brokerage', () => {
    expect(taxBucket('HSA Brokerage')).toBe('hsa');
    expect(taxBucket('Health Savings Account')).toBe('hsa');
    expect(taxBucket('Fidelity HSA')).toBe('hsa');
  });

  it('classifies college/education accounts', () => {
    expect(taxBucket('529 College Savings')).toBe('college');
    expect(taxBucket('Coverdell ESA')).toBe('college');
    expect(taxBucket('Education Savings Plan')).toBe('college');
  });

  it('classifies Roth accounts, winning over the generic retirement test', () => {
    expect(taxBucket('Roth IRA')).toBe('roth');     // must beat \bira\b → pretax
    expect(taxBucket('Roth 401(k)')).toBe('roth');  // must beat \b401 → pretax
  });

  it('classifies a wide range of pre-tax retirement accounts', () => {
    expect(taxBucket('BJC 401(K)')).toBe('pretax');
    expect(taxBucket('UTSAVER 403b')).toBe('pretax');
    expect(taxBucket('457 Deferred Comp')).toBe('pretax');
    expect(taxBucket('Traditional IRA')).toBe('pretax');
    expect(taxBucket('SEP IRA')).toBe('pretax');
    expect(taxBucket('Pension Plan')).toBe('pretax');
  });

  it('defaults everything else to taxable', () => {
    expect(taxBucket('Fidelity Brokerage')).toBe('taxable');
    expect(taxBucket('Checking')).toBe('taxable');
    expect(taxBucket('Savings')).toBe('taxable');
    expect(taxBucket('Individual TOD')).toBe('taxable');
    expect(taxBucket('')).toBe('taxable');
  });

  it('is case-insensitive', () => {
    expect(taxBucket('RoTh IrA')).toBe('roth');
    expect(taxBucket('health savings account')).toBe('hsa');
  });

  it('honors the documented priority order (HSA/college/Roth before generic)', () => {
    // A name matching several rules resolves by the order in the implementation.
    expect(taxBucket('Roth HSA')).toBe('hsa');     // hsa tested first
    expect(taxBucket('529 Roth')).toBe('college'); // college before roth
  });

  it('respects word boundaries (does not over-match HSA inside a word)', () => {
    expect(taxBucket('Cash Account')).toBe('taxable');
  });

  it('always returns a member of TAX_BUCKETS', () => {
    for (const name of ['Roth IRA', 'HSA', '529', '401k', 'Checking', 'random', '']) {
      expect(TAX_BUCKETS).toContain(taxBucket(name));
    }
  });
});
