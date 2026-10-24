import { useMemo, useState } from 'react';
import { useApi } from '../hooks/useApi.ts';
import CategoryPicker, { type PickerGroup } from './CategoryPicker.tsx';
import { fmtMoney, fmtDate } from '../lib/format.ts';
import {
  ruleStatus, filterRules, filterAuto, categoryOptions, maskMoney, plural, PRECEDENCE_LINE, SHADOWED_TEXT,
  type RulesReviewData, type RuleReview, type AutoMerchant, type SignRuleReview,
} from '../lib/rulesReview.ts';

// Review of every categorization rule: what each one actually decides, which are
// dead weight (never applies / unused), merchants only categorized by the
// built-in guess (confirm or correct them), and sign reversals. Data comes from
// GET /api/budget/rules; edits go through PATCH/DELETE /api/budget/rules/:id and
// the existing PUT /api/budget/rule.

const AUTO_PREVIEW = 50;

const card: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px', marginTop: 16 };
const heading: React.CSSProperties = { fontSize: 14, fontWeight: 600, margin: 0 };
const muted: React.CSSProperties = { color: 'var(--muted)', fontSize: 12 };
const rowLine: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 12px', padding: '8px 0' };
const listReset: React.CSSProperties = { listStyle: 'none', margin: 0, padding: 0 };

const pill = (color: string): React.CSSProperties => ({
  display: 'inline-block', fontSize: 11, lineHeight: 1.4, padding: '2px 8px', borderRadius: 999,
  border: `1px solid ${color}`, color, maxWidth: '100%',
});

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" />
    </svg>
  );
}

