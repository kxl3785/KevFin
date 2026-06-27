import { useEffect, useRef, useState } from 'react';
import { useApi } from '../hooks/useApi.ts';
import { SHOW_WELCOME_EVENT } from './Welcome.tsx';

// Other parts of the app (the dashboard's data hooks) listen for this so they
// re-pull after Setup changes something — no full page reload needed.
export const DATA_CHANGED_EVENT = 'kevfin:data-changed';
function broadcastDataChanged() { window.dispatchEvent(new Event(DATA_CHANGED_EVENT)); }

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  );
}

const sectionTitle: React.CSSProperties = { fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--muted)', marginBottom: 6 };

const keyInput: React.CSSProperties = { fontSize: 13, padding: '6px 8px', width: '100%' };

// Consistent section block: an uppercase title with a divider above it (except
// the first), so every section in the menu shares the same rhythm.
function Section({ title, first, children }: { title: string; first?: boolean; children: React.ReactNode }) {
  return (
    <div style={{ paddingTop: first ? 0 : 14, marginTop: first ? 0 : 14, borderTop: first ? undefined : '1px solid var(--border)' }}>
      <p style={sectionTitle}>{title}</p>
      {children}
    </div>
  );
}

// Export a password-protected, point-in-time snapshot of everything as a single
// self-contained HTML file. The password is sent once to encrypt the payload
// server-side (AES-GCM); it is never stored. The downloaded file decrypts and
// renders entirely in the recipient's browser — works offline, no server.
function ExportSection() {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [expiry, setExpiry] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // Minimum expiry is tomorrow; blank = never expires.
  const minExpiry = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);

  async function run() {
    setError(null);
    if (password.length < 4) { setError('Use a password of at least 4 characters.'); return; }
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    if (expiry && expiry < minExpiry) { setError('Expiry must be a future date.'); return; }
    setBusy(true);
    try {
      const res = await fetch('/api/export/snapshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, expiresAt: expiry || undefined }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        throw new Error(d?.error ?? `Export failed (HTTP ${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `kevfin-snapshot-${new Date().toISOString().slice(0, 10)}.html`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setPassword(''); setConfirm(''); setExpiry('');
      setDone(true);
      setTimeout(() => setDone(false), 4000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not export the snapshot.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Export encrypted snapshot">
      <p style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 10 }}>
        A password-protected HTML file of all data — opens offline; the recipient needs the password.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)}
            placeholder="Password" style={keyInput} autoComplete="new-password" />
          <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)}
            placeholder="Confirm password" style={keyInput} autoComplete="new-password" />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--muted)' }}
            title="Optional expiry — a courtesy limit, not strongly enforced">
            <span>Expires</span>
            <input type="date" value={expiry} min={minExpiry} onChange={e => setExpiry(e.target.value)}
              style={{ ...keyInput, width: 'auto' }} />
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {done && <span style={{ fontSize: 12.5, color: 'var(--green)' }}>Downloaded.</span>}
            <button className="btn-primary" onClick={run} disabled={busy} style={{ fontSize: 13, padding: '7px 14px' }}>
              {busy ? 'Generating…' : '↓ Export snapshot'}
            </button>
          </div>
        </div>
        {error && <p style={{ fontSize: 12.5, color: 'var(--red)', margin: 0 }}>{error}</p>}
      </div>
    </Section>
  );
}

interface SystemStatus {
  dbPath: string;
  version: string;
  dailySnapshotEnabled: boolean;
  lastSync: { accounts: string | null; realEstate: string | null; snapshot: string | null };
  counts: { accounts: number; properties: number; manualAssets: number; snapshots: number; importedTxns: number; connections: number };
}

function relTime(iso: string | null): string {
  if (!iso) return 'never';
  const t = new Date(iso.includes('T') || iso.includes(' ') ? iso : iso + 'T00:00:00').getTime();
  if (isNaN(t)) return iso;
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return days === 1 ? 'yesterday' : `${days}d ago`;
}

