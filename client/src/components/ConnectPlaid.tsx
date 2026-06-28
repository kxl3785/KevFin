import { useCallback, useEffect, useState } from 'react';
import { usePlaidLink, type PlaidLinkOnSuccess } from 'react-plaid-link';

interface Props {
  onSuccess: () => void;
}

// The "+ Plaid" button. When Plaid credentials aren't set yet it opens an inline
// key-setup form (mirroring the SimpleFIN flow) instead of staying hidden; once
// the keys validate, it launches Plaid Link to connect an institution.
export default function ConnectPlaid({ onSuccess }: Props) {
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [linkToken, setLinkToken] = useState<string | null>(null);

  // Inline credential-setup form (shown only when Plaid isn't configured).
  const [setupOpen, setSetupOpen] = useState(false);
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [launchAfter, setLaunchAfter] = useState(false); // auto-open Link after keys save

  useEffect(() => {
    fetch('/api/plaid/status')
      .then(r => r.json())
      .then(d => setConfigured(Boolean(d.configured)))
      .catch(() => setConfigured(false))
      .finally(() => setStatusLoaded(true));
  }, []);

  // Fetch a fresh link token only once Plaid is known to be configured.
  useEffect(() => {
    if (!configured) return;
    fetch('/api/plaid/link-token', { method: 'POST' })
      .then(r => r.json())
      .then(d => setLinkToken(d.link_token ?? null))
      .catch(() => {});
  }, [configured]);

  const onPlaidSuccess = useCallback<PlaidLinkOnSuccess>(
    async (publicToken, metadata) => {
      await fetch('/api/plaid/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          public_token: publicToken,
          institution_name: metadata.institution?.name ?? 'Unknown',
        }),
      });
      onSuccess();
    },
    [onSuccess]
  );

  const { open, ready } = usePlaidLink({
    token: linkToken ?? '',
    onSuccess: onPlaidSuccess,
  });

  // After the keys are saved, auto-open Plaid Link as soon as the token is ready,
  // so it's one continuous flow: set up Plaid → connect an institution.
  useEffect(() => {
    if (launchAfter && configured && ready && linkToken) { setLaunchAfter(false); open(); }
  }, [launchAfter, configured, ready, linkToken, open]);

  async function saveKeys() {
    if (!clientId.trim() || !secret.trim()) { setError('Client ID and Secret are required.'); return; }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/config/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // KevFin only works against Plaid production — sandbox/development can't
        // link real institutions, so it's fixed here rather than offered.
        body: JSON.stringify({ plaid_client_id: clientId.trim(), plaid_secret: secret.trim(), plaid_env: 'production' }),
      });
      const d = await res.json().catch(() => ({} as { error?: string }));
      if (!res.ok) { setError(d.error || 'Plaid rejected those credentials.'); return; }
      setSecret(''); setClientId(''); setSetupOpen(false);
      setConfigured(true);   // triggers the link-token fetch
      setLaunchAfter(true);  // then auto-opens Plaid Link
    } finally {
      setSaving(false);
    }
  }

  if (!statusLoaded) return null; // brief: avoid showing the wrong state on first paint

  // Not configured → the button reveals the credential form.
  if (!configured) {
    if (!setupOpen) {
      return (
        <button className="btn-primary" onClick={() => setSetupOpen(true)}
          title="Set up Plaid to link banks & brokerages">+ Plaid</button>
      );
    }
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end' }}>
        <input value={clientId} onChange={e => setClientId(e.target.value)}
          placeholder="Plaid Client ID" style={{ width: 240 }} autoFocus autoComplete="off" spellCheck={false}
          onKeyDown={e => { if (e.key === 'Escape') setSetupOpen(false); }} />
        <input value={secret} onChange={e => setSecret(e.target.value)} type="password"
          placeholder="Plaid Secret" style={{ width: 240 }} autoComplete="off" spellCheck={false}
          onKeyDown={e => { if (e.key === 'Enter') saveKeys(); if (e.key === 'Escape') setSetupOpen(false); }} />
        <p style={{ fontSize: 11, color: 'var(--muted)', width: 240, margin: 0, textAlign: 'left' }}>
          Uses your Plaid <strong>production</strong> keys.
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn-ghost" onClick={() => { setSetupOpen(false); setError(null); }}>Cancel</button>
          <button className="btn-primary" onClick={saveKeys} disabled={saving}>
            {saving ? 'Validating…' : 'Save keys'}
          </button>
        </div>
        <a href="https://dashboard.plaid.com/developers/keys" target="_blank" rel="noreferrer"
          style={{ fontSize: 11, color: 'var(--accent)' }}>Get your Plaid keys →</a>
        {error && <p style={{ color: 'var(--red)', fontSize: 12, maxWidth: 240 }}>{error}</p>}
      </div>
    );
  }

  // Configured → the button launches Plaid Link.
  return (
    <button
      className="btn-primary"
      onClick={() => open()}
      disabled={!ready || !linkToken}
      title="Connect a bank or brokerage via Plaid"
    >
      + Plaid
    </button>
  );
}