export default function RulesManager({ privacy, cats, groups, onChanged }: {
  privacy: boolean; cats: string[]; groups: PickerGroup[]; onChanged: () => void;
}) {
  const { data, loading, error, refetch } = useApi<RulesReviewData>('/api/budget/rules');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [showAllAuto, setShowAllAuto] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const [confirmId, setConfirmId] = useState<number | null>(null); // rule awaiting delete confirmation
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const money = (n: number, cents = false) => maskMoney(n, privacy, v => fmtMoney(v, { cents }));

  // Run a mutation, then refresh the list and tell the host page its data changed.
  async function mutate(key: string, url: string, init: RequestInit, failMsg: string) {
    setBusy(key); setActionError(null);
    try {
      const res = await fetch(url, init);
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error ?? failMsg);
      }
      await refetch();
      onChanged();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : failMsg);
    } finally {
      setBusy(null);
    }
  }
  const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  const changeRuleCategory = (r: RuleReview, cat: string) =>
    mutate(`rule-${r.id}`, `/api/budget/rules/${r.id}`, json('PATCH', { category: cat }), 'Could not change the rule');
  const deleteRule = async (id: number) => {
    setConfirmId(null);
    await mutate(`rule-${id}`, `/api/budget/rules/${id}`, { method: 'DELETE' }, 'Could not delete the rule');
  };
  // Confirm / change an auto-categorized merchant: pin it with an exact-merchant rule.
  const pinMerchant = (a: AutoMerchant, cat: string) =>
    mutate(`auto-${a.merchant}`, '/api/budget/rule', json('PUT', { merchant: a.merchant, category: cat, scope: 'one' }), 'Could not save the rule');

  const rules = useMemo(() => (data ? filterRules(data.rules, query, category) : []), [data, query, category]);
  const autoAll = useMemo(() => (data ? filterAuto(data.auto, query, category) : []), [data, query, category]);
  const autoShown = showAllAuto ? autoAll : autoAll.slice(0, AUTO_PREVIEW);
  const catOptions = useMemo(() => (data ? categoryOptions(data) : []), [data]);

  if (loading && !data) return <div style={{ ...muted, padding: '24px 0' }} role="status">Loading rules…</div>;
  if (error && !data) {
    return (
      <div style={{ ...card, color: 'var(--red)', fontSize: 13 }} role="alert">
        Could not load rules ({error}).{' '}
        <button className="btn-ghost btn-sm" onClick={() => refetch()}>Retry</button>
      </div>
    );
  }
  if (!data) return null;

  const filtering = query.trim() !== '' || category !== '';

  return (
    <div>
      <p style={{ ...muted, margin: '4px 0 0' }}>{PRECEDENCE_LINE}</p>

      {actionError && (
        <div role="alert" style={{ marginTop: 12, padding: '8px 12px', borderRadius: 8, border: '1px solid var(--red)', color: 'var(--red)', fontSize: 13, display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
          <span>{actionError}</span>
          <button className="btn-ghost btn-sm" onClick={() => setActionError(null)} aria-label="Dismiss error">Dismiss</button>
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
        <input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search merchants or rules…"
          aria-label="Search rules" style={{ flex: '1 1 200px', width: 'auto', minWidth: 0 }} />
        <select value={category} onChange={e => setCategory(e.target.value)} aria-label="Filter by category"
          style={{ flex: '0 1 200px', minWidth: 0, background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px', fontSize: 14 }}>
          <option value="">All categories</option>
          {catOptions.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {/* Your rules */}
      <section style={card} aria-labelledby="rules-h">
        <h3 id="rules-h" style={heading}>Your rules <span style={muted}>({rules.length}{filtering ? ` of ${data.rules.length}` : ''})</span></h3>
        {rules.length === 0 ? (
          <p style={{ ...muted, padding: '12px 0 4px', fontSize: 13 }}>
            {data.rules.length === 0 ? 'No rules yet — categorize a transaction to create one.' : 'No rules match your search.'}
          </p>
        ) : (
          <ul style={listReset}>
            {rules.map((r, i) => (
              <RuleItem key={r.id} rule={r} first={i === 0} open={openId === r.id} confirming={confirmId === r.id}
                busy={busy === `rule-${r.id}`} money={money} cats={cats} groups={groups}
                onToggle={() => setOpenId(openId === r.id ? null : r.id)}
                onChangeCategory={c => changeRuleCategory(r, c)}
                onAskDelete={() => setConfirmId(r.id)} onCancelDelete={() => setConfirmId(null)} onDelete={() => deleteRule(r.id)} />
            ))}
          </ul>
        )}
      </section>

      {/* Merchants only categorized by the built-in guess */}
      <section style={card} aria-labelledby="auto-h">
        <h3 id="auto-h" style={heading}>Auto-categorized merchants <span style={muted}>({autoAll.length})</span></h3>
        <p style={{ ...muted, margin: '4px 0 0' }}>Guessed by the built-in categorizer — confirm a guess to pin it as a rule, or change it.</p>
        {autoAll.length === 0 ? (
          <p style={{ ...muted, padding: '12px 0 4px', fontSize: 13 }}>
            {data.auto.length === 0 ? 'Every merchant is covered by a rule.' : 'No merchants match your search.'}
          </p>
        ) : (
          <ul style={listReset}>
            {autoShown.map((a, i) => (
              <li key={a.merchant} style={{ ...rowLine, borderTop: i ? '1px solid var(--border)' : 'none' }}>
                <span style={{ flex: '1 1 160px', minWidth: 0, fontSize: 13, overflowWrap: 'anywhere' }}>{a.payee}</span>
                <span style={{ fontSize: 13 }}><span aria-hidden="true" style={{ color: 'var(--muted)' }}>→ </span>{a.category}</span>
                <span style={muted}>{plural(a.count, 'txn')} · {money(a.total)} · last {fmtDate(a.lastDate)}</span>
                <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <button className="btn-ghost btn-sm" disabled={busy === `auto-${a.merchant}`}
                    aria-label={`Confirm ${a.payee} as ${a.category}`} onClick={() => pinMerchant(a, a.category)}>Confirm</button>
                  <CategoryPicker value="" placeholder="Change…" compact options={cats} groups={groups}
                    onChange={c => pinMerchant(a, c)} />
                </span>
              </li>
            ))}
          </ul>
        )}
        {autoAll.length > AUTO_PREVIEW && (
          <button className="btn-ghost btn-sm" style={{ marginTop: 8 }} aria-expanded={showAllAuto} onClick={() => setShowAllAuto(v => !v)}>
            {showAllAuto ? `Show top ${AUTO_PREVIEW}` : `Show all ${autoAll.length}`}
          </button>
        )}
      </section>

      {/* Sign reversals */}
      {data.signRules.length > 0 && (
        <section style={card} aria-labelledby="sign-h">
          <h3 id="sign-h" style={heading}>Sign reversals <span style={muted}>({data.signRules.length})</span></h3>
          <ul style={listReset}>
            {data.signRules.map((s: SignRuleReview, i) => (
              <li key={s.id} style={{ ...rowLine, borderTop: i ? '1px solid var(--border)' : 'none', justifyContent: 'space-between' }}>
                <span style={{ flex: '1 1 200px', minWidth: 0, fontSize: 13, overflowWrap: 'anywhere' }}>{s.description}</span>
                <button className="btn-ghost btn-sm" disabled={busy === `rule-${s.id}`} aria-label={`Remove sign reversal: ${s.description}`}
                  onClick={() => mutate(`rule-${s.id}`, `/api/budget/rules/${s.id}`, { method: 'DELETE' }, 'Could not remove the rule')}>Remove</button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function RuleItem({ rule: r, first, open, confirming, busy, money, cats, groups, onToggle, onChangeCategory, onAskDelete, onCancelDelete, onDelete }: {
  rule: RuleReview; first: boolean; open: boolean; confirming: boolean; busy: boolean;
  money: (n: number, cents?: boolean) => string; cats: string[]; groups: PickerGroup[];
  onToggle: () => void; onChangeCategory: (c: string) => void;
  onAskDelete: () => void; onCancelDelete: () => void; onDelete: () => void;
}) {
  const status = ruleStatus(r);
  const panelId = `rule-samples-${r.id}`;
  return (
    <li style={{ borderTop: first ? 'none' : '1px solid var(--border)', opacity: busy ? 0.6 : 1 }}>
      <div style={rowLine}>
        <button onClick={onToggle} aria-expanded={open} aria-controls={panelId}
          style={{ flex: '1 1 220px', minWidth: 0, display: 'flex', gap: 8, alignItems: 'baseline', textAlign: 'left', background: 'transparent', color: 'var(--text)', padding: '4px 0', fontSize: 13, fontWeight: 500 }}>
          <span aria-hidden="true" style={{ color: 'var(--muted)', width: 10, flexShrink: 0 }}>{open ? '▾' : '▸'}</span>
          <span style={{ overflowWrap: 'anywhere' }}>{r.description}</span>
        </button>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span aria-hidden="true" style={{ color: 'var(--muted)' }}>→</span>
          <CategoryPicker value={r.category} compact options={cats} groups={groups} onChange={c => { if (c !== r.category) onChangeCategory(c); }} />
        </span>
        <span style={{ fontSize: 12 }}>decides {r.matched} · {money(r.total)}</span>
        {r.lastMatched && <span style={muted}>last {fmtDate(r.lastMatched)}</span>}
        {status === 'shadowed' && <span style={pill('var(--amber)')}>{SHADOWED_TEXT}</span>}
        {status === 'unused' && <span style={pill('var(--muted)')}>unused</span>}
        {confirming ? (
          <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ fontSize: 12 }}>Delete rule?</span>
            <button className="btn-danger btn-sm" onClick={onDelete}>Delete</button>
            <button className="btn-ghost btn-sm" onClick={onCancelDelete}>Cancel</button>
          </span>
        ) : (
          <button className="btn-ghost btn-sm" onClick={onAskDelete} disabled={busy} aria-label={`Delete rule: ${r.description}`} title="Delete rule"
            style={{ display: 'inline-flex', alignItems: 'center', color: 'var(--muted)' }}>
            <TrashIcon />
          </button>
        )}
      </div>
      {open && (
        <div id={panelId} style={{ padding: '0 0 10px 18px', fontSize: 12 }}>
          {r.samples.length === 0 ? (
            <p style={muted}>No transactions are decided by this rule.</p>
          ) : (
            <ul style={listReset}>
              {r.samples.map((s, i) => (
                <li key={i} style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 12px', padding: '3px 0' }}>
                  <span style={{ ...muted, minWidth: 84 }}>{fmtDate(s.date)}</span>
                  <span style={{ flex: '1 1 140px', minWidth: 0, overflowWrap: 'anywhere' }}>{s.payee}</span>
                  <span style={muted}>{s.account}</span>
                  <span style={{ color: s.amount > 0 ? 'var(--green)' : 'var(--text)' }}>{money(s.amount, true)}</span>
                </li>
              ))}
            </ul>
          )}
          {r.matched > 0 && r.shadowed > 0 && (
            <p style={{ ...muted, marginTop: 4 }}>Also matches {plural(r.shadowed, 'transaction')} that a higher-priority rule decides.</p>
          )}
          <p style={{ ...muted, marginTop: 4 }}>Created {fmtDate(r.createdAt.slice(0, 10))}</p>
        </div>
      )}
    </li>
  );
}
