import { useEffect, useId, useRef, useState } from 'react';
import { formatMix, mixToInput, parseMixInput, type MixPart } from '../../lib/holdingProfile.ts';

// Inline editor for what a holding with no public data tracks: a 401(k)
// collective trust, a 529 portfolio, an HSA plan fund. The user types one
// ticker ("VFFVX") or a mix from the plan's fact sheet ("VTI 60, BND 40");
// it replaces KevFin's built-in stand-in guesses for that holding's breakdown
// and price history. Fees are deliberately NOT taken from it: an index fund's
// fee isn't the plan's fee (the fee check-up takes the user's own figure).
// Saved via PUT /api/allocation/holding-profile, keyed by the holding's
// profileId (its ticker as the feed reports it, or its name when untickered).

const SR_ONLY: React.CSSProperties = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' };

// PUT JSON and surface failures (fetch only rejects on network errors).
async function putJson(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); if (j?.error) msg = String(j.error); } catch { /* non-JSON body */ }
    throw new Error(msg);
  }
}

export default function HoldingProfileEditor({ id, name, mix, onSaved }: {
  id: string;
  name: string;
  mix: MixPart[] | null;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputId = useId();
  const hintId = `${inputId}-hint`;
  const errId = `${inputId}-err`;
  // Return keyboard focus to the trigger when the editor closes (save, Enter,
  // Escape or Cancel); otherwise it falls back to the page top.
  const trigger = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (!editing && wasEditing.current) trigger.current?.focus();
    wasEditing.current = editing;
  }, [editing]);

  const parsed = parseMixInput(text);
  // Don't nag about an empty box; just keep Save disabled until it reads.
  const showError = text.trim() !== '' && 'error' in parsed;

  function open() {
    setText(mix ? mixToInput(mix) : '');
    setErr(null);
    setEditing(true);
  }

  async function save(clear = false) {
    if (!clear && 'error' in parsed) return;
    setSaving(true); setErr(null);
    try {
      await putJson('/api/allocation/holding-profile', { id, mix: clear ? null : (parsed as { mix: MixPart[] }).mix });
      onSaved();
      setEditing(false);
    } catch (e) {
      setErr(`Couldn't save: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return mix ? (
      <button type="button" ref={trigger} onClick={open} title="What this holding tracks, from your description · click to change"
        aria-label={`Tracks ${formatMix(mix)}, from your description. Change what ${name} tracks`}
        style={{ background: 'transparent', border: 'none', color: 'var(--text)', fontSize: 12, padding: '2px 0', cursor: 'pointer', borderBottom: '1px dashed var(--border)', borderRadius: 0, fontVariantNumeric: 'tabular-nums', textAlign: 'left' }}>
        <span style={{ color: 'var(--muted)', marginRight: 6 }}>Tracks</span>{formatMix(mix)}
      </button>
    ) : (
      <button type="button" ref={trigger} onClick={open}
        aria-label={`Describe what ${name} tracks`}
        style={{ background: 'transparent', border: 'none', color: 'var(--accent)', fontSize: 12, padding: '4px 0', cursor: 'pointer', textAlign: 'left' }}>
        Describe what this tracks
      </button>
    );
  }

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
      <label htmlFor={inputId} style={SR_ONLY}>What {name} tracks: a ticker, or tickers with percentages</label>
      <input id={inputId} value={text} onChange={e => setText(e.target.value)} autoFocus
        autoCapitalize="characters" autoComplete="off" spellCheck={false}
        placeholder="e.g. VFFVX, or VTI 60, BND 40"
        aria-invalid={showError} aria-describedby={showError ? `${errId} ${hintId}` : hintId}
        onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
        style={{ flex: '1 1 200px', minWidth: 0, maxWidth: 320, padding: '5px 8px', fontSize: 13, background: 'var(--bg)', border: `1px solid ${showError ? 'var(--red)' : 'var(--border)'}`, borderRadius: 6, color: 'var(--text)' }} />
      <button type="button" className="btn-primary btn-sm" onClick={() => save()} disabled={saving || 'error' in parsed}>{saving ? 'Saving…' : 'Save'}</button>
      {mix && (
        <button type="button" className="btn-ghost btn-sm" onClick={() => save(true)} disabled={saving}
          title="Remove your description and go back to KevFin's own estimate">Clear</button>
      )}
      <button type="button" className="btn-ghost btn-sm" onClick={() => setEditing(false)} disabled={saving}>Cancel</button>
      {showError && <span id={errId} style={{ flexBasis: '100%', fontSize: 12, color: 'var(--red)' }}>{(parsed as { error: string }).error}</span>}
      {err && <span role="alert" style={{ flexBasis: '100%', fontSize: 12, color: 'var(--red)' }}>{err}</span>}
      <span id={hintId} style={{ flexBasis: '100%', fontSize: 12, color: 'var(--muted)' }}>
        From your plan's fact sheet. Used for this holding's breakdown and price history.
        {'mix' in parsed && parsed.mix.length > 1 && <> Reads as {formatMix(parsed.mix)}.</>}
      </span>
    </div>
  );
}