// Sync status + an on-demand full sync. The daily midnight net-worth history
// point runs automatically, so there's no toggle. "Sync now" forces a fresh pull
// of everything external — linked accounts (SimpleFIN + Plaid) and real-estate
// values (Zillow) — then records a net-worth point.
function SyncSection({ status, refetch, onChanged }: { status?: SystemStatus | null; refetch: () => void; onChanged: () => void }) {
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function syncNow() {
    setSyncing(true); setError(null);
    try {
      const res = await fetch('/api/net-worth/refresh', { method: 'POST' });
      if (!res.ok) throw new Error(`Sync failed (HTTP ${res.status})`);
      refetch();   // refresh the last-synced timestamps below
      onChanged(); // tell the dashboard to re-pull balances and history
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sync failed.');
    } finally {
      setSyncing(false);
    }
  }

  return (
    <Section title="Sync status">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0, flex: 1, minWidth: 200 }}>
          Last synced — accounts {relTime(status?.lastSync.accounts ?? null)} · real estate {relTime(status?.lastSync.realEstate ?? null)}
        </p>
        <button className="btn-primary" onClick={syncNow} disabled={syncing}
          title="Pull the latest from all linked accounts and real estate, then record a net-worth point"
          style={{ fontSize: 13, padding: '7px 14px', whiteSpace: 'nowrap' }}>
          {syncing ? 'Syncing…' : '↻ Sync now'}
        </button>
      </div>
      {error && <p style={{ fontSize: 12.5, color: 'var(--red)', margin: '8px 0 0' }}>{error}</p>}
    </Section>
  );
}

// A KevFin backup bundles the full SQLite database together with the browser-side
// settings that never reach the server — Forecast assumptions, per-account
// contributions, life events, and the per-tab UI preferences (every `mon.*`
// localStorage key). Without these a restored copy would lose the entire Forecast
// configuration, so the backup is a small JSON envelope carrying both. Legacy raw
// `.db` files are still accepted on restore.
const BACKUP_FORMAT = 'kevfin-backup';

// Every browser-persisted setting lives under the `mon.` prefix (see
// usePersistentState); gather them so the backup is complete across all tabs.
function collectLocalSettings(): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith('mon.')) { const v = localStorage.getItem(k); if (v != null) out[k] = v; }
  }
  return out;
}

