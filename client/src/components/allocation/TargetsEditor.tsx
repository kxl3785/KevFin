import { useEffect, useId, useRef, useState } from 'react';
import { ASSET_CLASS_META, type AssetClassKey, type RiskProfile } from '../../lib/riskProfiles.ts';
import { customTotal, parseTargetInput, totalMessage } from '../../lib/allocationTargets.ts';
import { useIsMobile } from '../../hooks/useIsMobile.ts';

// Editor for the user's own target per asset class. Shows the running total as
// you type and only saves when the targets add up to exactly 100%.

type Custom = Partial<Record<AssetClassKey, number>>;

const toText = (v: number | undefined) => (v != null && v > 0 ? String(v) : '');

export default function TargetsEditor({ initial, riskProfile, onSave, onCancel }: {
  initial: Custom;
  riskProfile: RiskProfile | null;
  onSave: (custom: Custom) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState<Record<AssetClassKey, string>>(
    () => Object.fromEntries(ASSET_CLASS_META.map(m => [m.key, toText(initial[m.key])])) as Record<AssetClassKey, string>,
  );
  const baseId = useId();
  const isMobile = useIsMobile();
  // The button that opened the editor unmounts on the same click, so move focus
  // to the first target rather than letting it fall to the page.
  const firstInput = useRef<HTMLInputElement>(null);
  useEffect(() => { firstInput.current?.focus(); }, []);

  const parsed = ASSET_CLASS_META.map(m => ({ key: m.key, r: parseTargetInput(text[m.key]) }));
  const anyError = parsed.some(p => 'error' in p.r);
  const values: Custom = {};
  for (const p of parsed) if ('value' in p.r && p.r.value > 0) values[p.key] = p.r.value;
  const total = customTotal(values);
  const msg = totalMessage(total);
  const canSave = msg.complete && !anyError;

  const fill = (src: Custom) => setText(Object.fromEntries(ASSET_CLASS_META.map(m => [m.key, toText(src[m.key])])) as Record<AssetClassKey, string>);

  return (
    <form
      onSubmit={e => { e.preventDefault(); if (canSave) onSave(values); }}
      onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }}
      aria-labelledby={`${baseId}-title`}
      style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 10, padding: 16, marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <p id={`${baseId}-title`} style={{ fontSize: 14, fontWeight: 600 }}>Your own targets</p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {riskProfile && (
            <button type="button" className="btn-ghost btn-sm" onClick={() => fill(riskProfile.model)}>
              Start from {riskProfile.name}
            </button>
          )}
          <button type="button" className="btn-ghost btn-sm" onClick={() => fill({})}>Clear all</button>
        </div>
      </div>
      <p style={{ fontSize: 12, color: 'var(--muted)', margin: '2px 0 14px', lineHeight: 1.5, maxWidth: '72ch' }}>
        The share of your investments you'd like in each kind, in percent. They need to add up to exactly 100%.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(2, minmax(0, 1fr))', gap: '8px 40px', maxWidth: 640 }}>
        {ASSET_CLASS_META.map((m, idx) => {
          const id = `${baseId}-${m.key.replace(/\s+/g, '-')}`;
          const p = parsed.find(x => x.key === m.key)!.r;
          const err = 'error' in p ? p.error : null;
          return (
            <div key={m.key}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 34 }}>
                <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 2, background: m.color, flexShrink: 0 }} />
                <label htmlFor={id} style={{ flex: 1, minWidth: 0, fontSize: 13 }}>{m.label}</label>
                <input id={id} ref={idx === 0 ? firstInput : undefined} aria-label={`${m.label} target, in percent`}
                  value={text[m.key]} inputMode="decimal" placeholder="0" autoComplete="off"
                  onChange={e => setText(t => ({ ...t, [m.key]: e.target.value }))}
                  aria-invalid={!!err} aria-describedby={err ? `${id}-err` : undefined}
                  style={{ width: 72, padding: '6px 8px', fontSize: 13, textAlign: 'right', fontVariantNumeric: 'tabular-nums', background: 'var(--surface)', border: `1px solid ${err ? 'var(--red)' : 'var(--border)'}`, borderRadius: 6, color: 'var(--text)' }} />
                <span aria-hidden="true" style={{ fontSize: 12, color: 'var(--muted)', width: 12 }}>%</span>
              </div>
              {err && <p id={`${id}-err`} style={{ fontSize: 12, color: 'var(--red)', textAlign: 'right', marginTop: 2 }}>{err}</p>}
            </div>
          );
        })}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)', flexWrap: 'wrap' }}>
        <p aria-live="polite" style={{ fontSize: 13, display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 15, fontVariantNumeric: 'tabular-nums' }}>Total {total}%</strong>
          <span style={{ fontSize: 12, color: msg.complete ? 'var(--green)' : 'var(--amber)' }}>
            {msg.complete ? '✓ ' : ''}{msg.text}
          </span>
        </p>
        <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
          <button type="button" className="btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
          <button type="submit" className="btn-primary btn-sm" disabled={!canSave}
            title={canSave ? undefined : 'Targets need to add up to exactly 100%'}>Save targets</button>
        </div>
      </div>
    </form>
  );
}
