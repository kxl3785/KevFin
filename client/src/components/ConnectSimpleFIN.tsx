import { useState } from 'react';

interface Props {
  onSuccess: () => void;
}

export default function ConnectSimpleFIN({ onSuccess }: Props) {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!token.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/simplefin/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ setup_token: token.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to connect');
      setToken('');
      setOpen(false);
      onSuccess();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to connect');
    } finally {
      setLoading(false);
    }
  }

  const SIMPLEFIN_ACCOUNT_URL = 'https://beta-bridge.simplefin.org/my-account';

  if (!open) {
    return (
      <button
        className="btn-primary"
        onClick={() => {
          // Open SimpleFIN to create/manage a setup token, then show the paste form.
          window.open(SIMPLEFIN_ACCOUNT_URL, '_blank', 'noopener');
          setOpen(true);
        }}
      >+ SimpleFIN</button>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end' }}>
      <input
        value={token}
        onChange={e => setToken(e.target.value)}
        placeholder="Paste SimpleFIN setup token"
        style={{ width: 240 }}
        autoFocus
        onKeyDown={e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') setOpen(false); }}
      />
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn-ghost" onClick={() => { setOpen(false); setError(null); }}>Cancel</button>
        <button className="btn-primary" onClick={submit} disabled={loading}>
          {loading ? 'Connecting…' : 'Connect'}
        </button>
      </div>
      <a href={SIMPLEFIN_ACCOUNT_URL} target="_blank" rel="noreferrer"
        style={{ fontSize: 11, color: 'var(--accent)' }}>Get a setup token →</a>
      {error && <p style={{ color: 'var(--red)', fontSize: 12, maxWidth: 240 }}>{error}</p>}
    </div>
  );
}