// base64 <-> bytes for embedding the binary .db inside the JSON envelope. Chunked
// so a multi-MB database doesn't blow String.fromCharCode's argument limit.
function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Save a blob, prompting for a destination when the File System Access API is
// available (Chromium on a secure context — https or localhost). Elsewhere
// (Firefox/Safari, or plain-http LAN access) it falls back to a normal download
// into the browser's Downloads folder. Returns false only if the user cancels.
async function saveBlobWithPrompt(blob: Blob, suggestedName: string): Promise<boolean> {
  const picker = (window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<{ createWritable: () => Promise<{ write: (b: Blob) => Promise<void>; close: () => Promise<void> }> }> }).showSaveFilePicker;
  if (typeof picker === 'function') {
    try {
      const handle = await picker({
        suggestedName,
        types: [{ description: 'KevFin backup', accept: { 'application/json': ['.json'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return true;
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return false; // user cancelled the dialog
      // Any other failure (e.g. permission denied) — fall through to a plain download.
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = suggestedName;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  return true;
}

// Full-database backup / restore / reset. Distinct from the read-only snapshot
// export above — this is the live database, for migration or disaster recovery.
function BackupSection({ refetch, onChanged }: { refetch: () => void; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function flashNote(msg: string) { setNote(msg); setTimeout(() => setNote(null), 4000); }

  async function downloadBackup() {
    setBusy('backup'); setError(null);
    try {
      const res = await fetch('/api/data/backup');
      if (!res.ok) throw new Error(`Backup failed (HTTP ${res.status})`);
      const db = new Uint8Array(await res.arrayBuffer());
      const bundle = {
        format: BACKUP_FORMAT,
        version: 1,
        exportedAt: new Date().toISOString(),
        settings: collectLocalSettings(), // Forecast assumptions + all per-tab prefs
        db: bytesToBase64(db),            // the full SQLite database
      };
      const blob = new Blob([JSON.stringify(bundle)], { type: 'application/json' });
      const name = `kevfin-backup-${new Date().toISOString().slice(0, 10)}.json`;
      const saved = await saveBlobWithPrompt(blob, name);
      if (saved) flashNote('Backup saved — database and all tab settings included.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Backup failed.');
    } finally {
      setBusy(null);
    }
  }

  async function restore(file: File) {
    if (!confirm(`Replace ALL current data with “${file.name}”? Your current database is saved to a backup first, but this cannot be undone in-app.`)) return;
    setBusy('restore'); setError(null);
    try {
      // A backup is either the new JSON bundle (database + settings) or a legacy
      // raw .db file — handle both.
      let body: ArrayBuffer;
      let settings: Record<string, string> | null = null;
      if (file.name.endsWith('.json') || file.type === 'application/json') {
        const bundle = JSON.parse(await file.text());
        if (bundle?.format !== BACKUP_FORMAT || typeof bundle.db !== 'string') {
          throw new Error('Not a valid KevFin backup file.');
        }
        body = base64ToBytes(bundle.db).buffer as ArrayBuffer;
        settings = (bundle.settings && typeof bundle.settings === 'object') ? bundle.settings : null;
      } else {
        body = await file.arrayBuffer();
      }
      const res = await fetch('/api/data/restore', {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
        body,
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.error ?? `Restore failed (HTTP ${res.status})`);
      // Re-apply the browser-side settings the bundle carried, then reload so each
      // tab re-reads them (usePersistentState only loads localStorage on mount).
      if (settings) {
        for (const [k, v] of Object.entries(settings)) { try { localStorage.setItem(k, v); } catch { /* ignore quota */ } }
      }
      flashNote(`Restored — ${d.counts.accounts} accounts, ${d.counts.snapshots} history points${settings ? ', plus tab settings' : ''}.`);
      refetch(); onChanged();
      if (settings) setTimeout(() => window.location.reload(), 900);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Restore failed.');
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function eraseAll() {
    if (!confirm('Erase ALL data — accounts, properties, assets, history, transactions? This cannot be undone (download a backup first).')) return;
    setBusy('erase'); setError(null);
    try {
      const res = await fetch('/api/data/reset', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'all' }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.error ?? `Reset failed (HTTP ${res.status})`);
      flashNote('All data cleared.');
      refetch(); onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reset failed.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Section title="Data & backup">
      <p style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 10 }}>
        A full copy — the database plus every tab's settings. Save it anywhere; restore on another machine.
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn-ghost" disabled={!!busy} onClick={downloadBackup}
          style={{ fontSize: 12.5, padding: '6px 12px' }}>
          {busy === 'backup' ? 'Saving…' : '↓ Download backup'}
        </button>
        <button className="btn-ghost" disabled={!!busy} onClick={() => fileRef.current?.click()}
          style={{ fontSize: 12.5, padding: '6px 12px' }}>
          {busy === 'restore' ? 'Restoring…' : '↑ Restore from backup'}
        </button>
        <input ref={fileRef} type="file" accept=".json,.db,application/json,application/octet-stream" style={{ display: 'none' }}
          onChange={e => { const f = e.target.files?.[0]; if (f) restore(f); }} />
        <button className="btn-ghost" disabled={!!busy} onClick={eraseAll}
          style={{ fontSize: 12.5, padding: '6px 12px', color: 'var(--red)', marginLeft: 'auto' }}>
          {busy === 'erase' ? 'Erasing…' : 'Erase all data'}
        </button>
      </div>
      {note && <p style={{ fontSize: 12.5, color: 'var(--green)', marginTop: 10 }}>{note}</p>}
      {error && <p style={{ fontSize: 12.5, color: 'var(--red)', marginTop: 10 }}>{error}</p>}
    </Section>
  );
}

interface TestCase { title: string; status: string; durationMs: number; failureMessages: string[] }
interface TestFile { name: string; status: string; tests: TestCase[] }
interface TestRunResult {
  available: boolean;
  success: boolean;
  durationMs: number;
  numTotal: number;
  numPassed: number;
  numFailed: number;
  files: TestFile[];
  error?: string;
}

// Run the server's unit test suite on demand and show pass/fail results. Vitest
// is a dev dependency, so the run control only appears when it's installed
// (i.e. running from source, not a production image).
function TestsSection() {
  const { data: status } = useApi<{ available: boolean }>('/api/tests/status');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<TestRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setRunning(true); setError(null); setResult(null);
    try {
      const res = await fetch('/api/tests/run', { method: 'POST' });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.error ?? `Test run failed (HTTP ${res.status})`);
      setResult(d as TestRunResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not run tests.');
    } finally {
      setRunning(false);
    }
  }

  // Default to available until status loads, to avoid a flash of the "not
  // installed" note; the dev case is by far the common one.
  const available = status?.available ?? true;

  return (
    <Section title="Tests">
      {!available ? (
        <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: 0 }}>
          Test runner not installed — Vitest is a dev dependency, available when running from source.
        </p>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: 0, flex: 1, minWidth: 200 }}>
              Validation tests for the money math — mortgage amortization, tax bucketing, and
              spending categorization — checked against known-correct values so the numbers stay trustworthy.
            </p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {result && (
                <span style={{ fontSize: 12.5, fontWeight: 600, color: result.success ? 'var(--green)' : 'var(--red)' }}>
                  {result.success ? '✓' : '✕'} {result.numPassed}/{result.numTotal} passed
                  {result.numFailed > 0 ? ` · ${result.numFailed} failed` : ''} · {(result.durationMs / 1000).toFixed(1)}s
                </span>
              )}
              <button className="btn-primary" onClick={run} disabled={running} style={{ fontSize: 13, padding: '7px 14px', whiteSpace: 'nowrap' }}>
                {running ? 'Running…' : '▶ Run tests'}
              </button>
            </div>
          </div>
          {result && result.files.length > 0 && (
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {result.files.map(f => {
                const passed = f.tests.filter(t => t.status === 'passed').length;
                const failures = f.tests.filter(t => t.status !== 'passed');
                return (
                  <div key={f.name} style={{ fontSize: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ color: failures.length === 0 ? 'var(--green)' : 'var(--red)' }}>
                        {failures.length === 0 ? '✓' : '✕'}
                      </span>
                      <span style={{ fontWeight: 600 }}>{f.name}</span>
                      <span style={{ color: 'var(--muted)' }}>{passed}/{f.tests.length}</span>
                    </div>
                    {failures.map((t, i) => (
                      <div key={i} style={{ marginLeft: 18, marginTop: 3, color: 'var(--red)' }}>
                        ✕ {t.title}
                        {t.failureMessages.length > 0 && (
                          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 11, color: 'var(--muted)', margin: '2px 0 0', fontFamily: 'inherit' }}>
                            {t.failureMessages.join('\n')}
                          </pre>
                        )}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          )}
          {error && <p style={{ fontSize: 12.5, color: 'var(--red)', marginTop: 10 }}>{error}</p>}
        </>
      )}
    </Section>
  );
}

// App version and data counts.
// Quiet footer: app version + a compact data readout on the left, and the link
// back to the first-run welcome guide on the right. Dispatching the event opens
// the Welcome overlay (mounted at the app root) and closes this modal — see the
// listener in the Setup default export below.
function FooterSection({ status }: { status?: SystemStatus | null }) {
  const c = status?.counts;
  return (
    <Section title="About">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0 }}>
          KevFin v{status?.version ?? '—'}
          {c && ` · ${c.accounts} accounts · ${c.properties} properties · ${c.snapshots} history points · ${c.importedTxns} transactions`}
        </p>
        <button className="btn-ghost" style={{ fontSize: 12.5, padding: '6px 12px', whiteSpace: 'nowrap' }}
          onClick={() => window.dispatchEvent(new Event(SHOW_WELCOME_EVENT))}>
          ↗ Welcome guide
        </button>
      </div>
    </Section>
  );
}

// Desktop-only: choose where the database and keys file live (e.g. a Dropbox/NAS
// folder), then relaunch to apply. Hidden in the browser / NAS build, where
// window.kevfinDesktop is undefined.
function StorageSection() {
  const [paths, setPaths] = useState<{ dbPath: string; keysPath: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    window.kevfinDesktop?.getPaths()
      .then(p => setPaths({ dbPath: p.dbPath, keysPath: p.keysPath }))
      .catch(() => { /* ignore */ });
  }, []);

  async function change(which: 'db' | 'keys') {
    const api = window.kevfinDesktop;
    if (!api) return;
    setError(null);
    const dir = await api.chooseDir(which);
    if (!dir) return;
    const label = which === 'keys' ? 'keys file' : 'database';
    if (!confirm(`Move your ${label} into:\n${dir}\n\nKevFin will copy it there and restart. Continue?`)) return;
    setBusy(true);
    // On success the app relaunches and never returns here; a returned result means it failed.
    const res = await api.applyAndRelaunch(which === 'db' ? { dbDir: dir } : { keysDir: dir });
    if (res && !res.ok) { setError(res.error || 'Could not change the location.'); setBusy(false); }
  }

  return (
    <Section title="Storage location">
      <p style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 10 }}>
        Where your data lives. Point it at a Dropbox or NAS folder to sync across machines.
      </p>
      <div style={{ display: 'grid', gap: 10 }}>
        {([['Database', paths?.dbPath, 'db'], ['Keys file', paths?.keysPath, 'keys']] as const).map(([label, p, which]) => (
          <div key={which} style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between', flexWrap: 'wrap' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 600 }}>{label}</div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', wordBreak: 'break-all' }}>{p ?? '…'}</div>
            </div>
            <button className="btn-ghost" disabled={busy} onClick={() => change(which)} style={{ fontSize: 12.5, padding: '6px 12px', flex: '0 0 auto' }}>
              {busy ? 'Restarting…' : 'Change folder…'}
            </button>
          </div>
        ))}
      </div>
      <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 10 }}>
        Don't run two machines against the same synced file at once — only one can write safely.
      </p>
      {error && <p style={{ fontSize: 12.5, color: 'var(--red)', marginTop: 10 }}>{error}</p>}
    </Section>
  );
}

