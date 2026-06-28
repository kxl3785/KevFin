import { useState, useRef, useEffect } from 'react';
import { writePersistent } from '../hooks/usePersistentState.ts';
import { useClaudeAuth, ClaudeLoginPrompt, prefetchClaudeAuth, getClaudeAuth, reportLoggedIn, reportLoggedOut } from './ClaudeLoginGate.tsx';

// Cross-component signal: dispatch this with `{ file }` to hand a dropped file to
// the (always-mounted) importer — used by the AI assistant's drag-and-drop.
export const IMPORT_FILE_EVENT = 'kevfin:import-file';

// Fired after a transaction CSV is imported here, so the Budget page (if mounted)
// can refresh its data and surface the new "Imported transactions" review queue.
export const BUDGET_IMPORTED_EVENT = 'kevfin:budget-imported';

function isCsvFile(file: File): boolean {
  return /\.csv$/i.test(file.name) || file.type === 'text/csv';
}

// A transaction CSV (e.g. a Monarch export) goes to the deterministic bulk
// transaction importer; everything else — including a CSV that ISN'T a
// transaction list — falls through to the AI document-ingest flow. We decide by
// sniffing the header row for the columns that importer actually needs (a date
// and an amount), mirroring the server's own detection in importTransactions().
function looksLikeTransactionsCsv(text: string): boolean {
  const firstLine = text.split(/\r?\n/).find(l => l.trim() !== '');
  if (!firstLine) return false;
  const cols = firstLine.split(',').map(c => c.trim().replace(/^"|"$/g, '').toLowerCase());
  const hasDate = cols.some(c => c === 'date' || c === 'posted date' || c === 'transaction date');
  const hasAmount = cols.includes('amount');
  return hasDate && hasAmount;
}

// localStorage key the Forecast page watches for planning inputs to apply. The
// importer writes to it; the Forecast page reads it (see usePersistentState).
const FORECAST_PENDING_KEY = 'mon.fcPendingImport';

// A single proposed entry returned by the document-import endpoint. Most go to a
// database table; "forecast" entries instead populate the Forecast page's local
// settings. Fields are kept loose (re-validated on commit) so the user can freely
// edit any value before confirming.
interface Proposal {
  table: 'manual_assets' | 'imported_txns' | 'properties' | 'accounts' | 'cost_basis' | 'forecast';
  summary: string;
  confidence: number;
  fields: Record<string, unknown>;
  include: boolean; // user can uncheck an entry to skip it
}

// In-flight state for an uploaded document, from "reading" through "review".
type Ingest =
  | { status: 'reading'; filename: string }
  | { status: 'review' | 'saving'; filename: string; docType: string; notes: string; proposals: Proposal[] };

const TABLE_LABEL: Record<Proposal['table'], string> = {
  manual_assets: 'Manual asset',
  imported_txns: 'Transaction',
  properties: 'Property',
  accounts: 'Account',
  cost_basis: 'Cost basis',
  forecast: 'Forecast input',
};

interface FieldSpec { key: string; label: string; type: 'text' | 'number' | 'select'; options?: string[] }
const ACCT_CATS = ['banking', 'brokerage', 'credit', 'other'];
const FIELD_SPEC: Record<Proposal['table'], FieldSpec[]> = {
  manual_assets: [
    { key: 'name', label: 'Name', type: 'text' },
    { key: 'value', label: 'Value', type: 'number' },
    { key: 'category', label: 'Category', type: 'select', options: ACCT_CATS },
  ],
  imported_txns: [
    { key: 'date', label: 'Date', type: 'text' },
    { key: 'payee', label: 'Payee', type: 'text' },
    { key: 'amount', label: 'Amount', type: 'number' },
    { key: 'category', label: 'Category', type: 'text' },
  ],
  properties: [
    { key: 'address', label: 'Address', type: 'text' },
    { key: 'value', label: 'Value', type: 'number' },
    { key: 'mortgage_balance', label: 'Mortgage', type: 'number' },
  ],
  accounts: [
    { key: 'org_name', label: 'Institution', type: 'text' },
    { key: 'name', label: 'Account', type: 'text' },
    { key: 'balance', label: 'Balance', type: 'number' },
    { key: 'category', label: 'Category', type: 'select', options: ACCT_CATS },
  ],
  cost_basis: [
    { key: 'symbol', label: 'Symbol', type: 'text' },
    { key: 'name', label: 'Name', type: 'text' },
    { key: 'costBasis', label: 'Cost basis', type: 'number' },
  ],
  forecast: [
    { key: 'annualIncome', label: 'Your income / yr', type: 'number' },
    { key: 'spouseIncome', label: 'Spouse income / yr', type: 'number' },
    { key: 'effTaxRate', label: 'Effective tax rate %', type: 'number' },
    { key: 'filingStatus', label: 'Filing status', type: 'select', options: ['single', 'married', 'head_of_household', 'other'] },
    { key: 'dependents', label: 'Dependents (kids)', type: 'number' },
  ],
};

