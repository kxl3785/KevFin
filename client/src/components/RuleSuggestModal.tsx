import { useEffect, useState } from 'react';
import { usePersistentState } from '../hooks/usePersistentState.ts';
import { createPortal } from 'react-dom';
import { rowProps, useEscapeKey } from '../lib/budgetUi.ts';
import { isEmptySpec, maskAmounts, worthOffering } from '../lib/ruleConditions.ts';
import { useRuleBuilder } from '../hooks/useRuleBuilder.ts';

// After a transaction is categorized, let the user build ONE precise rule from
// composable conditions — merchant, exact amount, and/or description text. A
// transaction must match ALL ticked conditions (AND), so combining conditions
// narrows the result instead of the over-broad behaviour of separate (OR) rules.
// A live count shows exactly how many transactions the current rule covers.
// The condition logic is shared with Quick review's rule chips (useRuleBuilder).

export interface RuleCtx {
  merchant: string; payee: string; description?: string; amount: number; category: string;
}

export default function RuleSuggestModal({ ctx, onClose, onApplied, zIndex = 4200 }: {
  ctx: RuleCtx | null;
  onClose: () => void;
  onApplied: (matched: number) => void;
  zIndex?: number;
}) {
  const rb = useRuleBuilder(ctx);
  // Privacy mode masks the amounts in condition labels. Read from the shared
  // setting, since two screens open this.
  const [privacy] = usePersistentState('mon.privacy', false);
  const [busy, setBusy] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const shows = rb.status === 'ready' && worthOffering(rb.conds);

  // Nothing worth offering (or the suggestion failed): close without interrupting.
  useEffect(() => {
    if (rb.status === 'error' || (rb.status === 'ready' && !worthOffering(rb.conds))) onClose();
  }, [rb.status, rb.conds]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setApplyError(null); }, [ctx]);

  // Esc = "Not now" (ignored mid-apply so the request isn't orphaned).
  useEscapeKey(onClose, !!ctx && shows && !busy);

  if (!ctx || !shows) return null;
  const { conds, sel, count } = rb;

  async function apply() {
    const spec = rb.spec;
    if (isEmptySpec(spec)) { onClose(); return; }
    setBusy(true);
    setApplyError(null);
    // The modal swallows backdrop clicks while busy, so a throw here must clear it
    // (and stay open with an error) or the user is locked in.
    try {
      const res = await fetch('/api/budget/rule/smart', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rules: [{ ...spec, category: ctx!.category }] }),
      });
      const d = await res.json().catch(() => ({ matched: 0 }));
      if (!res.ok) throw new Error(d?.error ?? `HTTP ${res.status}`);
      onApplied(d.matched ?? 0);
      onClose();
    } catch (e) {
      setApplyError(e instanceof Error ? e.message : 'Could not apply that rule.');
    } finally {
      setBusy(false);
    }
  }

  const nSel = sel.size;
  return createPortal(
    <div onClick={() => !busy && onClose()}
      style={{ position: 'fixed', inset: 0, background: 'var(--scrim)', zIndex, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="rule-suggest-title"
        ref={el => { if (el && !el.contains(document.activeElement)) el.focus(); }} tabIndex={-1}
        style={{ outline: 'none', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, width: 'min(460px, 94vw)', boxShadow: 'var(--shadow-modal)', padding: 24 }}>
        <h3 id="rule-suggest-title" style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>Apply to similar transactions?</h3>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16, lineHeight: 1.5 }}>
          Categorized <strong style={{ color: 'var(--text)' }}>{ctx.payee}</strong> as{' '}
          <strong style={{ color: 'var(--text)' }}>{ctx.category}</strong>. Build a rule — a transaction must match{' '}
          <strong style={{ color: 'var(--text)' }}>all</strong> ticked conditions. It also categorizes matching <em>future</em> transactions.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
          {conds.map(c => {
            const on = sel.has(c.key);
            return (
              <div key={c.key} {...rowProps(() => rb.toggle(c.key), { role: 'checkbox', checked: on })}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 10, cursor: 'pointer',
                  border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`, background: on ? 'var(--accent-dim)' : 'var(--bg)' }}>
                <span aria-hidden="true" style={{ width: 16, height: 16, borderRadius: 4, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 11, color: 'var(--on-accent)', border: `1px solid ${on ? 'var(--accent-fill)' : 'var(--border)'}`, background: on ? 'var(--accent-fill)' : 'transparent' }}>{on ? '✓' : ''}</span>
                <span style={{ flex: 1, fontSize: 13, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{maskAmounts(c.label, privacy)}</span>
                <span style={{ fontSize: 11, color: 'var(--muted)', flexShrink: 0 }}>{c.count} alone</span>
              </div>
            );
          })}
        </div>
        {/* Live combined (AND) reach of the rule being built. */}
        <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 18, textAlign: 'center' }}>
          {nSel === 0 ? 'Tick at least one condition' : <>This rule matches <strong style={{ color: 'var(--accent)' }}>{count == null ? '…' : count}</strong> transaction{count === 1 ? '' : 's'} now — plus future ones</>}
        </p>
        {applyError && <p style={{ fontSize: 12, color: 'var(--red)', marginBottom: 10, textAlign: 'center' }}>{applyError}</p>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn-ghost" disabled={busy} onClick={onClose} style={{ fontSize: 13, padding: '8px 14px' }}>Not now</button>
          <button className="btn-primary" disabled={busy || nSel === 0 || count == null} onClick={apply} style={{ fontSize: 13, padding: '8px 14px' }}>
            {busy ? 'Applying…' : count != null && nSel > 0 ? `Apply to ${count}` : 'Apply rule'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
