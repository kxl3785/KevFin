import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

// After a transaction is categorized, let the user build ONE precise rule from
// composable conditions — merchant, exact amount, and/or description text. A
// transaction must match ALL ticked conditions (AND), so combining conditions
// narrows the result instead of the over-broad behaviour of separate (OR) rules.
// A live count shows exactly how many transactions the current rule covers.

export interface RuleCtx {
  merchant: string; payee: string; description?: string; amount: number; category: string;
}
interface RuleSpec { base?: string; contains?: string; amount?: number }
interface RuleCondition { key: string; kind: 'merchant' | 'amount' | 'text'; label: string; spec: RuleSpec; count: number }

// Merge the specs of the selected conditions into one (each kind owns a distinct
// field, and only one text condition can be active at a time).
function combinedSpec(conds: RuleCondition[], sel: Set<string>): RuleSpec {
  const spec: RuleSpec = {};
  for (const c of conds) if (sel.has(c.key)) Object.assign(spec, c.spec);
  return spec;
}

export default function RuleSuggestModal({ ctx, onClose, onApplied, zIndex = 4200 }: {
  ctx: RuleCtx | null;
  onClose: () => void;
  onApplied: (matched: number) => void;
  zIndex?: number;
}) {
  const [conds, setConds] = useState<RuleCondition[] | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  // Fetch the candidate conditions for this transaction.
  useEffect(() => {
    if (!ctx) { setConds(null); return; }
    let alive = true;
    setConds(null); setSel(new Set()); setCount(null);
    fetch('/api/budget/rule/suggest', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ctx),
    })
      .then(r => r.json())
      .then((d: { conditions: RuleCondition[] }) => {
        if (!alive) return;
        const list = d.conditions ?? [];
        // Always offer the future-apply option when a rule could carry forward: a
        // merchant condition matches this payee now AND every future transaction from
        // it, so it qualifies even at count 1. Text conditions qualify once they reach
        // beyond this single transaction. Amount alone is too broad to interrupt on.
        if (!list.some(c => c.kind === 'merchant' || (c.kind === 'text' && c.count >= 2))) { onClose(); return; }
        setConds(list);
        setSel(new Set(list.filter(c => c.kind === 'merchant').map(c => c.key))); // merchant pre-selected
      })
      .catch(() => { if (alive) onClose(); });
    return () => { alive = false; };
  }, [ctx]); // eslint-disable-line react-hooks/exhaustive-deps

  // Recompute the combined (AND) match count whenever the selection changes.
  useEffect(() => {
    if (!conds) return;
    const spec = combinedSpec(conds, sel);
    if (!('base' in spec) && !('contains' in spec) && !('amount' in spec)) { setCount(0); return; }
    let alive = true;
    setCount(null);
    fetch('/api/budget/rule/count', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(spec),
    })
      .then(r => r.json())
      .then((d: { count: number }) => { if (alive) setCount(d.count ?? 0); })
      .catch(() => { if (alive) setCount(null); });
    return () => { alive = false; };
  }, [sel, conds]);

  if (!ctx || !conds) return null;

  function toggle(c: RuleCondition) {
    setSel(s => {
      const n = new Set(s);
      if (n.has(c.key)) { n.delete(c.key); return n; }
      if (c.kind === 'text') for (const o of conds!) if (o.kind === 'text') n.delete(o.key); // one text max
      n.add(c.key);
      return n;
    });
  }

  async function apply() {
    const spec = combinedSpec(conds!, sel);
    if (!('base' in spec) && !('contains' in spec) && !('amount' in spec)) { onClose(); return; }
    setBusy(true);
    const res = await fetch('/api/budget/rule/smart', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rules: [{ ...spec, category: ctx!.category }] }),
    });
    const d = await res.json().catch(() => ({ matched: 0 }));
    setBusy(false);
    onApplied(d.matched ?? 0);
    onClose();
  }

  const nSel = sel.size;
  return createPortal(
    <div onClick={() => !busy && onClose()}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, width: 'min(460px, 94vw)', boxShadow: '0 24px 60px rgba(0,0,0,0.6)', padding: 24 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>Apply to similar transactions?</h3>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16, lineHeight: 1.5 }}>
          Categorized <strong style={{ color: 'var(--text)' }}>{ctx.payee}</strong> as{' '}
          <strong style={{ color: 'var(--text)' }}>{ctx.category}</strong>. Build a rule — a transaction must match{' '}
          <strong style={{ color: 'var(--text)' }}>all</strong> ticked conditions. It also categorizes matching <em>future</em> transactions.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
          {conds.map(c => {
            const on = sel.has(c.key);
            return (
              <div key={c.key} onClick={() => toggle(c)}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 10, cursor: 'pointer',
                  border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`, background: on ? 'var(--accent-dim)' : 'var(--bg)' }}>
                <span style={{ width: 16, height: 16, borderRadius: 4, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 11, color: '#fff', border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`, background: on ? 'var(--accent)' : 'transparent' }}>{on ? '✓' : ''}</span>
                <span style={{ flex: 1, fontSize: 13, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.label}</span>
                <span style={{ fontSize: 11, color: 'var(--muted)', flexShrink: 0 }}>{c.count} alone</span>
              </div>
            );
          })}
        </div>
        {/* Live combined (AND) reach of the rule being built. */}
        <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 18, textAlign: 'center' }}>
          {nSel === 0 ? 'Tick at least one condition' : <>This rule matches <strong style={{ color: 'var(--accent)' }}>{count == null ? '…' : count}</strong> transaction{count === 1 ? '' : 's'} now — plus future ones</>}
        </p>
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
