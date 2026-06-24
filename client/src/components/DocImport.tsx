import { useState, useRef, useEffect } from 'react';

// A single proposed database entry returned by the document-import endpoint.
// Fields are kept loose (the server re-validates on commit) so the user can
// freely edit any value before confirming.
interface Proposal {
  table: 'manual_assets' | 'imported_txns' | 'properties' | 'accounts';
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

// Upload-tray icon, matching the line-icon style of the other TopNav actions.
function UploadIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
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
  const fileRef = useRef<HTMLInputElement>(null);

  const busy = ingest?.status === 'reading' || ingest?.status === 'saving';

  function reset() { setIngest(null); setError(null); setDone(null); }
  function close() { if (!busy) { setOpen(false); reset(); } }

  // Close on Escape while the modal is open (but not mid-request).
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape' && !busy) close(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy]);

  // Upload a document: the server reads it, proposes entries, and deletes the
  // file. Nothing is written to the database until the user confirms.
  async function uploadDoc(file: File) {
    if (busy) return;
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
      if (!res.ok) throw new Error(data?.error ?? `Upload failed (HTTP ${res.status})`);
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
    setError(null);
    setIngest({ ...ingest, status: 'saving' });
    try {
      const res = await fetch('/api/assistant/ingest/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proposals: chosen.map(({ include, ...p }) => { void include; return p; }) }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? 'Could not save those entries.');
      setDone(data.byTable ? summarizeCommit(data.byTable) : `${data.inserted} entries`);
      setIngest(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save those entries.');
      setIngest({ ...ingest, status: 'review' });
    }
  }

  const reviewing = ingest && ingest.status !== 'reading';
  const includedCount = reviewing ? ingest.proposals.filter(p => p.include).length : 0;

  return (
    <>
      <button
        className="btn-icon"
        onClick={() => setOpen(true)}
        title="Import a financial document"
        aria-label="Import a financial document"
      >
        <UploadIcon />
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
            style={{
              width: '100%', maxWidth: 560,
              background: 'var(--surface)', border: '1px solid var(--border)',
              borderRadius: 14, boxShadow: '0 16px 48px rgba(0,0,0,0.55)',
              padding: 24,
            }}
          >
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
              Upload a statement, receipt, or CSV. It’s read into proposed entries you review and edit, then the file is deleted — nothing is stored until you confirm.
            </p>

            <input
              ref={fileRef}
              type="file"
              accept={ACCEPT}
              style={{ display: 'none' }}
              onChange={e => {
                const file = e.target.files?.[0];
                e.target.value = ''; // allow re-uploading the same file
                if (file) uploadDoc(file);
              }}
            />

            {/* Idle / picker */}
            {!ingest && !done && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '20px 0', border: '1px dashed var(--border)', borderRadius: 12 }}>
                <span style={{ width: 28, height: 28, color: 'var(--muted)' }}><UploadIcon /></span>
                <button className="btn-primary" onClick={() => fileRef.current?.click()} style={{ padding: '8px 16px' }}>
                  Choose a file
                </button>
                <p style={{ fontSize: 11.5, color: 'var(--muted)' }}>PDF, image, CSV, or text — up to 12 MB</p>
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
                <p style={{ fontSize: 14, marginBottom: 14 }}>✅ Added {done}. The document was processed and deleted — nothing was stored.</p>
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
