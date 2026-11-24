import { useEffect, useRef, useState } from 'react';
import { usePersistentState } from '../../hooks/usePersistentState.ts';
import { useIsMobile } from '../../hooks/useIsMobile.ts';
import { fmtDate, fmtMoney } from '../../lib/format.ts';
import {
  CSV_FIELDS, CSV_FIELD_LABEL, assignColumn, fieldOfColumn, missingFields, savedMappingFor, rememberMapping,
  parseAmountCell, parseDateCell, SAVED_MAPPINGS_KEY, type CsvField, type CsvMapping, type ImportPreview, type ImportCommitResult,
  type PreviewRow, type RowStatus, type SavedMappings,
} from '../../lib/csvMapping.ts';

// Import a bank or budgeting-app CSV whose columns may be laid out any way:
//  1. choose the file;
//  2. match each column to what it holds (guessed from the header, or the
//     mapping remembered for files laid out like this one);
//  3. check the dry-run preview — every row labelled new, already in KevFin, or
//     needing a look — which the server computes without writing anything;
//  4. "Import N" — the only step that saves. The server re-reads the file with
//     the mapping the preview showed and imports through the same path as the
//     original CSV import (de-duplication, reconcile and categories behave
//     exactly the same).

// Same event DocImport.tsx fires after a CSV import, so the Budget page refreshes.
const BUDGET_IMPORTED_EVENT = 'kevfin:budget-imported';
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const PAGE = 100;

const STATUS_TEXT: Record<RowStatus, string> = { new: 'New', duplicate: 'Already in KevFin', review: 'Needs a look' };
const STATUS_ICON: Record<RowStatus, string> = { new: '+', duplicate: '=', review: '!' };
const STATUS_COLOR: Record<RowStatus, string> = { new: 'var(--green)', duplicate: 'var(--muted)', review: 'var(--amber)' };

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const d = await res.json().catch(() => null);
  if (!res.ok) throw new Error(d?.error ?? `Something went wrong (error ${res.status}). Try again.`);
  return d as T;
}

