import { useEffect, useRef, useState } from 'react';
import { useApi } from '../hooks/useApi.ts';
import { SHOW_WELCOME_EVENT } from './Welcome.tsx';
import { sqliteUtcToIso } from '../lib/parseNum.ts';
import { fmtDate } from '../lib/format.ts';
import { usePersistentState } from '../hooks/usePersistentState.ts';

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

interface SystemStatus {
  dbPath: string;
  version: string;
  dailySnapshotEnabled: boolean;
  lastSync: { accounts: string | null; realEstate: string | null; snapshot: string | null };
  counts: { accounts: number; properties: number; manualAssets: number; snapshots: number; importedTxns: number; feedTxns?: number; connections: number };
}

// Epoch ms for a stored timestamp, or NaN. updated_at is SQLite datetime('now'):
// UTC with no zone marker, which Date would otherwise read as local time (hours
// off) — normalise it to explicit UTC first.
function parseTs(iso: string): number {
  const norm = sqliteUtcToIso(iso);
  return new Date(norm.includes('T') || norm.includes(' ') ? norm : norm + 'T00:00:00').getTime();
}

function plural(n: number, one: string, many = one + 's'): string {
  return `${n} ${n === 1 ? one : many}`;
}

function relTime(iso: string | null): string {
  if (!iso) return 'never';
  const t = parseTs(iso);
  if (isNaN(t)) return iso;
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return days === 1 ? 'yesterday' : `${days}d ago`;
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

// ---- Row-list building blocks ------------------------------------------------
// The modal is a grouped settings list: a small muted group label, then a
// bordered rounded container with one row per task. Rows are real <button>s (or
// an <a> for the report) spanning the full width; rows that need more room expand
// their content underneath instead of opening another dialog.

const groupLabel: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5,
  color: 'var(--muted)', margin: '0 0 6px 2px',
};
const keyInput: React.CSSProperties = { fontSize: 13, padding: '6px 8px', width: '100%' };
const msgStyle: React.CSSProperties = { fontSize: 12.5, margin: '8px 2px 0' };

// Hover tint + the 1px dividers between rows (no new colors, just the theme vars).
const ROW_CSS = `
.setup-group > * + * { border-top: 1px solid var(--border); }
.setup-row { display: flex; align-items: center; gap: 12px; width: 100%; padding: 12px 14px;
  background: transparent; border: none; border-radius: 0; text-align: left; color: var(--text);
  text-decoration: none; font: inherit; box-sizing: border-box; }
.setup-row:hover:not(:disabled) { background: var(--surface-2); }
.setup-row:disabled { opacity: 0.6; cursor: default; }
.setup-row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
`;

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 16 }}>
      <p style={groupLabel}>{label}</p>
      <div className="setup-group" style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
        {children}
      </div>
    </div>
  );
}

function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" width={20} height={20} fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: 'none' }}>
      {children}
    </svg>
  );
}
const IconRefresh = () => <Icon><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16" /><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8" /><path d="M21 3v5h-5" /><path d="M3 21v-5h5" /></Icon>;
const IconDownload = () => <Icon><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></Icon>;
const IconUpload = () => <Icon><path d="M12 15V3" /><path d="m7 8 5-5 5 5" /><path d="M5 21h14" /></Icon>;
const IconFile = () => <Icon><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" /><path d="M8 13h5M8 17h8" /></Icon>;
const IconLock = () => <Icon><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></Icon>;
const IconFlask = () => <Icon><path d="M9 3h6" /><path d="M10 3v6L4.5 19a1.5 1.5 0 0 0 1.3 2.2h12.4a1.5 1.5 0 0 0 1.3-2.2L14 9V3" /><path d="M7.5 15h9" /></Icon>;
const IconTrash = () => <Icon><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /><path d="M10 11v6M14 11v6" /></Icon>;

function Chevron({ open }: { open?: boolean }) {
  return (
    <span aria-hidden="true" style={{
      flex: 'none', fontSize: 18, lineHeight: 1, color: 'var(--muted)',
      transform: open ? 'rotate(90deg)' : undefined, transition: 'transform 0.15s',
    }}>›</span>
  );
}
function Spinner() {
  return (
    <svg className="spin" viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="var(--muted)"
      strokeWidth={2.5} strokeLinecap="round" aria-label="Working" style={{ flex: 'none' }}>
      <path d="M12 3a9 9 0 0 1 9 9" />
    </svg>
  );
}