// A static link to the project's Buy Me a Coffee page. Deliberately a plain
// anchor (no third-party script/widget) so KevFin still loads nothing from an
// external host unless the user actively clicks through — privacy intact.
function SupportSection() {
  return (
    <Section title="Support KevFin" first>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: 0, flex: 1, minWidth: 200 }}>
          Free and fully local — nothing leaves your machine. If it helps you, leave a tip.
        </p>
        <a className="btn-ghost" href="https://www.buymeacoffee.com/kxl3785"
          target="_blank" rel="noopener noreferrer"
          style={{ fontSize: 12.5, padding: '6px 12px', textDecoration: 'none', whiteSpace: 'nowrap' }}>
          ☕ Buy me a coffee
        </a>
      </div>
    </Section>
  );
}

// The modal body. Lives in its own component (only mounted while the menu is
// open) so /api/data/status is fetched once, on open, and shared by the
// sections — not on every page load where the gear button sits in the nav.
function SetupSections({ onChanged }: { onChanged: () => void }) {
  const { data: status, refetch } = useApi<SystemStatus>('/api/data/status');
  return (
    <>
      <SupportSection />
      <BackupSection refetch={refetch} onChanged={onChanged} />
      <ExportSection />
      {window.kevfinDesktop && <StorageSection />}
      <TestsSection />
      <SyncSection status={status} refetch={refetch} onChanged={onChanged} />
      <FooterSection status={status} />
    </>
  );
}

