import { describe, it, expect } from 'vitest';
import {
  assignColumn, fieldOfColumn, missingFields, savedMappingFor, rememberMapping, headerSignature,
  suggestMapping, EMPTY_MAPPING, MAX_SAVED_MAPPINGS, type CsvMapping, type SavedMappings,
} from './csvMapping.ts';

const m = (over: Partial<CsvMapping>): CsvMapping => ({ ...EMPTY_MAPPING, ...over });

describe('fieldOfColumn', () => {
  it('names the field a column feeds, or null when skipped', () => {
    const map = m({ date: 0, amount: 2 });
    expect(fieldOfColumn(map, 0)).toBe('date');
    expect(fieldOfColumn(map, 2)).toBe('amount');
    expect(fieldOfColumn(map, 1)).toBeNull();
  });
});

describe('assignColumn', () => {
  it('moves a field to a new column, releasing the old one', () => {
    expect(assignColumn(m({ date: 0 }), 3, 'date')).toEqual(m({ date: 3 }));
  });
  it('replaces whatever the column fed before', () => {
    expect(assignColumn(m({ date: 0, merchant: 1 }), 1, 'category')).toEqual(m({ date: 0, category: 1 }));
  });
  it('skips a column', () => {
    expect(assignColumn(m({ date: 0, merchant: 1 }), 1, null)).toEqual(m({ date: 0 }));
    expect(assignColumn(m({ date: 0 }), 5, null)).toEqual(m({ date: 0 }));
  });
  it('keeps Amount and Money in / out mutually exclusive', () => {
    expect(assignColumn(m({ debit: 2, credit: 3 }), 4, 'amount')).toEqual(m({ amount: 4 }));
    expect(assignColumn(m({ amount: 2 }), 3, 'credit')).toEqual(m({ credit: 3 }));
    // Money in and money out can coexist.
    expect(assignColumn(m({ credit: 3 }), 2, 'debit')).toEqual(m({ debit: 2, credit: 3 }));
  });
  it('keeps the date order and flip setting', () => {
    expect(assignColumn(m({ dateOrder: 'dmy', flipSign: true }), 0, 'date')).toEqual(m({ date: 0, dateOrder: 'dmy', flipSign: true }));
  });
  it('does not mutate its input', () => {
    const before = m({ date: 0 });
    assignColumn(before, 0, 'amount');
    expect(before).toEqual(m({ date: 0 }));
  });
});

describe('missingFields', () => {
  it('needs a date and some amount source', () => {
    expect(missingFields(EMPTY_MAPPING)).toEqual(['date', 'amount']);
    expect(missingFields(m({ date: 0 }))).toEqual(['amount']);
    expect(missingFields(m({ date: 0, debit: 1 }))).toEqual([]);
    expect(missingFields(m({ date: 0, credit: 1 }))).toEqual([]);
    expect(missingFields(m({ amount: 0 }))).toEqual(['date']);
  });
});

describe('remembered mappings', () => {
  const headers = ['Posting Date', 'Payee', 'Debit', 'Credit'];
  const mapping = m({ date: 0, merchant: 1, debit: 2, credit: 3, dateOrder: 'dmy' });

  it('round-trips by header signature (case/spacing-insensitive)', () => {
    const saved = rememberMapping({}, headers, mapping, new Date('2026-01-01T00:00:00Z'));
    expect(Object.keys(saved)).toEqual([headerSignature(headers)]);
    expect(savedMappingFor(saved, ['posting date', ' PAYEE ', 'debit', 'credit'])).toEqual(mapping);
    expect(savedMappingFor(saved, ['Date', 'Amount'])).toBeNull();
    expect(savedMappingFor({}, headers)).toBeNull();
  });
  it('drops out-of-range or malformed stored columns instead of trusting them', () => {
    const sig = headerSignature(headers);
    const saved = { [sig]: { savedAt: 'x', mapping: { date: 9, merchant: 1.5, amount: 2, debit: 2, flipSign: 'yes', dateOrder: 'nope' } } } as unknown as SavedMappings;
    expect(savedMappingFor(saved, headers)).toEqual(m({ amount: 2 }));
    expect(savedMappingFor({ [sig]: { savedAt: 'x', mapping: null } } as unknown as SavedMappings, headers)).toBeNull();
  });
  it('remembers nothing for a file without a header row, and never keys on row data (csv-ui-2, PS-2)', () => {
    // Row 1 of such a file is a transaction; its cells must not become a prefs key.
    const headerless = m({ date: 0, amount: 1, merchant: 4, hasHeader: false });
    const cols = ['Column 1', 'Column 2', 'Column 3', 'Column 4', 'Column 5'];
    const before: SavedMappings = { [headerSignature(headers)]: { mapping, savedAt: '2026-01-01T00:00:00Z' } };
    expect(rememberMapping(before, cols, headerless)).toBe(before);
    expect(rememberMapping({}, ['05/01/2026', '-12.50', '*', 'Column 4', 'COFFEE SHOP'], headerless)).toEqual({});
    // And a stored layout is never applied to a headerless file.
    expect(savedMappingFor(before, headers, false)).toBeNull();
    expect(savedMappingFor(before, headers, true)).toEqual(mapping);
  });
  it('survives malformed stored entries when pruning', () => {
    const saved: Record<string, unknown> = { junk: null, old: { mapping: EMPTY_MAPPING, savedAt: 1700000000000 } };
    for (let i = 0; i < MAX_SAVED_MAPPINGS; i++) saved[`h${i}`] = { mapping: EMPTY_MAPPING, savedAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z` };
    const next = rememberMapping(saved as SavedMappings, ['Date', 'Amount'], m({ date: 0, amount: 1 }), new Date('2026-02-01T00:00:00Z'));
    expect(Object.keys(next).length).toBe(MAX_SAVED_MAPPINGS);
    expect(next.junk).toBeUndefined();
    expect(next[headerSignature(['Date', 'Amount'])]).toBeDefined();
  });
  it('keeps only the most recent layouts', () => {
    let saved: SavedMappings = {};
    for (let i = 0; i < MAX_SAVED_MAPPINGS + 3; i++) {
      saved = rememberMapping(saved, [`col${i}`], m({ date: 0 }), new Date(Date.UTC(2026, 0, 1, 0, i)));
    }
    expect(Object.keys(saved).length).toBe(MAX_SAVED_MAPPINGS);
    expect(saved[headerSignature(['col0'])]).toBeUndefined();
    expect(saved[headerSignature([`col${MAX_SAVED_MAPPINGS + 2}`])]).toBeDefined();
  });
});

describe('shared reader is reachable from the client', () => {
  it('suggests a mapping', () => {
    expect(suggestMapping(['Date', 'Amount'])).toMatchObject({ date: 0, amount: 1 });
  });
});