interface RowProps {
  icon: React.ReactNode;
  title: string;
  subtitle?: React.ReactNode;
  right?: React.ReactNode;   // defaults to a chevron
  onClick?: () => void;
  href?: string;             // renders a link (opens in a new tab) instead of a button
  disabled?: boolean;
  danger?: boolean;
  expanded?: boolean;        // set on rows that reveal content below (aria-expanded)
  tip?: string;
  children?: React.ReactNode; // the expanded content, shown under the row
}

function Row({ icon, title, subtitle, right, onClick, href, disabled, danger, expanded, tip, children }: RowProps) {
  const body = (
    <>
      <span style={{ color: danger ? 'var(--red)' : 'var(--muted)', display: 'inline-flex' }}>{icon}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 14, fontWeight: 500, color: danger ? 'var(--red)' : 'var(--text)' }}>{title}</span>
        {subtitle && <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{subtitle}</span>}
      </span>
      <span style={{ flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
        {right ?? <Chevron open={expanded} />}
      </span>
    </>
  );
  return (
    <div>
      {href ? (
        <a className="setup-row" href={href} target="_blank" rel="noopener noreferrer" title={tip}>{body}</a>
      ) : (
        <button type="button" className="setup-row" onClick={onClick} disabled={disabled} title={tip}
          aria-expanded={expanded}>{body}</button>
      )}
      {expanded && children && <div style={{ padding: '2px 14px 14px' }}>{children}</div>}
    </div>
  );
}

// ---- Sync --------------------------------------------------------------------
// "Sync now" forces a fresh pull of everything external — linked accounts
// (SimpleFIN + Plaid) and real-estate values (Zillow) — then records a net-worth
// point. The daily midnight history point runs automatically, so no toggle.
function SyncRow({ status, refetch, onChanged }: { status?: SystemStatus | null; refetch: () => void; onChanged: () => void }) {
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function syncNow() {
    setSyncing(true); setError(null);
    try {
      const res = await fetch('/api/net-worth/refresh', { method: 'POST' });
      if (!res.ok) throw new Error(`Sync failed (HTTP ${res.status})`);
      refetch();   // refresh the last-synced timestamp
      onChanged(); // tell the dashboard to re-pull balances and history
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sync failed.');
    } finally {
      setSyncing(false);
    }
  }

  // Freshness keys off whichever of accounts / real estate synced most recently.
  const stamps = [status?.lastSync.accounts, status?.lastSync.realEstate]
    .filter((s): s is string => !!s).map(parseTs).filter(t => !isNaN(t));
  const newest = stamps.length ? Math.max(...stamps) : null;
  const fresh = newest != null && Date.now() - newest < 86400_000;
  const lastIso = newest != null ? new Date(newest).toISOString() : null;

  return (
    <Row
      icon={<IconRefresh />}
      title="Sync now"
      tip="Pull the latest from all linked accounts and real estate, then record a net-worth point"
      onClick={syncNow}
      disabled={syncing}
      subtitle={error
        ? <span style={{ color: 'var(--red)' }}>{error}</span>
        : syncing ? 'Syncing…'
        : !status ? 'Checking…'
        : `Accounts and real estate · last synced ${relTime(lastIso)}`}
      right={syncing || !status ? <Spinner />
        : <span style={{ color: fresh ? 'var(--green)' : 'var(--muted)' }}>{fresh ? 'Up to date' : 'Stale'}</span>}
    />
  );
}

// ---- Encrypted snapshot ------------------------------------------------------
// Export a password-protected, point-in-time snapshot of everything as a single
// self-contained HTML file. The password is sent once to encrypt the payload
// server-side (AES-GCM); it is never stored. The downloaded file decrypts and
// renders entirely in the recipient's browser — works offline, no server.
function ExportForm() {
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
    <>
      <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 10px' }}>
        A password-protected HTML file of all data — opens offline; the recipient needs the password.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 8 }}>
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
    </>
  );
}

function SnapshotRow() {
  const [open, setOpen] = useState(false);
  return (
    <Row icon={<IconLock />} title="Encrypted snapshot" subtitle="Password-protected file to share"
      onClick={() => setOpen(o => !o)} expanded={open}>
      <ExportForm />
    </Row>
  );
}

