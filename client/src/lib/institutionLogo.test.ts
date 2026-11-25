import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { institutionLogo, LOGO_SLUGS } from './institutionLogo.ts';

describe('institutionLogo', () => {
  it.each([
    ['Chase', 'chase'],
    ['JPMorgan Chase Bank, N.A.', 'chase'],
    ['Fidelity Investments', 'fidelity'],
    ['Vanguard', 'vanguard'],
    ['Charles Schwab', 'schwab'],
    ['Ally Bank', 'ally'],
    ['Bank of America', 'bankofamerica'],
    ['Merrill Lynch (Bank of America)', 'merrill'],
    ['Morgan Stanley', 'morganstanley'],
    ['Citibank', 'citi'],
    ['Capital One 360', 'capitalone'],
    ['American Express Card', 'amex'],
    ['U.S. Bank', 'usbank'],
    ['E*TRADE', 'etrade'],
    ['Interactive Brokers LLC', 'ibkr'],
    ['M1 Finance', 'm1'],
    ['Navy Federal Credit Union', 'navyfederal'],
    ['Bilt Rewards', 'bilt'],
    ['Frec', 'frec'],
    ['TreasuryDirect', 'treasurydirect'],
    ['Apple Card', 'apple'],
  ])('%s → %s', (name, slug) => {
    expect(institutionLogo(name)).toBe(`/institutions/${slug}.png`);
  });

  it('matches whole words only', () => {
    // "ally" inside another word, "citi" inside "Citizens", "chase" inside "purchase".
    expect(institutionLogo('Totally Bank')).toBeNull();
    expect(institutionLogo('Citizens Bank')).toBeNull();
    expect(institutionLogo('Purchase Credit Union')).toBeNull();
  });

  it('returns null for unknown or empty names', () => {
    expect(institutionLogo('Some Local Credit Union')).toBeNull();
    expect(institutionLogo('')).toBeNull();
  });

  it('has a bundled image for every slug', () => {
    for (const slug of LOGO_SLUGS) {
      const file = fileURLToPath(new URL(`../../public/institutions/${slug}.png`, import.meta.url));
      expect(existsSync(file), slug).toBe(true);
    }
  });
});
