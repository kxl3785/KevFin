import { useEffect, useState } from 'react';
import { useApi } from '../hooks/useApi.ts';
import ConnectSimpleFIN from './ConnectSimpleFIN.tsx';
import ConnectPlaid from './ConnectPlaid.tsx';

interface Connection { id: number; account_count: number; institutions: string; created_at: string }
interface PlaidItem { item_id: string; institution_name: string; account_count: number; created_at: string }

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

const sectionTitle: React.CSSProperties = { fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--muted)', marginBottom: 8 };

interface KeyStatus {
  plaid: { set: boolean; env: string; clientIdHint: string | null; secretSet: boolean };
}

const keyInput: React.CSSProperties = { fontSize: 13, padding: '6px 8px', width: '100%' };

// Plaid credentials panel. Secrets are write-only here: the server returns only
// a masked hint / set-status (never the real value), inputs are never pre-filled,
// and a saved key is validated with a live test call before it's persisted to
// server/.env. The user types their own keys — they're never auto-filled.
function KeysSection() {
  const { data, refetch } = useApi<KeyStatus>('/api/config/keys');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [env, setEnv] = useState('production');

  function start() { setClientId(''); setSecret(''); setEnv(data?.plaid.env ?? 'production'); setError(null); setEditing(true); }
  function cancel() { setEditing(false); setError(null); }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/config/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plaid_client_id: clientId, plaid_secret: secret, plaid_env: env }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.error ?? `Save failed (HTTP ${res.status})`);
      await refetch();
      setEditing(false);
      // New creds flip Plaid's "configured" state — let the Connect button re-check.
      broadcastDataChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the credentials.');
    } finally {
      setSaving(false);
    }
  }

  const plaid = data?.plaid;

  return (
    <div style={{ paddingTop: 18, marginTop: 18, borderTop: '1px solid var(--border)' }}>
      <p style={sectionTitle}>Plaid credentials</p>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <div>
          <p style={{ fontSize: 12.5, color: 'var(--muted)' }}>Required to connect Frec / Bilt via Plaid.</p>
          <p style={{ fontSize: 12, color: plaid?.set ? 'var(--green)' : 'var(--muted)', marginTop: 2 }}>
            {plaid?.set ? `Configured · ${plaid.env} · client ${plaid.clientIdHint}` : 'Not set'}
          </p>
        </div>
        {!editing && (
          <button className="btn-ghost" onClick={start} style={{ fontSize: 12, padding: '4px 10px', whiteSpace: 'nowrap' }}>
            {plaid?.set ? 'Change' : 'Set keys'}
          </button>
        )}
      </div>
      {editing && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input type="text" autoComplete="off" placeholder="Client ID" value={clientId}
            onChange={e => setClientId(e.target.value)} disabled={saving} style={keyInput} autoFocus />
          <input type="password" autoComplete="off" placeholder="Secret" value={secret}
            onChange={e => setSecret(e.target.value)} disabled={saving} style={keyInput} />
          <select value={env} onChange={e => setEnv(e.target.value)} disabled={saving} style={keyInput}>
            <option value="production">production</option>
            <option value="development">development</option>
            <option value="sandbox">sandbox</option>
          </select>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn-primary" disabled={saving || !clientId.trim() || !secret.trim()} style={{ fontSize: 12, padding: '6px 12px' }} onClick={save}>
              {saving ? 'Validating…' : 'Validate & save'}
            </button>
            <button className="btn-ghost" disabled={saving} style={{ fontSize: 12, padding: '6px 12px' }} onClick={cancel}>Cancel</button>
          </div>
        </div>
      )}
      {error && <p style={{ fontSize: 12.5, color: 'var(--red)', marginTop: 10 }}>{error}</p>}
      <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 12 }}>
        Validated with a test call, then stored in <code>server/.env</code> on this machine. Never displayed back.
      </p>
    </div>
  );
}

/**
 * A settings hub reached from a gear icon in the TopNav, so it's identical on
 * every page. Gathers the app's setup actions that otherwise live only on the
 * dashboard: connecting / removing the institutions that feed the data, and the
 * history-maintenance actions (refresh today's snapshot, backfill ~5 years).
 * Self-contained — it fetches its own connection lists and broadcasts a
 * data-changed event so the dashboard re-pulls without a reload.
 */
