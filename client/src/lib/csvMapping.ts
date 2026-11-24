// Client side of the CSV column matching. The reading itself (header synonyms,
// date order, amount parsing) lives in the shared module so the server's preview
// and commit use the very same code; this file adds what only the import screen
// needs: assigning a field to a column from a per-column picker, and remembering
// the last mapping per file layout (stored in the prefs store, keyed by the
// header signature — column names only, never any row data; a file without a
// header row has no column names, so nothing is remembered for it).
import {
  CSV_FIELDS, CSV_FIELD_LABEL, EMPTY_MAPPING, headerSignature,
  type CsvField, type CsvMapping,
} from '@shared/csvMapping';

export {
  CSV_FIELDS, CSV_FIELD_LABEL, EMPTY_MAPPING, headerSignature,
  parseCsvText, suggestMapping, parseAmountCell, parseDateCell, detectDateOrder,
} from '@shared/csvMapping';
export type { CsvField, CsvMapping, DateOrder, ImportPreview, PreviewRow, RowStatus, ImportCommitResult } from '@shared/csvMapping';

/** The field a column currently feeds, or null when it's skipped. */
export function fieldOfColumn(m: CsvMapping, col: number): CsvField | null {
  return CSV_FIELDS.find(f => m[f] === col) ?? null;
}

/**
 * Point `field` at column `col` (or skip the column with field = null). One
 * column feeds one field and one field reads one column, so any other column
 * holding `field` is released, and whatever `col` held before is unset. An
 * Amount column and Money in / out columns are alternatives: choosing one kind
 * clears the other.
 */
export function assignColumn(m: CsvMapping, col: number, field: CsvField | null): CsvMapping {
  const next: CsvMapping = { ...m };
  for (const f of CSV_FIELDS) if (next[f] === col) next[f] = null;
  if (field == null) return next;
  next[field] = col;
  if (field === 'amount') { next.debit = null; next.credit = null; }
  if (field === 'debit' || field === 'credit') next.amount = null;
  return next;
}

/** What a mapping still lacks before anything can be imported. */
export function missingFields(m: CsvMapping): ('date' | 'amount')[] {
  const out: ('date' | 'amount')[] = [];
  if (m.date == null) out.push('date');
  if (m.amount == null && m.debit == null && m.credit == null) out.push('amount');
  return out;
}

// --- Remembered mappings -----------------------------------------------------------

export const SAVED_MAPPINGS_KEY = 'mon.csvImportMappings';
export const MAX_SAVED_MAPPINGS = 20;

export interface SavedMapping { mapping: CsvMapping; savedAt: string }
export type SavedMappings = Record<string, SavedMapping>;

/**
 * A stored mapping that still fits this file, or null. `hasHeader` is whether
 * `headers` are the file's own column names; for a headerless file they're just
 * Column 1, Column 2, … and say nothing about its layout.
 */
export function savedMappingFor(saved: SavedMappings, headers: string[], hasHeader = true): CsvMapping | null {
  if (!hasHeader) return null;
  const hit = saved[headerSignature(headers)];
  if (!hit || !hit.mapping || typeof hit.mapping !== 'object') return null;
  const m: CsvMapping = { ...EMPTY_MAPPING };
  for (const f of CSV_FIELDS) {
    const v = (hit.mapping as Partial<CsvMapping>)[f];
    m[f] = typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < headers.length ? v : null;
  }
  m.dateOrder = hit.mapping.dateOrder === 'dmy' ? 'dmy' : 'mdy';
  m.flipSign = hit.mapping.flipSign === true;
  m.hasHeader = true;
  if (m.amount != null) { m.debit = null; m.credit = null; }
  return m;
}

/**
 * Store `mapping` for this layout, keeping only the most recent layouts. A
 * mapping for a file without a header row is not stored: its first row is a
 * transaction, and the key must never hold row data.
 */
export function rememberMapping(saved: SavedMappings, headers: string[], mapping: CsvMapping, now: Date = new Date()): SavedMappings {
  if (mapping.hasHeader === false) return saved;
  const next: SavedMappings = { ...saved, [headerSignature(headers)]: { mapping, savedAt: now.toISOString() } };
  const keys = Object.keys(next);
  if (keys.length <= MAX_SAVED_MAPPINGS) return next;
  // Stored values come back from the prefs store unchecked: a malformed entry
  // sorts as oldest rather than throwing.
  const at = (k: string) => { const v = (next[k] as Partial<SavedMapping> | null)?.savedAt; return typeof v === 'string' ? v : ''; };
  keys.sort((a, b) => at(b).localeCompare(at(a)));
  return Object.fromEntries(keys.slice(0, MAX_SAVED_MAPPINGS).map(k => [k, next[k]]));
}