const ACCEPT = '.pdf,.png,.jpg,.jpeg,.gif,.webp,.csv,.txt,.md,.json,application/pdf,image/*';

// Read a File as base64 (without the data-URL prefix) for JSON upload.
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const r = reader.result as string;
      resolve(r.slice(r.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.readAsDataURL(file);
  });
}

function summarizeCommit(byTable: Record<string, number>): string {
  return Object.entries(byTable)
    .map(([t, n]) => `${n} ${TABLE_LABEL[t as Proposal['table']]?.toLowerCase() ?? t}${n === 1 ? '' : 's'}`)
    .join(', ');
}

// Import-into-tray icon (arrow points down into the tray) — reads as bringing data
// in, not sending it out. Matches the line-icon style of the other TopNav actions.
function ImportIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M12 18v-6" />
      <path d="M9 15l3-3 3 3" />
    </svg>
  );
}

/**
 * A compact upload icon button (sits in the TopNav alongside the other actions,
 * so it appears identically on every page) that opens a modal for importing a
 * financial document. The server reads the file, proposes entries to review and
 * edit, then deletes it — nothing is stored until the user confirms.
 */
export default function DocImport() {
  const [open, setOpen] = useState(false);
  const [ingest, setIngest] = useState<Ingest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null); // success summary after a commit
  const [dragging, setDragging] = useState(false); // a file is being dragged over the modal
  const fileRef = useRef<HTMLInputElement>(null);

  // Check Claude login as soon as the modal opens, so we present a login prompt
  // up front instead of letting an upload fail.
  const { status: auth, command: authCommand, recheck } = useClaudeAuth(open);

  const busy = ingest?.status === 'reading' || ingest?.status === 'saving';

  function reset() { setIngest(null); setError(null); setDone(null); }
  function close() { if (!busy) { setOpen(false); reset(); setDragging(false); } }

  // Close on Escape while the modal is open (but not mid-request).
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape' && !busy) close(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy]);

  // A file dropped elsewhere (e.g. on the AI assistant) is handed here via an
  // event, so the full review/commit flow lives in one place. A ref keeps the
  // handler current without re-subscribing on every render.
  const openWithFile = useRef<(f: File) => void>(() => {});
  openWithFile.current = (file: File) => {
    if (busy) return;
    setOpen(true);
    reset();
    setDragging(false);
    handleFile(file);
  };

  // Route a chosen file: a CSV that looks like a transaction list goes to the bulk
  // budget importer; any other CSV (or non-CSV) goes to the AI document-ingest
  // flow. We read the CSV once here to sniff its header, then hand the text on so
  // it isn't read twice. We deliberately don't set a "reading" state during the
  // sniff — that would make uploadDoc's busy-guard bail on the AI path.
  async function handleFile(file: File) {
    if (isCsvFile(file)) {
      let text: string;
      try { text = await file.text(); }
      catch { uploadDoc(file); return; } // unreadable as text → let the AI path try
      if (looksLikeTransactionsCsv(text)) importBudgetCsv(file, text);
      else uploadDoc(file);
      return;
    }
    uploadDoc(file);
  }

  // Bulk-import a transaction CSV (e.g. Monarch) into the Budget's review queue,
  // reconciling against the bank feed. No AI or Claude login involved.
  async function importBudgetCsv(file: File, csvText?: string) {
    if (busy) return;
    setError(null);
    setDone(null);
    setIngest({ status: 'reading', filename: file.name });
    try {
      const csv = csvText ?? await file.text();
      const res = await fetch('/api/budget/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.error ?? `Import failed (HTTP ${res.status})`);
      setIngest(null);
      const n = d.imported ?? 0;
      const recon = d.reconciled ? ` · ${d.reconciled} reconciled against your bank data` : '';
      setDone(`${n} transaction${n === 1 ? '' : 's'} to your budget${recon} — review them on the Budget page`);
      window.dispatchEvent(new CustomEvent(BUDGET_IMPORTED_EVENT));
    } catch (e) {
      setIngest(null);
      setError(e instanceof Error ? e.message : 'Could not import that CSV.');
    }
  }
  useEffect(() => {
    function onImportFile(e: Event) {
      const file = (e as CustomEvent<{ file?: File }>).detail?.file;
      if (file) openWithFile.current(file);
    }
    window.addEventListener(IMPORT_FILE_EVENT, onImportFile);
    return () => window.removeEventListener(IMPORT_FILE_EVENT, onImportFile);
  }, []);

  // Upload a document: the server reads it, proposes entries, and deletes the
  // file. Nothing is written to the database until the user confirms.
  async function uploadDoc(file: File) {
    if (busy) return;
    // Verify login before reading anything — await the (background) re-check, then
    // show the login gate instead of attempting an upload if it came back logged out.
    await prefetchClaudeAuth();
    if (getClaudeAuth() === 'logged_out' || getClaudeAuth() === 'no_binary') { setOpen(true); setIngest(null); return; }
    setError(null);
    setDone(null);
    setIngest({ status: 'reading', filename: file.name });
    try {
      const dataBase64 = await fileToBase64(file);
      const res = await fetch('/api/assistant/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, dataBase64 }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        // A not-logged-in response carries the login command: show the gate,
        // driven by this real outcome, rather than a one-off error.
        if (typeof data?.command === 'string') { setIngest(null); reportLoggedOut(data.command); return; }
        throw new Error(data?.error ?? `Upload failed (HTTP ${res.status})`);
      }
      reportLoggedIn(); // a clean read proves we're authenticated
      const proposals: Proposal[] = (data.proposals ?? []).map((p: Proposal) => ({ ...p, include: true }));
      setIngest({ status: 'review', filename: file.name, docType: data.docType ?? 'document', notes: data.notes ?? '', proposals });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed.');
      setIngest(null);
    }
  }

  function setFieldValue(idx: number, key: string, value: string) {
    setIngest(prev => {
      if (!prev || prev.status === 'reading') return prev;
      const proposals = prev.proposals.map((p, i) => i === idx ? { ...p, fields: { ...p.fields, [key]: value } } : p);
      return { ...prev, proposals };
    });
  }

  function toggleInclude(idx: number) {
    setIngest(prev => {
      if (!prev || prev.status === 'reading') return prev;
      const proposals = prev.proposals.map((p, i) => i === idx ? { ...p, include: !p.include } : p);
      return { ...prev, proposals };
    });
  }

  async function commitIngest() {
    if (!ingest || ingest.status !== 'review') return;
    const chosen = ingest.proposals.filter(p => p.include);
    if (!chosen.length) { reset(); return; }
    // Forecast inputs are applied to the Forecast page's local settings; the rest
    // are written to the database via the server.
    const forecastChosen = chosen.filter(p => p.table === 'forecast');
    const dbChosen = chosen.filter(p => p.table !== 'forecast');
    setError(null);
    setIngest({ ...ingest, status: 'saving' });
    try {
      if (forecastChosen.length) applyForecast(forecastChosen);

      let dbSummary = '';
      if (dbChosen.length) {
        const res = await fetch('/api/assistant/ingest/commit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ proposals: dbChosen.map(({ include, ...p }) => { void include; return p; }) }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.error ?? 'Could not save those entries.');
        dbSummary = data.byTable ? summarizeCommit(data.byTable) : `${data.inserted} entries`;
      }

      const parts = [dbSummary, forecastChosen.length ? 'forecast inputs' : ''].filter(Boolean);
      setDone(parts.join(' · ') || 'your changes');
      setIngest(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save those entries.');
      setIngest({ ...ingest, status: 'review' });
    }
  }

  // Push reviewed tax-return / planning inputs into the Forecast page's settings.
  // Multiple forecast entries are merged (last non-empty value wins per field).
  function applyForecast(items: Proposal[]) {
    const toNum = (v: unknown): number | null => {
      const n = typeof v === 'string' ? Number(v.replace(/[$,%\s]/g, '')) : v;
      return typeof n === 'number' && Number.isFinite(n) ? n : null;
    };
    const fields: { annualIncome?: number; spouseIncome?: number; effTaxRate?: number; filingStatus?: string; dependents?: number } = {};
    for (const p of items) {
      const income = toNum(p.fields.annualIncome);
      const spouse = toNum(p.fields.spouseIncome);
      const eff = toNum(p.fields.effTaxRate);
      const deps = toNum(p.fields.dependents);
      const fs = typeof p.fields.filingStatus === 'string' ? p.fields.filingStatus.trim() : '';
      if (income != null) fields.annualIncome = income;
      if (spouse != null) fields.spouseIncome = spouse;
      if (eff != null) fields.effTaxRate = eff;
      if (deps != null) fields.dependents = Math.max(0, Math.round(deps));
      if (fs) fields.filingStatus = fs;
    }
    if (Object.keys(fields).length) {
      writePersistent(FORECAST_PENDING_KEY, { fields, at: Date.now() });
    }
  }

  const reviewing = ingest && ingest.status !== 'reading';
  const includedCount = reviewing ? ingest.proposals.filter(p => p.include).length : 0;

  return (
    <>
      <button
        className="btn-icon"
        onClick={() => { void prefetchClaudeAuth(); setOpen(true); }}
        title="Import a financial document"
        aria-label="Import a financial document"
      >
        <ImportIcon />
      </button>

      {open && (
        <div
          onClick={close}
          style={{
            position: 'fixed', inset: 0, zIndex: 3000,
            background: 'rgba(0,0,0,0.55)', display: 'flex',
            alignItems: 'flex-start', justifyContent: 'center',
            padding: '8vh 16px 16px', overflowY: 'auto',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            onDragOver={e => { if (busy) return; e.preventDefault(); if (!dragging) setDragging(true); }}
            onDragLeave={e => { if (e.currentTarget === e.target) setDragging(false); }}
            onDrop={e => {
              e.preventDefault();
              setDragging(false);
              if (busy) return;
              const file = e.dataTransfer.files?.[0];
              if (file) handleFile(file);
            }}
            style={{
              position: 'relative',
              width: '100%', maxWidth: 560,
              background: 'var(--surface)',
              border: `1px solid ${dragging ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: 14, boxShadow: '0 16px 48px rgba(0,0,0,0.55)',
              padding: 24,
            }}
          >
            {dragging && (
              <div style={{
                position: 'absolute', inset: 0, zIndex: 2, borderRadius: 14,
                background: 'var(--accent-dim)', border: '2px dashed var(--accent)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: 'var(--accent)', fontSize: 15, fontWeight: 600, pointerEvents: 'none',
              }}>
                Drop to import
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 4 }}>
              <h2 style={{ fontSize: 18, fontWeight: 700 }}>Import a document</h2>
              <button
                onClick={close}
                disabled={busy}
                aria-label="Close"
                style={{ background: 'transparent', color: 'var(--muted)', fontSize: 22, lineHeight: 1, padding: 0, cursor: busy ? 'default' : 'pointer' }}
              >×</button>
            </div>
            <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 18 }}>
              Drop in a statement, receipt, or tax return — it’s read into proposed entries you review and edit, then the file is deleted (a tax return fills in your Forecast income &amp; tax rate). A transactions CSV (e.g. a Monarch export) is bulk-imported into your Budget for review instead.
            </p>

            <input
              ref={fileRef}
              type="file"
              accept={ACCEPT}
              style={{ display: 'none' }}
              onChange={e => {
                const file = e.target.files?.[0];
                e.target.value = ''; // allow re-uploading the same file
                if (file) handleFile(file);
              }}
            />

            {/* Login gate — replaces the picker only when the background check has
                found Claude logged out (or missing). */}
            {!ingest && !done && (auth === 'logged_out' || auth === 'no_binary') && (
              <div style={{ padding: '4px 0 4px' }}>
                <ClaudeLoginPrompt command={authCommand} noBinary={auth === 'no_binary'} onRecheck={recheck} />
              </div>
            )}

            {/* Idle / picker — shown immediately on the optimistic 'ok' state */}
            {!ingest && !done && auth === 'ok' && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '20px 0', border: '1px dashed var(--border)', borderRadius: 12 }}>
                <span style={{ width: 28, height: 28, color: 'var(--muted)' }}><ImportIcon /></span>
                <button className="btn-primary" onClick={() => fileRef.current?.click()} style={{ padding: '8px 16px' }}>
                  Choose a file
                </button>
                <p style={{ fontSize: 11.5, color: 'var(--muted)' }}>Drag &amp; drop or choose — PDF, image, CSV, or text, up to 12 MB</p>
              </div>
            )}

            {/* Reading */}
            {ingest?.status === 'reading' && (
              <div style={{ fontSize: 13.5, color: 'var(--muted)', padding: '20px 0', textAlign: 'center' }}>
                Reading “{ingest.filename}”…
              </div>
            )}

            {/* Review */}
            {reviewing && (
              <div>
                <p style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>
                  {ingest.proposals.length > 0 ? 'Proposed entries' : 'Nothing to add'}
                </p>
                <p style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 12 }}>
                  From “{ingest.filename}” ({ingest.docType}). Review and edit before saving.
                </p>
                {ingest.notes && (
                  <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>{ingest.notes}</p>
                )}

                {ingest.proposals.length === 0 && (
                  <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 12 }}>
                    I couldn’t find financial data to turn into an entry in that document.
                  </p>
                )}

                {ingest.proposals.map((p, i) => (
                  <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12, marginBottom: 10, opacity: p.include ? 1 : 0.5 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, cursor: 'pointer' }}>
                      <input type="checkbox" checked={p.include} onChange={() => toggleInclude(i)} disabled={ingest.status === 'saving'} />
                      <span style={{ fontWeight: 600, fontSize: 12.5 }}>{TABLE_LABEL[p.table]}</span>
                      <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 'auto' }}>
                        {Math.round((p.confidence ?? 0) * 100)}% sure
                      </span>
                    </label>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                      {FIELD_SPEC[p.table].map(spec => (
                        <label key={spec.key} style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11, color: 'var(--muted)' }}>
                          {spec.label}
                          {spec.type === 'select' ? (
                            <select
                              value={String(p.fields[spec.key] ?? '')}
                              onChange={e => setFieldValue(i, spec.key, e.target.value)}
                              disabled={ingest.status === 'saving'}
                              style={{ fontSize: 13, padding: '5px 7px' }}
                            >
                              {spec.options!.map(o => <option key={o} value={o}>{o}</option>)}
                            </select>
                          ) : (
                            <input
                              type={spec.type === 'number' ? 'number' : 'text'}
                              value={String(p.fields[spec.key] ?? '')}
                              onChange={e => setFieldValue(i, spec.key, e.target.value)}
                              disabled={ingest.status === 'saving'}
                              style={{ fontSize: 13, padding: '5px 7px' }}
                            />
                          )}
                        </label>
                      ))}
                    </div>
                  </div>
                ))}

                <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                  {includedCount > 0 && (
                    <button className="btn-primary" onClick={commitIngest} disabled={ingest.status === 'saving'} style={{ padding: '8px 14px' }}>
                      {ingest.status === 'saving' ? 'Saving…' : `Add ${includedCount} ${includedCount === 1 ? 'entry' : 'entries'}`}
                    </button>
                  )}
                  <button className="btn-ghost" onClick={reset} disabled={ingest.status === 'saving'} style={{ padding: '8px 14px' }}>
                    Discard
                  </button>
                </div>
              </div>
            )}

            {/* Success */}
            {done && (
              <div style={{ padding: '12px 0' }}>
                <p style={{ fontSize: 14, marginBottom: 14 }}>
                  ✅ Added {done}. The uploaded file was processed and deleted.
                  {done.includes('forecast') && ' Imported values are highlighted on the Forecast page.'}
                </p>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn-primary" onClick={() => { reset(); fileRef.current?.click(); }} style={{ padding: '8px 14px' }}>
                    Import another
                  </button>
                  <button className="btn-ghost" onClick={close} style={{ padding: '8px 14px' }}>Done</button>
                </div>
              </div>
            )}

            {error && (
              <div style={{ fontSize: 12.5, color: 'var(--red)', marginTop: 12 }}>{error}</div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
