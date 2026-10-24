import { describe, expect, it } from 'vitest';
import { merchantDomain } from './merchantLogo.ts';

describe('merchantDomain', () => {
  it('matches brands as whole words', () => {
    expect(merchantDomain('AMAZON.COM*AB12')).toBe('amazon.com');
    expect(merchantDomain("McDonald's #1234")).toBe('mcdonalds.com');
    expect(merchantDomain('T-MOBILE BILL PAY')).toBe('t-mobile.com');
    expect(merchantDomain('CHASE CREDIT CRD AUTOPAY')).toBe('chase.com');
    expect(merchantDomain('BP#1234 FUEL')).toBe('bp.com');
    expect(merchantDomain('MOBIL 5551')).toBe('exxon.com');
  });
  it('still catches run-together descriptors', () => {
    expect(merchantDomain('EXXONMOBIL 12345')).toBe('exxon.com');
    expect(merchantDomain('STEAMGAMES.COM 4259522985')).toBe('steampowered.com');
    expect(merchantDomain('UBEREATS HELP.UBER.COM')).toBe('ubereats.com');
    expect(merchantDomain('HBOMAX.COM')).toBe('hbomax.com');
  });
  it('does not match inside other words or numbers', () => {
    expect(merchantDomain('PURCHASE AUTHORIZED')).toBeNull();
    expect(merchantDomain('ADVANCE 1769 SERVICES')).toBeNull();
    expect(merchantDomain('NEIGHBORHOOD CAFE')).toBeNull();
    expect(merchantDomain('T-MOBILE')).not.toBe('exxon.com');
  });
});