// ---- Validation tests --------------------------------------------------------
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
// is a dev dependency, so the run control only works when it's installed (i.e.
// running from source, not a production image). Opening the row runs the suite;
// "Run again" re-runs it in place.
function TestsRow() {
  const { data: status } = useApi<{ available: boolean }>('/api/tests/status');
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<TestRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastPassedAt, setLastPassedAt] = usePersistentState<string>('mon.lastTestsAt', '');

  async function run() {
    setRunning(true); setError(null); setResult(null);
    try {
      const res = await fetch('/api/tests/run', { method: 'POST' });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.error ?? `Test run failed (HTTP ${res.status})`);
      setResult(d as TestRunResult);
      if ((d as TestRunResult).success) setLastPassedAt(new Date().toISOString());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not run tests.');
    } finally {
      setRunning(false);
    }
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !result && !running) run();
  }

  // Default to available until status loads, to avoid a flash of the "not
  // installed" note; the dev case is by far the common one.
  const available = status?.available ?? true;

  return (
    <Row
      icon={<IconFlask />}
      title="Run validation tests"
      subtitle={!available ? 'Test runner not installed'
        : lastPassedAt ? `Last passed ${fmtDate(lastPassedAt)}` : 'Checks the money math against known-correct values'}
      onClick={toggle}
      expanded={open}
      disabled={!available && !open}
      right={running ? <Spinner />
        : result ? <span style={{ fontWeight: 600, color: result.success ? 'var(--green)' : 'var(--red)' }}>
            {result.success ? '✓' : '✕'} {result.numPassed}/{result.numTotal}
          </span>
        : undefined}
    >
      {!available ? (
        <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: 0 }}>
          Test runner not installed — Vitest is a dev dependency, available when running from source.
        </p>
      ) : (
        <>
          <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 10px' }}>
            Validation tests for the money math — mortgage amortization, tax bucketing, and
            spending categorization — checked against known-correct values so the numbers stay trustworthy.
          </p>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
            {result ? (
              <span style={{ fontSize: 12.5, fontWeight: 600, color: result.success ? 'var(--green)' : 'var(--red)' }}>
                {result.success ? '✓' : '✕'} {result.numPassed}/{result.numTotal} passed
                {result.numFailed > 0 ? ` · ${result.numFailed} failed` : ''} · {(result.durationMs / 1000).toFixed(1)}s
              </span>
            ) : <span />}
            <button className="btn-primary" onClick={run} disabled={running} style={{ fontSize: 13, padding: '7px 14px', whiteSpace: 'nowrap' }}>
              {running ? 'Running…' : result || error ? '▶ Run again' : '▶ Run tests'}
            </button>
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
                      <span style={{ fontWeight: 600, minWidth: 0, overflowWrap: 'anywhere' }}>{f.name}</span>
                      <span style={{ color: 'var(--muted)' }}>{passed}/{f.tests.length}</span>
                    </div>
                    {failures.map((t, i) => (
                      <div key={i} style={{ marginLeft: 18, marginTop: 3, color: 'var(--red)' }}>
                        ✕ {t.title}
                        {t.failureMessages.length > 0 && (
                          <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 11, color: 'var(--muted)', margin: '2px 0 0', fontFamily: 'inherit' }}>
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
    </Row>
  );
}

// ---- Modal body --------------------------------------------------------------
// Lives in its own component (only mounted while the menu is open) so
// /api/data/status is fetched once, on open, and shared by the rows — not on
// every page load where the gear button sits in the nav.
function SetupSections({ onChanged }: { onChanged: () => void }) {
  const { data: status, refetch } = useApi<SystemStatus>('/api/data/status');
  const { data: report } = useApi<{ quarterLabel?: string }>('/api/report/quarterly/status');
  const [busy, setBusy] = useState<string | null>(null);
  // Feedback text lands under the group the action lives in.
  const [msg, setMsg] = useState<{ group: 'backup' | 'maint'; kind: 'note' | 'error'; text: string } | null>(null);
  const [lastBackupAt, setLastBackupAt] = usePersistentState<string>('mon.lastBackupAt', '');
  const fileRef = useRef<HTMLInputElement>(null);

  function flashNote(group: 'backup' | 'maint', text: string) {
    setMsg({ group, kind: 'note', text });
    setTimeout(() => setMsg(m => (m?.kind === 'note' && m.text === text ? null : m)), 4000);
  }
  const fail = (group: 'backup' | 'maint', text: string) => setMsg({ group, kind: 'error', text });

  async function downloadBackup() {
    setBusy('backup'); setMsg(null);
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
      if (saved) {
        setLastBackupAt(new Date().toISOString());
        flashNote('backup', 'Backup saved — database and all tab settings included.');
      }
    } catch (e) {
      fail('backup', e instanceof Error ? e.message : 'Backup failed.');
    } finally {
      setBusy(null);
    }
  }

  async function restore(file: File) {
    if (!confirm(`Replace ALL current data with “${file.name}”? Your current database is saved to a backup first, but this cannot be undone in-app.`)) return;
    setBusy('restore'); setMsg(null);
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
      flashNote('backup', `Restored — ${d.counts.accounts} accounts, ${d.counts.snapshots} history points${settings ? ', plus tab settings' : ''}.`);
      refetch(); onChanged();
      if (settings) setTimeout(() => window.location.reload(), 900);
    } catch (e) {
      fail('backup', e instanceof Error ? e.message : 'Restore failed.');
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function eraseAll() {
    if (!confirm('Erase ALL data — accounts, properties, assets, history, transactions? This cannot be undone (download a backup first).')) return;
    setBusy('erase'); setMsg(null);
    try {
      const res = await fetch('/api/data/reset', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'all' }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.error ?? `Reset failed (HTTP ${res.status})`);
      flashNote('maint', 'All data cleared.');
      refetch(); onChanged();
    } catch (e) {
      fail('maint', e instanceof Error ? e.message : 'Reset failed.');
    } finally {
      setBusy(null);
    }
  }

  const feedback = (group: 'backup' | 'maint') => msg?.group === group && (
    <p role="status" style={{ ...msgStyle, color: msg.kind === 'error' ? 'var(--red)' : 'var(--green)' }}>{msg.text}</p>
  );
  const c = status?.counts;

  return (
    <>
      <style>{ROW_CSS}</style>

      <Group label="Sync">
        <SyncRow status={status} refetch={refetch} onChanged={onChanged} />
      </Group>

      <Group label="Backup and sharing">
        <Row icon={<IconDownload />} title="Download backup" disabled={!!busy} onClick={downloadBackup}
          subtitle={busy === 'backup' ? 'Saving…'
            : lastBackupAt ? `Last backup ${fmtDate(lastBackupAt)}` : "Database plus every tab's settings"}
          right={busy === 'backup' ? <Spinner /> : undefined} />
        <Row icon={<IconUpload />} title="Restore from backup" disabled={!!busy} onClick={() => fileRef.current?.click()}
          subtitle={busy === 'restore' ? 'Restoring…' : 'Replace current data with a saved backup file'}
          right={busy === 'restore' ? <Spinner /> : undefined} />
        <Row icon={<IconFile />} title="Quarterly report" href="/api/report/quarterly"
          subtitle={report?.quarterLabel ?? 'Latest completed quarter'}
          tip="A local net-worth statement for the most recent completed quarter. Rendered on your machine."
          right={<span aria-hidden="true" style={{ fontSize: 16, color: 'var(--muted)' }}>↗</span>} />
        <SnapshotRow />
      </Group>
      <input ref={fileRef} type="file" accept=".json,.db,application/json,application/octet-stream" style={{ display: 'none' }}
        onChange={e => { const f = e.target.files?.[0]; if (f) restore(f); }} />
      {feedback('backup')}

      <Group label="Maintenance">
        <TestsRow />
        <Row icon={<IconTrash />} title="Erase all data" danger disabled={!!busy} onClick={eraseAll}
          subtitle={busy === 'erase' ? 'Erasing…' : undefined}
          right={busy === 'erase' ? <Spinner /> : undefined} />
      </Group>
      {feedback('maint')}

      {/* Footer: version + data readout, then the support link. The coffee link is
          a plain anchor (no third-party script/widget) so KevFin loads nothing from
          an external host unless the user actively clicks through. */}
      <div style={{ marginTop: 20, textAlign: 'center', fontSize: 12, color: 'var(--muted)', lineHeight: 1.7 }}>
        <div>
          KevFin{status && ` v${status.version}`}
          {c && ` · ${plural(c.accounts, 'account')} · ${plural(c.properties, 'property', 'properties')} · ${plural(c.importedTxns + (c.feedTxns ?? 0), 'transaction')}`}
        </div>
        <div>
          Free and fully local ·{' '}
          <a href="https://www.buymeacoffee.com/kxl3785" target="_blank" rel="noopener noreferrer"
            style={{ color: 'var(--accent)', textDecoration: 'none' }}>Buy me a coffee</a>
          {' · '}
          <button type="button" onClick={() => window.dispatchEvent(new Event(SHOW_WELCOME_EVENT))}
            style={{ background: 'transparent', padding: 0, border: 'none', font: 'inherit', color: 'var(--accent)', fontWeight: 400 }}>
            Welcome guide
          </button>
        </div>
      </div>
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
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
              <h2 style={{ fontSize: 18, fontWeight: 700 }}>Setup</h2>
              <button
                onClick={() => setOpen(false)}
                aria-label="Close"
                style={{ background: 'transparent', color: 'var(--muted)', fontSize: 22, lineHeight: 1, padding: 0, cursor: 'pointer' }}
              >×</button>
            </div>
            <SetupSections onChanged={afterChange} />
          </div>
        </div>
      )}
    </>
  );
}