/**
 * A settings hub reached from a gear icon in the TopNav, so it's identical on
 * every page. Holds the operational, app-wide actions that have no per-item home
 * on the dashboard: sync automation, full backup/restore/reset, the encrypted
 * snapshot export, and an about/status readout. Broadcasts a data-changed event
 * so the dashboard re-pulls after a restore/reset without a reload.
 */
export default function Setup() {
  const [open, setOpen] = useState(false);

  // Tell the rest of the app to re-pull after Setup mutates data.
  function afterChange() { broadcastDataChanged(); }

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Step aside when the welcome guide is opened from here, so it isn't stacked
  // behind this modal.
  useEffect(() => {
    function onShowWelcome() { setOpen(false); }
    window.addEventListener(SHOW_WELCOME_EVENT, onShowWelcome);
    return () => window.removeEventListener(SHOW_WELCOME_EVENT, onShowWelcome);
  }, []);

  return (
    <>
      <button
        className="btn-icon"
        onClick={() => setOpen(true)}
        title="Setup"
        aria-label="Setup"
      >
        <GearIcon />
      </button>

      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 3000,
            background: 'rgba(0,0,0,0.55)', display: 'flex',
            alignItems: 'flex-start', justifyContent: 'center',
            padding: '4vh 16px 16px', overflowY: 'auto',
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
              padding: 20,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 2 }}>
              <h2 style={{ fontSize: 18, fontWeight: 700 }}>Setup</h2>
              <button
                onClick={() => setOpen(false)}
                aria-label="Close"
                style={{ background: 'transparent', color: 'var(--muted)', fontSize: 22, lineHeight: 1, padding: 0, cursor: 'pointer' }}
              >×</button>
            </div>
            <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 14 }}>
              Backups, snapshots, and app status. Connect institutions and add data from the dashboard.
            </p>

            <SetupSections onChanged={afterChange} />
          </div>
        </div>
      )}
    </>
  );
}
