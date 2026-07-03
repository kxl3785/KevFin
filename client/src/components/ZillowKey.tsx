import { useEffect, useState } from 'react';

interface ProviderStatus { set: boolean; hint: string | null }

const linkBtn: React.CSSProperties = {
  font: 'inherit', color: 'var(--accent)', background: 'none', border: 'none', padding: 0, cursor: 'pointer',
};

// Property-value API keys. KevFin fetches the current Zestimate (and, via ZHVI,
// real-estate history) through a licensed Zillow API — Zillow's own pages are
// behind PerimeterX, so there's no free scrape path. Two providers are supported
// with automatic fallback: OpenWeb Ninja is tried first, APILLOW second, so
// lookups survive OpenWeb Ninja's monthly plan limit. Without any key a property
// is still added but has no auto value; the user can type one by hand. This
// control lives under the Add Property form and stays collapsed once set.
export default function ZillowKey() {
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [own, setOwn] = useState<ProviderStatus>({ set: false, hint: null });
  const [apillow, setApillow] = useState<ProviderStatus>({ set: false, hint: null });
  const [open, setOpen] = useState(false);

  function loadStatus() {
    return fetch('/api/config/keys')
      .then(r => r.json())
      .then(d => {
        setOwn({ set: Boolean(d?.openwebninja?.set), hint: d?.openwebninja?.hint ?? null });
        setApillow({ set: Boolean(d?.apillow?.set), hint: d?.apillow?.hint ?? null });
      })
      .catch(() => {})
      .finally(() => setStatusLoaded(true));
  }

  useEffect(() => { loadStatus(); }, []);

  if (!statusLoaded) return null; // avoid flashing the wrong state on first paint

  const muted: React.CSSProperties = { fontSize: 12, color: 'var(--muted)', margin: 0 };
  const anySet = own.set || apillow.set;

  if (!open) {
    return (
      <p style={{ ...muted, marginTop: 10 }}>
        {anySet ? (
          <>Property values: OpenWeb Ninja {own.set ? own.hint : '—'}, APILLOW fallback {apillow.set ? apillow.hint : '—'}.{' '}</>
        ) : (
          <>No property-value API key — values won't auto-fill (enter them by hand).{' '}</>
        )}
        <button className="btn-link" onClick={() => setOpen(true)} style={linkBtn}>
          {anySet ? 'Manage keys' : 'Add a key →'}
        </button>
      </p>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 10 }}>
      <p style={{ ...muted, maxWidth: 340 }}>
        KevFin fetches property values (and history) from a licensed Zillow API. It
        tries <strong>OpenWeb Ninja</strong> first, then falls back to{' '}
        <strong>APILLOW</strong> if that's missing or over its plan limit. Set
        either or both.
      </p>

      <ProviderRow
        label="OpenWeb Ninja"
        endpoint="/api/config/openwebninja"
        status={own}
        getKeyUrl="https://www.openwebninja.com"
        getKeyLabel="Get an OpenWeb Ninja key →"
        onSaved={loadStatus}
      />
      <ProviderRow
        label="APILLOW (fallback)"
        endpoint="/api/config/apillow"
        status={apillow}
        getKeyUrl="https://apillow.co"
        getKeyLabel="Get an APILLOW key →"
        onSaved={loadStatus}
      />

      <button className="btn-ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setOpen(false)}>
        Done
      </button>
    </div>
  );
}

interface RowProps {
  label: string;
  endpoint: string;
  status: ProviderStatus;
  getKeyUrl: string;
  getKeyLabel: string;
  onSaved: () => Promise<void> | void;
}

function ProviderRow({ label, endpoint, status, getKeyUrl, getKeyLabel, onSaved }: RowProps) {
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!key.trim()) { setError('Paste your key.'); return; }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: key.trim() }),
      });
      const d = await res.json().catch(() => ({} as { error?: string }));
      if (!res.ok) { setError(d.error || 'Could not save the key.'); return; }
      setKey('');
      await onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <label style={{ fontSize: 12, fontWeight: 600 }}>
        {label}
        {status.set && <span style={{ fontWeight: 400, color: 'var(--muted)' }}> · saved {status.hint}</span>}
      </label>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          value={key}
          onChange={e => setKey(e.target.value)}
          type="password"
          placeholder={status.set ? 'Replace key' : 'Paste key'}
          style={{ width: 240 }}
          autoComplete="off"
          spellCheck={false}
          onKeyDown={e => { if (e.key === 'Enter') save(); }}
        />
        <button className="btn-primary" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
      <a href={getKeyUrl} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: 'var(--accent)' }}>
        {getKeyLabel}
      </a>
      {error && <p style={{ color: 'var(--red)', fontSize: 12 }}>{error}</p>}
    </div>
  );
}
