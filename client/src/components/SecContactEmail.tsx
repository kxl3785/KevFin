import { useId, useState } from 'react';
import { useApi } from '../hooks/useApi.ts';
import { isPlausibleEmail } from '../lib/secContact.ts';

// The one place the SEC contact email is edited — used by the Country exposure
// notice (Allocation) and the Setup menu row, so validation, saving and the
// privacy wording can't drift apart.
//
// SEC asks automated tools to identify themselves. KevFin has no built-in
// identity: it declares "KevFin <email>" to sec.gov (and only sec.gov) when it
// downloads fund holdings, and makes no SEC requests until this is set.
export const SEC_PRIVACY_NOTE =
  'SEC asks automated tools to identify themselves. KevFin sends this only to sec.gov, with fund-holdings requests.';

interface Props {
  initialEmail?: string | null;
  /** Called after the server accepted the change; awaited so the caller can refetch. */
  onSaved: (email: string | null) => Promise<unknown> | void;
  /** Shown (with a spinner) while onSaved is running, e.g. the slow first holdings download. */
  followUpLabel?: string;
  /** Offer a "Remove" button when an email is already saved. */
  allowClear?: boolean;
  autoFocus?: boolean;
}

export default function SecContactEmail({ initialEmail, onSaved, followUpLabel = 'Updating…', allowClear, autoFocus }: Props) {
  const id = useId();
  const [value, setValue] = useState(initialEmail ?? '');
  const [phase, setPhase] = useState<'idle' | 'saving' | 'following'>('idle');
  const [error, setError] = useState<string | null>(null);
  const busy = phase !== 'idle';

  async function submit(email: string) {
    setError(null);
    if (email && !isPlausibleEmail(email)) { setError('Enter a valid email address.'); return; }
    setPhase('saving');
    try {
      const res = await fetch('/api/config/sec-contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const d = await res.json().catch(() => ({} as { error?: string }));
      if (!res.ok) { setError(d.error || 'Could not save the email.'); return; }
      const saved: string | null = d?.sec?.email ?? null;
      setValue(saved ?? '');
      setPhase('following');
      await onSaved(saved);
    } catch {
      setError('Could not reach KevFin to save the email.');
    } finally {
      setPhase('idle');
    }
  }

  return (
    <form onSubmit={e => { e.preventDefault(); if (!busy) submit(value.trim()); }}
      style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          id={id}
          type="email"
          aria-label="SEC contact email"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-err` : undefined}
          value={value}
          onChange={e => setValue(e.target.value)}
          placeholder="you@example.com"
          autoComplete="email"
          spellCheck={false}
          autoFocus={autoFocus}
          disabled={busy}
          style={{ flex: '1 1 200px', maxWidth: 280, width: 'auto', fontSize: 13, padding: '6px 8px' }}
        />
        <button type="submit" className="btn-primary" disabled={busy || !value.trim()} style={{ fontSize: 13, padding: '6px 14px' }}>
          {phase === 'saving' ? 'Saving…' : 'Save'}
        </button>
        {allowClear && initialEmail && (
          <button type="button" className="btn-ghost" disabled={busy} onClick={() => submit('')} style={{ fontSize: 13, padding: '6px 12px' }}>
            Remove
          </button>
        )}
      </div>
      {phase === 'following' && (
        <p role="status" style={{ margin: 0, fontSize: 12, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <svg className="spin" viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="var(--muted)"
            strokeWidth={2.5} strokeLinecap="round" aria-hidden="true"><path d="M12 3a9 9 0 0 1 9 9" /></svg>
          {followUpLabel}
        </p>
      )}
      {error && <p id={`${id}-err`} role="alert" style={{ margin: 0, fontSize: 12, color: 'var(--red)' }}>{error}</p>}
    </form>
  );
}

// The compact notice shown in the Country / Region Exposure card when fund
// holdings couldn't be fetched for a reason the user can fix here. 'blocked'
// pre-fills the saved email so it can be corrected.
export function SecLookThroughNotice({ issue, detail, onSaved }: {
  issue: 'no-contact' | 'blocked';
  detail: string;
  onSaved: () => Promise<unknown> | void;
}) {
  const { data: keys } = useApi<{ sec?: { email: string | null } }>('/api/config/keys');
  const saved = keys?.sec?.email ?? null;
  return (
    <div role="region" aria-label="Fund holdings need attention" style={{
      border: '1px solid var(--border)', background: 'var(--surface-2)', borderRadius: 8,
      padding: '10px 12px', marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.45 }}>
        {issue === 'no-contact' ? (
          <><strong>Fund holdings need a contact email.</strong>{' '}
            <span style={{ color: 'var(--muted)' }}>{SEC_PRIVACY_NOTE} Until it's set, funds fall back to top-10 holdings and name-based guesses.</span></>
        ) : (
          <><strong>SEC is declining fund-holdings requests.</strong>{' '}
            <span style={{ color: 'var(--muted)' }}>{detail} Check the contact email below (use a real address you read), then save to retry. {SEC_PRIVACY_NOTE}</span></>
        )}
      </p>
      {/* key: remount once the saved email loads so the field is pre-filled */}
      <SecContactEmail key={saved ?? ''} initialEmail={saved} onSaved={onSaved}
        followUpLabel="Downloading fund holdings… (the first time can take a minute)" />
    </div>
  );
}