export default function CsvImportWizard({ onClose }: { onClose?: () => void }) {
  const isMobile = useIsMobile();
  const [privacy] = usePersistentState('mon.privacy', false);
  const [saved, setSaved] = usePersistentState<SavedMappings>(SAVED_MAPPINGS_KEY, {});

  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [mapping, setMapping] = useState<CsvMapping | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [usedSaved, setUsedSaved] = useState(false);
  const [autoHeaderless, setAutoHeaderless] = useState(false); // row 1 looked like a transaction
  const [loading, setLoading] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportCommitResult | null>(null);
  const [filter, setFilter] = useState<RowStatus | 'all'>('all');
  const [shown, setShown] = useState(PAGE);
  const fileRef = useRef<HTMLInputElement>(null);
  const reqId = useRef(0); // the newest preview request wins

  const money = (n: number) => (privacy ? '••••••' : fmtMoney(n, { cents: true }));
  // A "column name" that is really a date or an amount (a file whose first row
  // is a transaction) is hidden in privacy mode like any other amount.
  const columnName = (h: string) =>
    privacy && mapping?.hasHeader !== false && (parseAmountCell(h) != null || parseDateCell(h) != null) ? '••••' : h;

  function reset() {
    reqId.current++;
    setFile(null); setMapping(null); setPreview(null); setUsedSaved(false); setAutoHeaderless(false);
    setError(null); setResult(null); setFilter('all'); setShown(PAGE); setLoading(false);
  }

  async function runPreview(text: string, m: CsvMapping | null): Promise<ImportPreview | null> {
    const id = ++reqId.current;
    setLoading(true); setError(null);
    try {
      const p = await postJson<ImportPreview>('/api/budget/import/preview', { csv: text, mapping: m ?? undefined });
      if (id !== reqId.current) return null;
      setPreview(p);
      setMapping(p.mapping);
      setShown(PAGE);
      return p;
    } catch (e) {
      if (id === reqId.current) setError(e instanceof Error ? e.message : 'Couldn’t read that file.');
      return null;
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }

  async function chooseFile(f: File) {
    reset();
    if (f.size > MAX_FILE_BYTES) { setError('That file is over 10 MB. Split it into smaller files and import each one.'); return; }
    let text: string;
    try { text = await f.text(); } catch { setError('Couldn’t open that file. Is it a CSV?'); return; }
    if (!text.trim()) { setError('That file is empty.'); return; }
    setFile({ name: f.name, text });
    const first = await runPreview(text, null);
    if (!first) return;
    setAutoHeaderless(!first.mapping.hasHeader);
    // A file laid out like one imported before: reuse the columns chosen then.
    // (Only by its header row; a file without one has nothing to go on.)
    const remembered = savedMappingFor(saved, first.headers, first.mapping.hasHeader);
    if (remembered && JSON.stringify(remembered) !== JSON.stringify(first.mapping)) {
      const p = await runPreview(text, remembered);
      if (p) setUsedSaved(true);
    }
  }

  function changeMapping(next: CsvMapping) {
    setMapping(next);
    setResult(null);
    if (file) runPreview(file.text, next);
  }

  // The mapping on screen has been previewed: the Import button imports exactly
  // what the rows below show. False while a new preview loads, or when one
  // failed and the rows still show the columns chosen before.
  const previewed = !!preview && !!mapping && JSON.stringify(mapping) === JSON.stringify(preview.mapping);

  async function commit() {
    if (!file || !preview || !previewed) return;
    const used = preview.mapping;
    setCommitting(true); setError(null);
    try {
      const r = await postJson<ImportCommitResult>('/api/budget/import/commit', { csv: file.text, mapping: used });
      setResult(r);
      setSaved(s => rememberMapping(s, preview.headers, used));
      window.dispatchEvent(new CustomEvent(BUDGET_IMPORTED_EVENT));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The import didn’t work. Nothing was saved.');
    } finally {
      setCommitting(false);
    }
  }

  // Keep the visible page small when the filter changes.
  useEffect(() => { setShown(PAGE); }, [filter]);

  const missing = mapping ? missingFields(mapping) : [];
  const busy = loading || committing;

  // --- Step 1: choose a file -----------------------------------------------------
  // One file input for every view, always the first child of the root, so the
  // node a file dialog was opened on is still mounted when the user picks a file
  // ("Import another file" resets the view and opens the dialog in one click).
  const fileInput = (
    <input ref={fileRef} type="file" accept=".csv,.txt,text/csv" style={{ display: 'none' }} tabIndex={-1} aria-hidden="true"
      onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) chooseFile(f); }} />
  );
  const picker = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <button type="button" className={file ? 'btn-ghost btn-sm' : 'btn-primary'} onClick={() => fileRef.current?.click()}
        disabled={busy} style={file ? undefined : { fontSize: 13, padding: '7px 14px' }}>
        {file ? 'Choose a different file' : 'Choose a CSV file'}
      </button>
      {file && <span style={{ fontSize: 12.5, color: 'var(--muted)', overflowWrap: 'anywhere' }}>{file.name}</span>}
    </div>
  );

  // --- Done -------------------------------------------------------------------------
  if (result) {
    const listed = result.listedDuplicates ?? 0;
    return (
      <div>
        {fileInput}
        <div role="status">
          <p style={{ fontSize: 13.5, margin: '0 0 6px' }}>
            ✓ Added {plural(result.added, 'transaction')} to your budget.
          </p>
          <ul style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 12px', paddingLeft: 18, display: 'grid', gap: 2 }}>
            {result.duplicates > 0 && <li>{plural(result.duplicates, 'row')} already in KevFin {result.duplicates === 1 ? 'isn’t' : 'aren’t'} counted twice.</li>}
            {listed > 0 && (
              <li>
                {listed === result.duplicates ? (listed === 1 ? 'It’s' : 'They’re') : `${listed.toLocaleString('en-US')} of them ${listed === 1 ? 'is' : 'are'}`}{' '}
                still listed under Imported transactions on the Budget page, but left out of every total.
              </li>
            )}
            {result.needsLook > 0 && <li>{plural(result.needsLook, 'row')} that couldn’t be read {result.needsLook === 1 ? 'was' : 'were'} left out.</li>}
            {result.added > 0 && <li>Review the new ones on the Budget page under Imported transactions.</li>}
          </ul>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn-primary btn-sm" onClick={() => { reset(); fileRef.current?.click(); }}>Import another file</button>
          {onClose && <button type="button" className="btn-ghost btn-sm" onClick={onClose}>Done</button>}
        </div>
      </div>
    );
  }

  const rows: PreviewRow[] = preview ? preview.rows.filter(r => filter === 'all' || r.status === filter) : [];
  const counts = preview?.counts;
  const sectionTitle: React.CSSProperties = { fontSize: 13, fontWeight: 600, margin: '14px 0 6px' };

  return (
    <div>
      {fileInput}
      <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 10px' }}>
        Bring in transactions from a bank or another app. You match the columns and check every row first; nothing is saved until you press Import.
      </p>
      {picker}

      {preview && mapping && file && (
        <>
          {/* --- Step 2: match the columns --- */}
          <h4 style={sectionTitle}>Match your columns</h4>
          {usedSaved && (
            <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 6px' }}>Using the columns you chose last time for a file like this.</p>
          )}
          {/* Some banks export no header row: then row 1 is a transaction too. */}
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12.5, margin: '0 0 8px' }}>
            <input type="checkbox" checked={!mapping.hasHeader} disabled={committing}
              onChange={e => changeMapping({ ...mapping, hasHeader: !e.target.checked })} style={{ marginTop: 2 }} />
            <span>
              Row 1 is a transaction, not column names
              <span style={{ display: 'block', fontSize: 11.5, color: 'var(--muted)' }}>
                {autoHeaderless && !mapping.hasHeader
                  ? 'This file looks like it has no header row, so row 1 is imported too.'
                  : 'Tick this if the file has no header row. The columns are then numbered.'}
              </span>
            </span>
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8 }}>
            {preview.headers.map((h, col) => {
              const field = fieldOfColumn(mapping, col);
              const examples = preview.sample.map(r => (r[col] ?? '').trim()).filter(Boolean).slice(0, 2);
              const selectId = `csv-col-${col}`;
              const isRef = col === preview.refColumn;
              return (
                <div key={col} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', minWidth: 0 }}>
                  <label htmlFor={selectId} style={{ display: 'block', fontSize: 12.5, fontWeight: 600, overflowWrap: 'anywhere' }}>{columnName(h)}</label>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', margin: '2px 0 6px', overflowWrap: 'anywhere', minHeight: 15 }}>
                    {isRef ? 'Lets KevFin recognise rows it already has'
                      : examples.length ? `e.g. ${privacy ? '••••' : examples.join(' · ')}` : 'empty in the first rows'}
                  </div>
                  {/* Not disabled while a preview loads: disabling the focused
                      control would throw keyboard focus out of it. The newest
                      preview wins, and Import waits for it. */}
                  <select id={selectId} value={field ?? ''} disabled={committing}
                    onChange={e => changeMapping(assignColumn(mapping, col, (e.target.value || null) as CsvField | null))}
                    style={{ fontSize: 13, padding: '5px 7px', width: '100%' }}>
                    <option value="">Skip this column</option>
                    {CSV_FIELDS.map(f => <option key={f} value={f}>{CSV_FIELD_LABEL[f]}</option>)}
                  </select>
                </div>
              );
            })}
          </div>

          {missing.length > 0 && (
            <p role="alert" style={{ fontSize: 12.5, color: 'var(--amber)', margin: '8px 0 0' }}>
              ! Choose {missing.includes('date') ? 'which column holds the date' : ''}
              {missing.length === 2 ? ' and ' : ''}
              {missing.includes('amount') ? 'which column holds the amount (or Money in and Money out)' : ''}.
            </p>
          )}
          {mapping.account == null && missing.length === 0 && (
            <p style={{ fontSize: 12, color: 'var(--muted)', margin: '8px 0 0' }}>No account column, so these rows go to an account called “Imported”.</p>
          )}
          {mapping.notes != null && (
            <p style={{ fontSize: 12, color: 'var(--muted)', margin: '6px 0 0' }}>Notes aren’t saved with imported transactions.</p>
          )}

          {/* Day/month order, only when the file has dates like 03/04/2025. */}
          {preview.dateOrder.numericCount > 0 && (
            <fieldset style={{ border: 'none', padding: 0, margin: '12px 0 0' }}>
              <legend style={{ fontSize: 12.5, fontWeight: 600, padding: 0, marginBottom: 4 }}>How are dates written?</legend>
              {preview.dateOrder.ambiguous && (
                <p style={{ fontSize: 12, color: 'var(--amber)', margin: '0 0 6px' }}>
                  ! {preview.dateOrder.conflicting
                    ? 'This file mixes both styles. Pick the one most rows use; rows that don’t fit will need a look.'
                    : 'Every date in this file could be read either way (like 03/04). Please pick one.'}
                </p>
              )}
              <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12.5 }}>
                {(['mdy', 'dmy'] as const).map(o => (
                  <label key={o} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input type="radio" name="csv-date-order" checked={mapping.dateOrder === o} disabled={committing}
                      onChange={() => changeMapping({ ...mapping, dateOrder: o })} />
                    {o === 'mdy' ? 'Month first (03/04 = March 4)' : 'Day first (03/04 = 3 April)'}
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          {/* Sign convention: only for a single Amount column. Money in / Money
              out columns already say which way each amount goes. */}
          {mapping.amount != null && (
            <div style={{ margin: '12px 0 0' }}>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12.5 }}>
                <input type="checkbox" checked={mapping.flipSign} disabled={committing}
                  onChange={e => changeMapping({ ...mapping, flipSign: e.target.checked })} style={{ marginTop: 2 }} />
                <span>
                  Purchases are positive numbers in the Amount column
                  <span style={{ display: 'block', fontSize: 11.5, color: 'var(--muted)' }}>
                    KevFin shows money spent as negative. Tick this to flip every amount.
                  </span>
                </span>
              </label>
              {preview.sign.suggestFlip && !mapping.flipSign && (
                <p style={{ fontSize: 12, color: 'var(--amber)', margin: '6px 0 0' }}>
                  ! Most amounts in this file are positive ({preview.sign.positive} of {preview.sign.positive + preview.sign.negative}). If they’re purchases, tick the box above.
                </p>
              )}
            </div>
          )}

          {/* --- Step 3: preview --- */}
          <h4 style={sectionTitle}>Check the rows</h4>
          <details style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 8px' }}>
            <summary style={{ cursor: 'pointer' }}>How does KevFin spot duplicates?</summary>
            <p style={{ margin: '4px 0 0' }}>
              A row counts as already in KevFin when it was imported before, or when a transaction from your linked
              accounts or another import has the same amount within 3 days and the same merchant or the same card or
              account number (the last 4 digits). Repeats from the same account in one file are kept: two coffees on the
              same day are two charges. A file downloaded from KevFin is recognised row by row from its KevFin ID
              column. Some matched rows are still saved to the Imported transactions list, but they’re never counted
              twice.
            </p>
          </details>
          {counts && (
            <div role="group" aria-label="Show rows" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }} aria-busy={loading}>
              {([['all', `All ${counts.total.toLocaleString('en-US')}`], ['new', `${counts.new.toLocaleString('en-US')} new`],
                ['duplicate', `${counts.duplicate.toLocaleString('en-US')} already in KevFin`],
                ['review', `${counts.review.toLocaleString('en-US')} need a look`]] as [RowStatus | 'all', string][]).map(([k, label]) => (
                <button key={k} type="button" className="btn-ghost btn-sm" aria-pressed={filter === k} onClick={() => setFilter(k)}
                  style={filter === k ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}>
                  {k !== 'all' && <span aria-hidden="true" style={{ color: STATUS_COLOR[k], marginRight: 4 }}>{STATUS_ICON[k]}</span>}
                  {label}
                </button>
              ))}
            </div>
          )}
          {loading && <p role="status" style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 6px' }}>Updating the preview…</p>}

          <ul aria-label="Rows in this file" style={{ listStyle: 'none', margin: 0, padding: 0, border: '1px solid var(--border)', borderRadius: 8, maxHeight: 360, overflowY: 'auto', opacity: loading ? 0.6 : 1 }}>
            {rows.length === 0 && <li style={{ padding: '10px 12px', fontSize: 12.5, color: 'var(--muted)' }}>No rows to show.</li>}
            {rows.slice(0, shown).map(r => (
              <li key={r.row} style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '7px 10px', borderTop: r === rows[0] ? 'none' : '1px solid var(--border)', fontSize: 12.5 }}>
                <span title={`Row ${r.row} in a spreadsheet`} style={{ flex: 'none', width: isMobile ? 34 : 44, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>
                  <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>Row </span>{r.row}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  {r.status === 'review' ? (
                    <span style={{ color: 'var(--muted)' }}>Won’t be imported</span>
                  ) : (
                    <>
                      <span style={{ display: 'block', overflowWrap: 'anywhere' }}>{r.merchant}</span>
                      <span style={{ display: 'block', fontSize: 11.5, color: 'var(--muted)' }}>
                        {r.date ? fmtDate(r.date) : ''}{r.account && r.account !== 'Imported' ? ` · ${r.account}` : ''}{r.category ? ` · ${r.category}` : ''}
                      </span>
                    </>
                  )}
                  <span style={{ display: 'block', fontSize: 11.5, color: STATUS_COLOR[r.status] }}>
                    <span aria-hidden="true">{STATUS_ICON[r.status]} </span>{STATUS_TEXT[r.status]}{r.reason ? `: ${r.reason}` : ''}
                    {/* The unreadable cell may be an amount: hidden in privacy mode. */}
                    {r.value != null && !privacy ? ` “${r.value}”` : ''}
                  </span>
                </span>
                {r.amount != null && (
                  <span style={{ flex: 'none', fontVariantNumeric: 'tabular-nums', color: r.amount > 0 ? 'var(--green)' : 'var(--text)' }}>
                    {money(r.amount)}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {rows.length > shown && (
            <button type="button" className="btn-ghost btn-sm" style={{ marginTop: 6 }} onClick={() => setShown(s => s + PAGE)}>
              Show {Math.min(PAGE, rows.length - shown)} more of {rows.length.toLocaleString('en-US')}
            </button>
          )}

          {/* --- Step 4: import --- */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 12 }}>
            <button type="button" className="btn-primary" onClick={commit}
              disabled={busy || !previewed || missing.length > 0 || !counts || counts.new === 0}
              style={{ fontSize: 13, padding: '7px 14px' }}>
              {committing ? 'Importing…' : `Import ${plural(counts?.new ?? 0, 'transaction')}`}
            </button>
            <button type="button" className="btn-ghost btn-sm" onClick={reset} disabled={committing}>Start over</button>
            {counts && counts.new === 0 && missing.length === 0 && !loading && (
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>Nothing new to import.</span>
            )}
          </div>
        </>
      )}

      {error && <p role="alert" style={{ fontSize: 12.5, color: 'var(--red)', margin: '10px 0 0' }}>{error}</p>}
    </div>
  );
}
