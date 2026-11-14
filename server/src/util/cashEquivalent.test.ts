import { describe, it, expect } from 'vitest';
import { isGovtBondName, cashKind } from './cashEquivalent.js';

describe('isGovtBondName', () => {
  it('recognises savings bonds and Treasuries by name', () => {
    for (const n of [
      'I Bonds (TreasuryDirect)', 'I-Bond', 'Series I Savings Bonds', 'EE Bonds', 'Series EE',
      'Savings Bonds', 'Treasury', 'Treasury Bonds', 'US Treasuries', 'T-Bills', 'T Bills',
      'T-Notes', 'T-Bond ladder', 'TreasuryDirect', 'Frec Treasury',
    ]) expect(isGovtBondName(n), n).toBe(true);
  });
  it('leaves other names alone', () => {
    for (const n of [
      'Individual Brokerage', 'Roth IRA', 'Online Savings', 'Total Checking', 'Muni Bonds',
      'Corporate Bond Fund', 'Total Bond Market', '401(k)', 'Savings', 'Bitcoin', 'Tesla stock',
    ]) expect(isGovtBondName(n), n).toBe(false);
  });
});

describe('cashKind', () => {
  it('counts anything in Cash & Banking', () => {
    expect(cashKind('banking', 'Online Savings')).toBe('banking');
    expect(cashKind('banking', 'Emergency fund')).toBe('banking');
  });
  it('counts savings bonds and Treasuries in any non-credit category', () => {
    expect(cashKind('brokerage', 'I Bonds (TreasuryDirect)')).toBe('bonds');
    expect(cashKind('other', 'Treasury Bonds')).toBe('bonds');
    // The name wins over the category so the report can name them as bonds.
    expect(cashKind('banking', 'Treasury')).toBe('bonds');
  });
  it('does not count other investments or credit', () => {
    expect(cashKind('brokerage', 'Individual Brokerage')).toBeNull();
    expect(cashKind('other', 'Car')).toBeNull();
    expect(cashKind('credit', 'Treasury Rewards Card')).toBeNull();
  });
});
