import { describe, it, expect } from 'vitest';
import { extractZip } from './zhvi.js';

describe('extractZip', () => {
  it('reads a ZIP after the state', () => {
    expect(extractZip('2441 Worthington St, Austin, TX 78701')).toBe('78701');
    expect(extractZip('2441 Worthington St, Austin, TX 78701-1234, USA')).toBe('78701');
    expect(extractZip('1 Elm St Austin TX 78701')).toBe('78701');
  });

  it('reads a trailing or comma-separated ZIP', () => {
    expect(extractZip('1 Elm St, 90210')).toBe('90210');
    expect(extractZip('1 Elm St 90210')).toBe('90210');
  });

  it('does not mistake a 5-digit street number for a ZIP', () => {
    expect(extractZip('12345 Main St')).toBeNull();
    expect(extractZip('12345 Main St, Austin, TX')).toBeNull();
    expect(extractZip('12345 Main St, Austin')).toBeNull();
  });

  it('prefers the real ZIP over a 5-digit street number', () => {
    expect(extractZip('12345 Main St, Austin, TX 78701')).toBe('78701');
  });
});
