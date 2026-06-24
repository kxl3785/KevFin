import { useEffect, useRef, useState } from 'react';
import { useApi } from '../hooks/useApi.ts';

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
        A single password-protected HTML file of all current data — opens in any browser, offline. The
        recipient needs the password to view it.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <input type="password" value={password} onChange={e => setPassword(e.target.value)}
          placeholder="Password" style={keyInput} autoComplete="new-password" />
        <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)}
          placeholder="Confirm password" style={keyInput} autoComplete="new-password" />
        <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, fontSize: 12.5, color: 'var(--muted)' }}>
          <span>Expires after (optional) — courtesy limit, not strongly enforced</span>
          <input type="date" value={expiry} min={minExpiry} onChange={e => setExpiry(e.target.value)}
            style={{ ...keyInput, width: 'auto' }} />
        </label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button className="btn-primary" onClick={run} disabled={busy} style={{ fontSize: 13, padding: '7px 14px' }}>
            {busy ? 'Generating…' : '↓ Export snapshot'}
          </button>
          {done && <span style={{ fontSize: 12.5, color: 'var(--green)' }}>Downloaded.</span>}
        </div>
        {error && <p style={{ fontSize: 12.5, color: 'var(--red)' }}>{error}</p>}
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

// Sync status + the daily net-worth history toggle.
function SyncSection({ status, refetch }: { status?: SystemStatus | null; refetch: () => void }) {
  async function toggleDaily(enabled: boolean) {
    await fetch('/api/data/daily-snapshot', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    refetch();
  }

  return (
    <Section title="Sync & automation" first>
      <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, fontSize: 12.5, color: 'var(--muted)', marginBottom: 8, cursor: 'pointer' }}>
        <span>Record a net-worth history point every midnight.</span>
        <input type="checkbox" checked={status?.dailySnapshotEnabled ?? true}
          onChange={e => toggleDaily(e.target.checked)} style={{ width: 'auto', cursor: 'pointer' }} />
      </label>
      <div style={{ fontSize: 12, color: 'var(--muted)', display: 'grid', gridTemplateColumns: '1fr auto', rowGap: 3 }}>
        <span>Accounts last synced</span><span style={{ textAlign: 'right' }}>{relTime(status?.lastSync.accounts ?? null)}</span>
        <span>Real estate last synced</span><span style={{ textAlign: 'right' }}>{relTime(status?.lastSync.realEstate ?? null)}</span>
        <span>Net worth recorded</span><span style={{ textAlign: 'right' }}>{relTime(status?.lastSync.snapshot ?? null)}</span>
      </div>
    </Section>
  );
}

// Full-database backup / restore / reset. Distinct from the read-only snapshot
// export above — this is the live database, for migration or disaster recovery.
function BackupSection({ refetch, onChanged }: { refetch: () => void; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function flashNote(msg: string) { setNote(msg); setTimeout(() => setNote(null), 4000); }

  async function restore(file: File) {
    if (!confirm(`Replace ALL current data with “${file.name}”? Your current database is saved to a backup first, but this cannot be undone in-app.`)) return;
    setBusy('restore'); setError(null);
    try {
      const res = await fetch('/api/data/restore', {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
        body: await file.arrayBuffer(),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.error ?? `Restore failed (HTTP ${res.status})`);
      flashNote(`Restored — ${d.counts.accounts} accounts, ${d.counts.snapshots} history points.`);
      refetch(); onChanged();
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
        A full copy of your database — restore it on another machine or recover from a mistake.
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <a className="btn-ghost" href="/api/data/backup"
          style={{ fontSize: 12.5, padding: '6px 12px', textDecoration: 'none' }}>↓ Download backup</a>
        <button className="btn-ghost" disabled={!!busy} onClick={() => fileRef.current?.click()}
          style={{ fontSize: 12.5, padding: '6px 12px' }}>
          {busy === 'restore' ? 'Restoring…' : '↑ Restore from backup'}
        </button>
        <input ref={fileRef} type="file" accept=".db,application/octet-stream" style={{ display: 'none' }}
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

// App version and data counts.
function AboutSection({ status }: { status?: SystemStatus | null }) {
  const c = status?.counts;
  return (
    <Section title="About">
      <p style={{ fontSize: 12.5, color: 'var(--muted)' }}>
        KevFin v{status?.version ?? '—'}
        {c && ` · ${c.accounts} accounts · ${c.connections} connections · ${c.properties} properties · ${c.manualAssets} manual assets · ${c.snapshots} history points · ${c.importedTxns} transactions`}
      </p>
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
      <SyncSection status={status} refetch={refetch} />
      <BackupSection refetch={refetch} onChanged={onChanged} />
      <ExportSection />
      <AboutSection status={status} />
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
