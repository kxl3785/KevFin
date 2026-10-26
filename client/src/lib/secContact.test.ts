import { describe, expect, it } from 'vitest';
import { isPlausibleEmail } from './secContact.ts';

describe('isPlausibleEmail', () => {
  it('accepts ordinary addresses (surrounding spaces are trimmed)', () => {
    expect(isPlausibleEmail('me@example.com')).toBe(true);
    expect(isPlausibleEmail('  first.last+sec@mail.example.co.uk ')).toBe(true);
  });
  it('rejects junk and anything that could break a header or env line', () => {
    for (const bad of ['', 'me', 'me@host', '@example.com', 'a b@example.com', 'a@b.com\nX=1', 'a@b.com, c@d.com', '<a@b.com>']) {
      expect(isPlausibleEmail(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});
