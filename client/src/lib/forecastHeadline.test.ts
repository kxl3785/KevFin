import { describe, it, expect } from 'vitest';
import { successStatus } from './forecastHeadline.ts';

describe('the first tile\'s word (successStatus)', () => {
  it('speaks of likelihood, never "on track", on the colour\'s bands', () => {
    expect([100, 90].map(successStatus)).toEqual(['Likely', 'Likely']);
    expect([89, 70].map(successStatus)).toEqual(['Uncertain', 'Uncertain']);
    expect([69, 0, NaN].map(successStatus)).toEqual(['At risk', 'At risk', 'At risk']);
    for (let p = 0; p <= 100; p++) expect(successStatus(p).toLowerCase()).not.toContain('track');
  });
});
