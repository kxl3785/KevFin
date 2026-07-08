import { describe, it, expect } from 'vitest';
import { parseAdvisory } from './report.js';

describe('parseAdvisory', () => {
  const full = JSON.stringify({
    note: 'A solid quarter.\n\nStay the course.',
    marketView: ['Rates likely ease into 2027.', 'Equity leadership should broaden.'],
    taxActions: [
      { action: 'Optimize asset location', why: 'Put bonds in pre-tax accounts.' },
      { action: 'Harvest losses', why: 'Offset gains in the taxable brokerage.' },
    ],
  });

  it('parses a clean JSON object', () => {
    const a = parseAdvisory(full);
    expect(a?.note).toContain('solid quarter');
    expect(a?.marketView).toHaveLength(2);
    expect(a?.taxActions?.[0].action).toBe('Optimize asset location');
  });

  it('unwraps a ```json fenced block', () => {
    const a = parseAdvisory('Here you go:\n```json\n' + full + '\n```\nHope that helps!');
    expect(a?.marketView).toHaveLength(2);
    expect(a?.taxActions).toHaveLength(2);
  });

  it('extracts JSON embedded in surrounding prose', () => {
    const a = parseAdvisory('Sure — ' + full + ' Let me know.');
    expect(a?.note).toBeTruthy();
  });

  it('drops malformed tax-action entries and non-string bullets', () => {
    const a = parseAdvisory(JSON.stringify({
      note: 'ok',
      marketView: ['good', 42, '', '  spaced  '],
      taxActions: [{ action: 'keep', why: 'valid' }, { action: 'no why' }, 'nope'],
    }));
    expect(a?.marketView).toEqual(['good', 'spaced']);
    expect(a?.taxActions).toEqual([{ action: 'keep', why: 'valid' }]);
  });

  it('returns a note-only advisory when the other keys are absent', () => {
    const a = parseAdvisory(JSON.stringify({ note: 'just a note' }));
    expect(a).toEqual({ note: 'just a note' });
    expect(a?.marketView).toBeUndefined();
  });

  it('returns null for junk or empty content', () => {
    expect(parseAdvisory('not json at all')).toBeNull();
    expect(parseAdvisory('')).toBeNull();
    expect(parseAdvisory('{}')).toBeNull();
    expect(parseAdvisory('{ broken')).toBeNull();
  });
});