export default function Setup() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'refresh' | 'backfill' | null>(null);
  const { data: connections, refetch: refetchConn } = useApi<Connection[]>('/api/simplefin/connections');
  const { data: plaidItems, refetch: refetchPlaid } = useApi<PlaidItem[]>('/api/plaid/items');

  // Refresh the lists shown here, and tell the rest of the app to re-pull too.
  function afterChange() { refetchConn(); refetchPlaid(); broadcastDataChanged(); }

  // Close on Escape (but not mid-request).
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape' && !busy) setOpen(false); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy]);

  async function removeConnection(id: number) {
    if (!confirm('Remove this connection? Its accounts will stop syncing and be removed from your net worth.')) return;
    await fetch(`/api/simplefin/connections/${id}`, { method: 'DELETE' });
    afterChange();
  }
  async function removePlaidItem(itemId: string) {
    if (!confirm('Remove this connection? Its accounts will stop syncing and be removed from your net worth.')) return;
    await fetch(`/api/plaid/items/${itemId}`, { method: 'DELETE' });
    afterChange();
  }

  async function runRefresh() {
    setBusy('refresh');
    try { await fetch('/api/net-worth/refresh', { method: 'POST' }); afterChange(); }
    finally { setBusy(null); }
  }
  async function runBackfill() {
    setBusy('backfill');
    try { await fetch('/api/net-worth/backfill', { method: 'POST' }); broadcastDataChanged(); }
    finally { setBusy(null); }
  }

  const totalConnections = (connections?.length ?? 0) + (plaidItems?.length ?? 0);

  return (
    <>
      <button
        className="btn-icon"
        onClick={() => setOpen(true)}
        title="Setup & connections"
        aria-label="Setup & connections"
      >
        <GearIcon />
      </button>

      {open && (
        <div
          onClick={() => { if (!busy) setOpen(false); }}
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
              <h2 style={{ fontSize: 18, fontWeight: 700 }}>Setup</h2>
              <button
                onClick={() => { if (!busy) setOpen(false); }}
                disabled={!!busy}
                aria-label="Close"
                style={{ background: 'transparent', color: 'var(--muted)', fontSize: 22, lineHeight: 1, padding: 0, cursor: busy ? 'default' : 'pointer' }}
              >×</button>
            </div>
            <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 22 }}>
              Connect the institutions that feed your net worth, and keep its history up to date.
            </p>

            {/* Connected institutions */}
            <div style={{ marginBottom: 24 }}>
              <p style={sectionTitle}>
                Connected institutions
                {totalConnections > 0 && <span style={{ opacity: 0.6, fontWeight: 400, marginLeft: 6 }}>({totalConnections})</span>}
              </p>

              {totalConnections === 0 && (
                <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 12 }}>
                  No institutions connected yet. Link one below to sync balances automatically.
                </p>
              )}

              {connections?.map(conn => (
                <div key={conn.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0' }}>
                  <div>
                    <p style={{ fontWeight: 500, fontSize: 13 }}>{conn.institutions || 'Pending…'}</p>
                    <p style={{ color: 'var(--muted)', fontSize: 12 }}>{conn.account_count} account{conn.account_count !== 1 ? 's' : ''} · via SimpleFIN</p>
                  </div>
                  <button className="btn-ghost" style={{ fontSize: 12, padding: '4px 10px', color: 'var(--red)' }}
                    onClick={() => removeConnection(conn.id)}>Remove</button>
                </div>
              ))}
              {plaidItems?.map(item => (
                <div key={item.item_id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0' }}>
                  <div>
                    <p style={{ fontWeight: 500, fontSize: 13 }}>
                      {item.institution_name} <span style={{ fontSize: 10, color: 'var(--accent)' }}>via Plaid</span>
                    </p>
                    <p style={{ color: 'var(--muted)', fontSize: 12 }}>{item.account_count} account{item.account_count !== 1 ? 's' : ''}</p>
                  </div>
                  <button className="btn-ghost" style={{ fontSize: 12, padding: '4px 10px', color: 'var(--red)' }}
                    onClick={() => removePlaidItem(item.item_id)}>Remove</button>
                </div>
              ))}

              <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                <ConnectPlaid onSuccess={afterChange} />
                <ConnectSimpleFIN onSuccess={afterChange} />
              </div>
            </div>

            {/* Plaid credentials — the keys that enable the Plaid connect button above */}
            <KeysSection />

            {/* History maintenance */}
            <div style={{ paddingTop: 18, borderTop: '1px solid var(--border)' }}>
              <p style={sectionTitle}>Net-worth history</p>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                <p style={{ fontSize: 12.5, color: 'var(--muted)', flex: 1 }}>
                  Re-pull current balances and snapshot today.
                </p>
                <button className="btn-ghost" onClick={runRefresh} disabled={!!busy} style={{ fontSize: 12.5, padding: '6px 12px', whiteSpace: 'nowrap' }}>
                  {busy === 'refresh' ? 'Refreshing…' : '⟳ Refresh now'}
                </button>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                <p style={{ fontSize: 12.5, color: 'var(--muted)', flex: 1 }}>
                  Reconstruct ~5 years of history from transactions, holdings, and home values.
                </p>
                <button className="btn-ghost" onClick={runBackfill} disabled={!!busy} style={{ fontSize: 12.5, padding: '6px 12px', whiteSpace: 'nowrap' }}>
                  {busy === 'backfill' ? 'Backfilling…' : '⟲ Backfill'}
                </button>
              </div>
            </div>

            {/* Pointer to the other data-entry paths so Setup is the obvious hub. */}
            <div style={{ paddingTop: 18, marginTop: 18, borderTop: '1px solid var(--border)' }}>
              <p style={sectionTitle}>More ways to add data</p>
              <p style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                Use the upload button in the top bar to import a statement, receipt, or CSV. Add properties and manual assets from the dashboard.
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
