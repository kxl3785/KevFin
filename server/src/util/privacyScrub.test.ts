import { describe, it, expect } from 'vitest';
import { placeLabel, propertyLabels, scrubText, scrubDeep, addressRedactor } from './privacyScrub.js';

describe('placeLabel', () => {
  it('keeps the town and state, drops the street, ZIP and country', () => {
    expect(placeLabel('742 Evergreen Terrace, Springfield, OR 97477')).toBe('Springfield, OR');
    expect(placeLabel('1 Main St, Apt 4, Dallas, TX 75205-1234, USA')).toBe('Dallas, TX');
    expect(placeLabel('10 Downing Street, London')).toBe('London');
    expect(placeLabel('5 Elm Rd, #12, Austin, TX')).toBe('Austin, TX');
  });
  it('gives up rather than guess when there is no town to keep', () => {
    expect(placeLabel('742 Evergreen Terrace')).toBeNull();
    expect(placeLabel('')).toBeNull();
    expect(placeLabel('742 Evergreen Terrace, 97477')).toBeNull();
  });
});

describe('propertyLabels', () => {
  it('never returns the street line', () => {
    const labels = propertyLabels(['742 Evergreen Terrace, Springfield, OR 97477', 'Lake cabin']);
    expect(labels).toEqual(['Springfield, OR', 'Property 2']);
    expect(labels.join(' ')).not.toMatch(/Evergreen|Lake cabin|97477/);
  });
  it('keeps two homes in one town apart', () => {
    expect(propertyLabels(['1 A St, Dallas, TX', '2 B St, Dallas, TX', '3 C St, Plano, TX']))
      .toEqual(['Dallas, TX (property 1)', 'Dallas, TX (property 2)', 'Plano, TX']);
  });
});

describe('scrubText', () => {
  it('masks emails, phone numbers and long numbers', () => {
    expect(scrubText('Zelle payment to jane.doe@example.com')).toBe('Zelle payment to [email]');
    expect(scrubText('Zelle to 214-555-0142 rent')).toBe('Zelle to [phone] rent');
    expect(scrubText('call (214) 555-0142 or +1 214.555.0142')).toBe('call [phone] or [phone]');
    expect(scrubText('ACH DEBIT 000123456789 UTILITY')).toBe('ACH DEBIT …6789 UTILITY');
    expect(scrubText('CARD 4111111111111111')).toBe('CARD …1111');
  });
  it('leaves ordinary transaction text alone', () => {
    for (const s of ['STARBUCKS #1234', 'Overstock.com 83389515', 'CHECK 1042', 'AMZN Mktp US*2K4', 'Payment 2026-06-23 $1,234.56', 'Zelle payment to Pat Lee JPM99d1dz', ''])
      expect(scrubText(s)).toBe(s);
  });
});

describe('scrubDeep', () => {
  it('masks strings at any depth and leaves ids, numbers and structure alone', () => {
    const input = {
      id: '123456789012', totals: { taxable: 1000 },
      accounts: [{ id: 'ACT-000111222333', name: 'Checking 000123456789', balance: 5, note: null, tags: ['a@b.co', 'ok'] }],
    };
    expect(scrubDeep(input)).toEqual({
      id: '123456789012', totals: { taxable: 1000 },
      accounts: [{ id: 'ACT-000111222333', name: 'Checking …6789', balance: 5, note: null, tags: ['[email]', 'ok'] }],
    });
    expect(input.accounts[0].name).toBe('Checking 000123456789'); // not mutated
  });
});

describe('addressRedactor', () => {
  const redact = addressRedactor(['742 Evergreen Terrace, Springfield, OR 97477', 'Cabin']);
  it('replaces the full address and the street line on its own', () => {
    expect(redact('Home: 742 Evergreen Terrace, Springfield, OR 97477 (equity)')).toBe('Home: Springfield, OR (equity)');
    expect(redact('Mortgage on 742 Evergreen Terrace')).toBe('Mortgage on Springfield, OR');
    expect(redact('{"name":"742 Evergreen Terrace, Springfield, OR 97477"}')).toBe('{"name":"Springfield, OR"}');
  });
  it('ignores addresses too short to match safely', () => {
    expect(redact('Cabin fever')).toBe('Cabin fever');
  });
});
