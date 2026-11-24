import { useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '../hooks/useApi.ts';
import { usePersistentState } from '../hooks/usePersistentState.ts';
import CategoryPicker, { type PickerGroup } from './CategoryPicker.tsx';
import InfoTip from './allocation/InfoTip.tsx';
import { fmtMoney, fmtDate } from '../lib/format.ts';
import {
  ruleStatus, ruleTypeTag, CONDITION_LABEL, filterRules, filterAuto, categoryOptions, maskMoney, plural, PRECEDENCE_LINE, SHADOWED_TEXT,
  KIND_FILTERS, SORT_OPTIONS, DEFAULT_RULES_VIEW, filterByKind, sortRules, needsAttention, isAttention, groupByCategory, normalizeRulesView,
  type RulesReviewData, type RuleReview, type RuleCondition, type AutoMerchant, type SignRuleReview, type RuleKindFilter, type RuleSort, type RulesView,
} from '../lib/rulesReview.ts';

// Review of every categorization rule: what each one actually decides, which are
// dead weight (never applies / unused), merchants only categorized by the
// built-in guess (confirm or correct them), and sign reversals. Three tabs keep
// those apart. "Your rules" can be filtered by type, sorted, grouped under their
// category, narrowed to the rules that decide nothing, and selected in bulk to
// move to another category or delete. Data comes from GET /api/budget/rules;
// edits go through PATCH/DELETE /api/budget/rules/:id, POST
// /api/budget/rules/bulk and the existing PUT /api/budget/rule.

const AUTO_PREVIEW = 50;

const card: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px', marginTop: 12 };
const heading: React.CSSProperties = { fontSize: 14, fontWeight: 600, margin: 0 };
const muted: React.CSSProperties = { color: 'var(--muted)', fontSize: 12 };
const rowLine: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 12px', padding: '8px 0' };
const listReset: React.CSSProperties = { listStyle: 'none', margin: 0, padding: 0 };
const toolbar: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 16px' };
const checkLabel: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', minHeight: 32, whiteSpace: 'nowrap' };

const pill = (color: string): React.CSSProperties => ({
  display: 'inline-block', fontSize: 11, lineHeight: 1.4, padding: '2px 8px', borderRadius: 999,
  border: `1px solid ${color}`, color, maxWidth: '100%',
});

type Tab = 'rules' | 'suggestions' | 'sign';

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" />
    </svg>
  );
}

// A checkbox that can also show "some selected" (for a group or the whole list).
function TriCheckbox({ checked, mixed, disabled, onChange, label }: {
  checked: boolean; mixed: boolean; disabled?: boolean; onChange: (on: boolean) => void; label: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = mixed; }, [mixed]);
  return <input ref={ref} type="checkbox" checked={checked} disabled={disabled} aria-label={label}
    onChange={e => onChange(e.target.checked)} style={{ width: 16, height: 16, margin: 0, flexShrink: 0, cursor: 'pointer' }} />;
}

export default function RulesManager({ privacy, cats, groups, onChanged }: {
  privacy: boolean; cats: string[]; groups: PickerGroup[]; onChanged: () => void;
}) {
  const { data, loading, error, refetch } = useApi<RulesReviewData>('/api/budget/rules');
  const [tab, setTab] = useState<Tab>('rules');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [kind, setKind] = useState<RuleKindFilter>('all');
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [viewPref, setViewPref] = usePersistentState<RulesView>('mon.rulesView', DEFAULT_RULES_VIEW);
  const view = normalizeRulesView(viewPref);
  const setView = (patch: Partial<RulesView>) => setViewPref({ ...view, ...patch });
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const [showAllAuto, setShowAllAuto] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const [confirmId, setConfirmId] = useState<number | null>(null); // rule awaiting delete confirmation
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const money = (n: number, cents = false) => maskMoney(n, privacy, v => fmtMoney(v, { cents }));

  // Run a mutation, then refresh the list and tell the host page its data changed.
  // Resolves true when it worked.
  async function mutate(key: string, url: string, init: RequestInit, failMsg: string): Promise<boolean> {
    setBusy(key); setActionError(null);
    try {
      const res = await fetch(url, init);
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error ?? failMsg);
      }
      await refetch();
      onChanged();
      return true;
    } catch (e) {
      setActionError(e instanceof Error ? e.message : failMsg);
      return false;
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

  const allRules = useMemo(() => data?.rules ?? [], [data]);
  const attention = useMemo(() => needsAttention(allRules), [allRules]);
  const attentionCount = attention.shadowed.length + attention.unused.length;
  // "Show only these" switches itself off once nothing is left to show (e.g.
  // after deleting them all), so the list can't get stuck empty.
  const attentionShown = attentionOnly && attentionCount > 0;
  // Search + category apply to both lists; type and "needs attention" to rules only.
  const searched = useMemo(() => (data ? filterRules(data.rules, query, category) : []), [data, query, category]);
  const pool = useMemo(() => (attentionShown ? searched.filter(isAttention) : searched), [searched, attentionShown]);
  const kindCounts = useMemo(() => Object.fromEntries(KIND_FILTERS.map(k => [k.key, filterByKind(pool, k.key).length])) as Record<RuleKindFilter, number>, [pool]);
  const visible = useMemo(() => sortRules(filterByKind(pool, kind), view.sort), [pool, kind, view.sort]);
  const grouped = useMemo(() => (view.grouped ? groupByCategory(visible) : null), [visible, view.grouped]);
  const autoAll = useMemo(() => (data ? filterAuto(data.auto, query, category) : []), [data, query, category]);
  const autoShown = showAllAuto ? autoAll : autoAll.slice(0, AUTO_PREVIEW);
  const catOptions = useMemo(() => (data ? categoryOptions(data) : []), [data]);

  // Only ids that still exist count as selected (a rule may have been deleted).
  const liveSelected = useMemo(() => new Set(allRules.filter(r => selected.has(r.id)).map(r => r.id)), [allRules, selected]);
  const setSel = (ids: number[], on: boolean) => setSelected(prev => {
    const next = new Set(prev);
    for (const id of ids) { if (on) next.add(id); else next.delete(id); }
    return next;
  });
  const clearSelection = () => { setSelected(new Set()); setBulkConfirm(false); };
  const bulk = async (action: 'delete' | 'category', cat?: string) => {
    const ids = [...liveSelected];
    const ok = await mutate('bulk', '/api/budget/rules/bulk', json('POST', { ids, action, category: cat }),
      action === 'delete' ? 'Could not delete the rules' : 'Could not move the rules');
    if (ok) clearSelection();
  };

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

  const searching = query.trim() !== '' || category !== '';
  const narrowed = searching || kind !== 'all' || attentionShown;
  const tabs: { key: Tab; label: string; count: number; of: number }[] = [
    { key: 'rules', label: 'Your rules', count: searched.length, of: data.rules.length },
    { key: 'suggestions', label: 'Suggestions', count: autoAll.length, of: data.auto.length },
    ...(data.signRules.length ? [{ key: 'sign' as Tab, label: 'Sign reversals', count: data.signRules.length, of: data.signRules.length }] : []),
  ];
  const activeTab: Tab = tabs.some(t => t.key === tab) ? tab : 'rules';
  // Arrow keys move between tabs (the usual tablist pattern).
  const onTabKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const i = tabs.findIndex(t => t.key === activeTab);
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length].key;
    setTab(next);
    document.getElementById(`rules-tab-${next}`)?.focus();
  };

  // Groups start closed (an overview of categories); a search or filter opens
  // them all, and so does having a single group.
  const groupOpen = (cat: string) => narrowed || (grouped?.length ?? 0) <= 1 || openGroups.has(cat);
  const toggleGroup = (cat: string) => setOpenGroups(prev => {
    const next = new Set(prev);
    if (next.has(cat)) next.delete(cat); else next.add(cat);
    return next;
  });

  const visibleIds = visible.map(r => r.id);
  const shownSelected = visibleIds.filter(id => liveSelected.has(id)).length;

  const renderRule = (r: RuleReview, i: number) => (
    <RuleItem key={r.id} rule={r} first={i === 0} open={openId === r.id} confirming={confirmId === r.id}
      busy={busy === `rule-${r.id}` || busy === 'bulk'} money={money} cats={cats} groups={groups}
      selected={liveSelected.has(r.id)} onSelect={on => setSel([r.id], on)}
      onToggle={() => setOpenId(openId === r.id ? null : r.id)}
      onChangeCategory={c => changeRuleCategory(r, c)}
      onAskDelete={() => setConfirmId(r.id)} onCancelDelete={() => setConfirmId(null)} onDelete={() => deleteRule(r.id)} />
  );

  return (
    <div>
      {actionError && (
        <div role="alert" style={{ marginTop: 12, padding: '8px 12px', borderRadius: 8, border: '1px solid var(--red)', color: 'var(--red)', fontSize: 13, display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
          <span>{actionError}</span>
          <button className="btn-ghost btn-sm" onClick={() => setActionError(null)} aria-label="Dismiss error">Dismiss</button>
        </div>
      )}

      {/* Search + category: apply to every list */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
        <input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search merchants or rules…"
          aria-label="Search rules" style={{ flex: '1 1 200px', width: 'auto', minWidth: 0 }} />
        <select value={category} onChange={e => setCategory(e.target.value)} aria-label="Filter by category"
          style={{ flex: '0 1 200px', minWidth: 0, fontSize: 14, padding: '8px 12px' }}>
          <option value="">All categories</option>
          {catOptions.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {/* Which list */}
      <div style={{ ...toolbar, marginTop: 12, justifyContent: 'space-between' }}>
        <div className="seg" role="tablist" aria-label="Rule lists" onKeyDown={onTabKey}>
          {tabs.map(t => (
            <button key={t.key} id={`rules-tab-${t.key}`} role="tab" type="button" aria-selected={activeTab === t.key}
              aria-controls={`rules-panel-${t.key}`} tabIndex={activeTab === t.key ? 0 : -1}
              className={`seg-btn${activeTab === t.key ? ' active' : ''}`} onClick={() => setTab(t.key)} style={{ minHeight: 30 }}>
              {t.label} <span style={{ opacity: 0.75 }}>{searching && t.count !== t.of ? `${t.count} of ${t.of}` : t.count}</span>
            </button>
          ))}
        </div>
        {activeTab === 'rules' && (
          <span style={{ ...muted, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            Which rule wins?
            <InfoTip label="which rule wins" width={300} text={`${PRECEDENCE_LINE}. A rule that never decides anything is marked “never applies” (another rule always wins) or “unused” (nothing matches it).`} />
          </span>
        )}
      </div>

      {activeTab === 'rules' && (
        <section id="rules-panel-rules" role="tabpanel" aria-labelledby="rules-tab-rules" style={card}>
          {/* Rules that decide nothing: a clean-up queue */}
          {attentionCount > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 12px', padding: '10px 12px', marginBottom: 12, borderRadius: 8, border: `1px solid ${attentionShown ? 'var(--accent)' : 'var(--amber)'}`, background: attentionShown ? 'var(--accent-dim)' : 'transparent' }}>
              <p style={{ flex: '1 1 260px', fontSize: 13, lineHeight: 1.5, margin: 0 }}>
                {attentionShown
                  ? <>Showing the <strong>{plural(attentionCount, 'rule')}</strong> that decide no transactions.</>
                  : <><strong>{plural(attentionCount, 'rule')}</strong> decide no transactions
                    {attention.shadowed.length > 0 && <>: {attention.shadowed.length} never {attention.shadowed.length === 1 ? 'applies' : 'apply'} because another rule always wins</>}
                    {attention.unused.length > 0 && <>{attention.shadowed.length > 0 ? ', ' : ': '}{attention.unused.length} {attention.unused.length === 1 ? 'matches' : 'match'} nothing in your history</>}.</>}
              </p>
              <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button type="button" className="btn-ghost btn-sm" aria-pressed={attentionShown} onClick={() => setAttentionOnly(!attentionShown)}>
                  {attentionShown ? 'Show all rules' : 'Show only these'}
                </button>
                <button type="button" className="btn-ghost btn-sm" onClick={() => {
                  setAttentionOnly(true);
                  setSel([...attention.shadowed, ...attention.unused].map(r => r.id), true);
                }}>Select all {attentionCount}</button>
              </span>
            </div>
          )}

          {/* Type, sort and grouping */}
          <div style={{ ...toolbar, justifyContent: 'space-between' }}>
            <div className="seg scroll-row" role="group" aria-label="Rule type" style={{ flexWrap: 'wrap', maxWidth: '100%' }}>
              {KIND_FILTERS.map(k => (
                <button key={k.key} type="button" aria-pressed={kind === k.key} className={`seg-btn${kind === k.key ? ' active' : ''}`}
                  onClick={() => setKind(k.key)} style={{ minHeight: 28 }}>
                  {k.label} <span style={{ opacity: 0.75 }}>{kindCounts[k.key]}</span>
                </button>
              ))}
            </div>
            <span style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 14px' }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)' }}>
                Sort
                <select value={view.sort} onChange={e => setView({ sort: e.target.value as RuleSort })} aria-label="Sort rules">
                  {SORT_OPTIONS.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
                </select>
              </label>
              <label style={checkLabel}>
                <input type="checkbox" checked={view.grouped} onChange={e => setView({ grouped: e.target.checked })} style={{ margin: 0 }} />
                Group by category
              </label>
            </span>
          </div>

          {/* Select all shown + expand/collapse, or the bulk actions once something is selected */}
          <div style={{ ...toolbar, justifyContent: 'space-between', padding: '8px 0', marginTop: 8, borderTop: '1px solid var(--border)', position: 'sticky', top: 0, zIndex: 2, background: 'var(--surface)' }}>
            {liveSelected.size === 0 ? (
              <>
                <label style={checkLabel}>
                  <TriCheckbox checked={false} mixed={false} disabled={!visible.length}
                    onChange={on => setSel(visibleIds, on)} label={`Select all ${visible.length} rules shown`} />
                  <span>{plural(visible.length, 'rule')}{narrowed ? ` of ${data.rules.length}` : ''}</span>
                </label>
                {grouped && !narrowed && grouped.length > 1 && (
                  <span style={{ display: 'flex', gap: 6 }}>
                    <button type="button" className="btn-ghost btn-sm" onClick={() => setOpenGroups(new Set(grouped.map(g => g.category)))}>Expand all</button>
                    <button type="button" className="btn-ghost btn-sm" onClick={() => setOpenGroups(new Set())}>Collapse all</button>
                  </span>
                )}
              </>
            ) : (
              <div role="group" aria-label="Selected rules" style={{ ...toolbar, width: '100%', justifyContent: 'space-between' }}>
                <label style={checkLabel}>
                  <TriCheckbox checked={shownSelected > 0 && shownSelected === visibleIds.length} mixed={shownSelected > 0 && shownSelected < visibleIds.length}
                    onChange={on => setSel(visibleIds, on)} label={`Select all ${visible.length} rules shown`} />
                  <strong>{liveSelected.size} selected</strong>
                </label>
                {bulkConfirm ? (
                  <span role="group" aria-label="Confirm delete" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                    <span style={{ fontSize: 13 }}>Delete {plural(liveSelected.size, 'rule')}? This can’t be undone.</span>
                    <button className="btn-danger btn-sm" disabled={busy === 'bulk'} onClick={() => bulk('delete')}>Delete</button>
                    <button className="btn-ghost btn-sm" onClick={() => setBulkConfirm(false)}>Cancel</button>
                  </span>
                ) : (
                  <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                    <span style={{ width: 170 }}>
                      <CategoryPicker value="" placeholder="Move to…" compact options={cats} groups={groups}
                        onChange={c => { if (c) bulk('category', c); }} />
                    </span>
                    <button className="btn-ghost btn-sm" disabled={busy === 'bulk'} onClick={() => setBulkConfirm(true)}>Delete…</button>
                    <button className="btn-ghost btn-sm" onClick={clearSelection}>Clear</button>
                  </span>
                )}
              </div>
            )}
          </div>

          {visible.length === 0 ? (
            <p style={{ ...muted, padding: '12px 0 4px', fontSize: 13 }}>
              {data.rules.length === 0 ? 'No rules yet — categorize a transaction to create one.' : 'No rules match these filters.'}
            </p>
          ) : grouped ? (
            <ul style={listReset} aria-label="Rules by category">
              {grouped.map(g => {
                const open = groupOpen(g.category);
                const gIds = g.rules.map(r => r.id);
                const gSel = gIds.filter(id => liveSelected.has(id)).length;
                const panel = `rules-group-${g.category.replace(/[^a-z0-9]+/gi, '-')}`;
                return (
                  <li key={g.category} style={{ borderTop: '1px solid var(--border)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', flexWrap: 'wrap' }}>
                      <TriCheckbox checked={gSel > 0 && gSel === gIds.length} mixed={gSel > 0 && gSel < gIds.length}
                        onChange={on => setSel(gIds, on)} label={`Select all ${g.rules.length} ${g.category} rules`} />
                      <button type="button" aria-expanded={open} aria-controls={panel} onClick={() => toggleGroup(g.category)} disabled={narrowed}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: 'transparent', color: 'var(--text)', padding: '4px 0', fontSize: 14, fontWeight: 600, cursor: narrowed ? 'default' : 'pointer', opacity: 1 }}>
                        <span aria-hidden="true" style={{ color: 'var(--muted)', width: 10 }}>{open ? '▾' : '▸'}</span>
                        {g.category}
                      </button>
                      <span style={muted}>
                        {plural(g.rules.length, 'rule')} · {g.matched ? `${plural(g.matched, 'transaction')} · ${money(g.total)}` : 'no transactions'}
                      </span>
                    </div>
                    {open && <ul id={panel} style={{ ...listReset, paddingLeft: 4 }}>{g.rules.map(renderRule)}</ul>}
                  </li>
                );
              })}
            </ul>
          ) : (
            <ul style={listReset}>{visible.map(renderRule)}</ul>
          )}
        </section>
      )}

      {activeTab === 'suggestions' && (
        <section id="rules-panel-suggestions" role="tabpanel" aria-labelledby="rules-tab-suggestions" style={card}>
          <h3 style={heading}>Auto-categorized merchants</h3>
          <p style={{ ...muted, margin: '4px 0 0' }}>Guessed by the built-in categorizer, busiest first. Confirm a guess to pin it as a rule, or change it.</p>
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
                  <span style={muted}>{plural(a.count, 'transaction')} · {money(a.total)} · last {fmtDate(a.lastDate)}</span>
                  <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <button className="btn-ghost btn-sm" style={{ whiteSpace: 'nowrap' }} disabled={busy === `auto-${a.merchant}`}
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
      )}

      {activeTab === 'sign' && (
        <section id="rules-panel-sign" role="tabpanel" aria-labelledby="rules-tab-sign" style={card}>
          <h3 style={heading}>Sign reversals</h3>
          <p style={{ ...muted, margin: '4px 0 0' }}>Merchants whose amounts are flipped (money in shown as money out, or the reverse).</p>
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

// A condition as a compact chip: muted field label + value. Never wraps mid-chip;
// an over-long value is truncated (full text on hover).
function ConditionChip({ c }: { c: RuleCondition }) {
  return (
    <span title={c.value} style={{
      display: 'inline-flex', alignItems: 'baseline', gap: 6, maxWidth: '100%', minWidth: 0, whiteSpace: 'nowrap',
      padding: '3px 9px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface-2)', fontSize: 12,
    }}>
      <span style={{ ...muted, fontSize: 11, flexShrink: 0 }}>{CONDITION_LABEL[c.field]}</span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{c.value}</span>
    </span>
  );
}

function RuleItem({ rule: r, first, open, confirming, busy, money, cats, groups, selected, onSelect, onToggle, onChangeCategory, onAskDelete, onCancelDelete, onDelete }: {
  rule: RuleReview; first: boolean; open: boolean; confirming: boolean; busy: boolean;
  selected: boolean; onSelect: (on: boolean) => void;
  money: (n: number, cents?: boolean) => string; cats: string[]; groups: PickerGroup[];
  onToggle: () => void; onChangeCategory: (c: string) => void;
  onAskDelete: () => void; onCancelDelete: () => void; onDelete: () => void;
}) {
  const status = ruleStatus(r);
  const panelId = `rule-samples-${r.id}`;
  const cell26: React.CSSProperties = { minHeight: 26, display: 'flex', alignItems: 'center' };
  return (
    <li style={{ borderTop: first ? 'none' : '1px solid var(--border)', opacity: busy ? 0.6 : 1 }}>
      <div className="rule-row">
        <div style={cell26}>
          <input type="checkbox" checked={selected} onChange={e => onSelect(e.target.checked)} aria-label={`Select rule: ${r.description}`}
            style={{ width: 16, height: 16, margin: 0, cursor: 'pointer' }} />
        </div>
        {/* Caret, rule-type tag, condition chips; status pills sit underneath. */}
        <div style={{ minWidth: 0 }}>
          <button onClick={onToggle} aria-expanded={open} aria-controls={panelId} aria-label={r.description}
            className="rule-main" style={{ width: '100%', minWidth: 0, display: 'flex', gap: 8, alignItems: 'flex-start', textAlign: 'left', background: 'transparent', color: 'var(--text)', padding: '0', fontSize: 13, fontWeight: 500 }}>
            <span aria-hidden="true" style={{ color: 'var(--muted)', width: 10, flexShrink: 0, lineHeight: '26px' }}>{open ? '▾' : '▸'}</span>
            <span className="rule-tag" style={{ ...muted, fontSize: 11, whiteSpace: 'nowrap', flexShrink: 0, lineHeight: '26px' }}>{ruleTypeTag(r)}</span>
            <span className="rule-conds" style={{ flex: 1, minWidth: 0, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 8px' }}>
              {r.conditions.map((c, i) => (
                <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, maxWidth: '100%', minWidth: 0 }}>
                  {i > 0 && <span aria-hidden="true" style={{ ...muted, fontSize: 11 }}>and</span>}
                  <ConditionChip c={c} />
                </span>
              ))}
            </span>
          </button>
          {(status === 'shadowed' || status === 'unused') && (
            <div style={{ paddingLeft: 18, marginTop: 6 }}>
              {status === 'shadowed' && <span style={pill('var(--amber)')}>{SHADOWED_TEXT}</span>}
              {status === 'unused' && <span style={pill('var(--muted)')}>unused</span>}
            </div>
          )}
        </div>
        <div className="rule-right">
          <div className="rule-cat" style={cell26}>
            <span aria-hidden="true" style={{ color: 'var(--muted)', marginRight: 6 }}>→</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <CategoryPicker value={r.category} compact options={cats} groups={groups} onChange={c => { if (c !== r.category) onChangeCategory(c); }} />
            </div>
          </div>
          <div className="rule-stats" style={{ fontSize: 12 }}>
            <div style={cell26}>{r.matched ? `${plural(r.matched, 'transaction')} · ${money(r.total)}` : 'No transactions'}</div>
            {r.lastMatched && <div style={{ ...muted, marginTop: -2, whiteSpace: 'nowrap' }}>last {fmtDate(r.lastMatched)}</div>}
          </div>
          <div style={cell26}>
            <button className="btn-ghost btn-sm" onClick={onAskDelete} disabled={busy || confirming} aria-label={`Delete rule: ${r.description}`} title="Delete rule"
              style={{ display: 'inline-flex', alignItems: 'center', color: 'var(--muted)' }}>
              <TrashIcon />
            </button>
          </div>
        </div>
        {confirming && (
          <span className="rule-confirm" role="group" aria-label="Confirm delete" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ fontSize: 12 }}>Delete rule?</span>
            <button className="btn-danger btn-sm" onClick={onDelete}>Delete</button>
            <button className="btn-ghost btn-sm" onClick={onCancelDelete}>Cancel</button>
          </span>
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
