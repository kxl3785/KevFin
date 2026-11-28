import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import MerchantIcon from './MerchantIcon.tsx';
import CategoryPicker, { type PickerGroup } from './CategoryPicker.tsx';
import { openTxnDetail } from './TransactionDetail.tsx';
import { fmtTxnDate, rowProps, useEscapeKey } from '../lib/budgetUi.ts';
import { chipLabel, maskAmounts, type RuleSubject } from '../lib/ruleConditions.ts';
import { reviewApplyBody, reviewShortcut, typicalAmount } from '../lib/quickReview.ts';
import { useRuleBuilder } from '../hooks/useRuleBuilder.ts';
import { usePersistentState } from '../hooks/usePersistentState.ts';
import { useIsMobile } from '../hooks/useIsMobile.ts';

// A focused "wizard" for blitzing through transactions that need review. It steps
// through merchant clusters (uncategorized expenses grouped on the server), each
// with its most-probable categories as big one-click buttons. The rule the pick
// creates is built on the card itself: chips for the payee (ticked by default),
// the exact amount and description text, ANDed together, with a live count. One
// tap on a category then applies that ONE rule, files the charges listed on the
// card, and moves on — no follow-up popup.

interface ReviewTxn {
  id: string; date: string; amount: number; account: string;
  description: string; memo: string; importedCategory: string;
  suggested: string; postedAt: number; transactedAt: number | null;
  amountEdited?: boolean;
}
interface ReviewGroup {
  merchant: string; payee: string; account: string;
  count: number; total: number; lastDate: string;
  suggested: string; suggestions: string[];
  note: string; txns: ReviewTxn[];
}
// A possible-recurring suggestion (mirror of the server's RecurringSuggestion),
// reviewed in the same wizard so "uncertain" covers both uncategorized spend and
// maybe-recurring costs.
interface RecurringTxn { date: string; amount: number; account: string; payee: string; description?: string }
interface RecurringSuggestion {
  merchant: string; payee: string; category: string; monthlyAvg: number;
  occurrences: number; isFixed: boolean; annual?: boolean;
  reason: string; confidence: 'low' | 'medium'; aliases?: string[]; transactions: RecurringTxn[];
}

function emojiMapFrom(groups: PickerGroup[]): Record<string, string> {
  const m: Record<string, string> = {};
  for (const g of groups) for (const c of g.categories) m[c.name] = c.emoji;
  return m;
}
const shortDate = fmtTxnDate;
const fmtDay = fmtTxnDate;
function fmtTime(unix: number) {
  return new Date(unix * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
function dayOf(unix?: number | null) {
  // Local calendar day, matching the bank's local 'YYYY-MM-DD' date strings
  // and fmtTime's local rendering — a UTC day would mismatch both.
  return unix ? new Date(unix * 1000).toLocaleDateString('en-CA') : '';
}
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

// A labelled detail line (e.g. "ᴅᴇsᴄ  PAYPAL *STEAMGAMES").
function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 6, marginTop: 3, fontSize: 11, lineHeight: 1.4 }}>
      <span style={{ color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.4, fontSize: 9, flexShrink: 0, marginTop: 1 }}>{label}</span>
      <span style={{ color: 'var(--text)', wordBreak: 'break-word', fontFamily: mono ? MONO : undefined }}>{value}</span>
    </div>
  );
}
// A small pill (imported category, auto-suggestion, transacted date).
function Badge({ children }: { children: ReactNode }) {
  return (
    <span style={{ fontSize: 10, color: 'var(--muted)', border: '1px solid var(--border)', borderRadius: 9, padding: '1px 7px', whiteSpace: 'nowrap' }}>{children}</span>
  );
}
// A keyboard-shortcut hint on a button (desktop only).
function KeyHint({ k }: { k: string }) {
  return (
    <span aria-hidden="true" style={{ fontSize: 10, fontWeight: 600, fontFamily: MONO, color: 'var(--muted)', border: '1px solid var(--border)', borderRadius: 4, padding: '0 4px', background: 'var(--surface)', flexShrink: 0, lineHeight: '15px' }}>{k}</span>
  );
}
const EYEBROW: React.CSSProperties = { fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 };

export default function ReviewWizard({ cats, groups, money, moneyCents, onClose, onCategorized }: {
  cats: string[];
  groups: PickerGroup[];
  money: (n: number) => string;       // whole dollars, for totals
  moneyCents: (n: number) => string;  // with cents, for individual charges
  onClose: () => void;
  onCategorized: () => void; // tell the parent to refresh its budget data
}) {
  const [queue, setQueue] = useState<ReviewGroup[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [suggestions, setSuggestions] = useState<RecurringSuggestion[]>([]);
  const [idx, setIdx] = useState(0);
  const idxRef = useRef(0);
  idxRef.current = idx;
  const [busy, setBusy] = useState(false);
  // Synchronous twin of `busy`: a second tap (or key press) in the same frame sees
  // it before React re-renders, so one choice can never be applied twice.
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  // What the last pick did, shown on the next card since nothing pops up any more.
  const [lastDone, setLastDone] = useState('');
  const [privacy] = usePersistentState('mon.privacy', false);
  const isMobile = useIsMobile();
  // What the user actually did, for the wrap-up line ("5 categorized, 2 skipped").
  const [stats, setStats] = useState({ categorized: 0, recurring: 0, skipped: 0 });
  const bump = (k: keyof typeof stats) => setStats(s => ({ ...s, [k]: s[k] + 1 }));
  const emoji = emojiMapFrom(groups);
  const catEmoji = (c: string) => emoji[c] ?? '🏷️';

  useEffect(() => {
    let alive = true;
    // Two review streams, surfaced back to back: uncategorized merchant clusters,
    // then possible recurring costs the detector isn't sure about.
    // A failed request (network or non-2xx) must read as an error, not as an empty
    // queue — otherwise a 500 shows "Nothing needs review".
    const load = <T,>(url: string): Promise<T> => fetch(url).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() as Promise<T>; });
    Promise.all([
      load<{ groups?: ReviewGroup[] }>('/api/budget/review'),
      load<{ suggestions?: RecurringSuggestion[] }>('/api/recurring'),
    ]).then(([rev, rec]) => {
      if (!alive) return;
      setSuggestions(rec.suggestions ?? []);
      setQueue(rev.groups ?? []);
    }).catch(() => {
      if (!alive) return;
      setLoadError(true);
      setQueue([]);
    });
    return () => { alive = false; };
  }, []);

  // Esc closes the wizard — but not when it is meant for something layered on top
  // of it (the rule modal, a transaction's detail popup, an open category picker).
  useEscapeKey(() => {
    const other = document.querySelector('[role="dialog"][aria-modal="true"]:not([data-wizard]), [data-cat-popover]');
    if (!other) onClose();
  });

  // Steps = category clusters first, then recurring suggestions.
  const catCount = queue?.length ?? 0;
  const total = catCount + suggestions.length;
  const cur = queue && idx < catCount ? queue[idx] : null;             // category step
  const curSug = idx >= catCount && idx < total ? suggestions[idx - catCount] : null; // recurring step
  // The rule conditions for the current merchant, fetched as soon as its card shows.
  const subject = useMemo<RuleSubject | null>(() => cur ? {
    merchant: cur.merchant, payee: cur.payee,
    description: cur.note || cur.txns[0]?.description || '', amount: typicalAmount(cur.txns),
  } : null, [cur]);
  const rb = useRuleBuilder(subject);
  const done = Math.min(idx, total);
  const summaryLine = (() => {
    const parts = [
      stats.categorized && `${stats.categorized} categorized`,
      stats.recurring && `${stats.recurring} recurring cost${stats.recurring === 1 ? '' : 's'} resolved`,
      stats.skipped && `${stats.skipped} skipped`,
    ].filter(Boolean);
    return parts.length ? `${parts.join(', ')}.` : 'Nothing was changed.';
  })();
  const advance = () => { setError(''); setIdx(i => i + 1); };
  const begin = () => { if (busyRef.current) return false; busyRef.current = true; setBusy(true); setError(''); return true; };
  const end = () => { busyRef.current = false; setBusy(false); };

  // Confirm a possible-recurring cost (track it) or dismiss it (not recurring).
  // Only advance when the server accepted it; otherwise stay on the step with an error
  // so a failed save isn't silently skipped.
  async function confirmRecurring(s: RecurringSuggestion) {
    if (!begin()) return;
    setLastDone('');
    try {
      const res = await fetch('/api/recurring', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payee: s.payee, category: s.category, amount: s.monthlyAvg, isFixed: s.isFixed }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      bump('recurring'); advance();
    } catch { setError(`Couldn’t save ${s.payee} as recurring — try again, or skip it.`); }
    finally { end(); }
  }
  async function dismissRecurring(s: RecurringSuggestion) {
    if (!begin()) return;
    setLastDone('');
    try {
      const res = await fetch(`/api/recurring/${encodeURIComponent(s.merchant)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      bump('recurring'); advance();
    } catch { setError(`Couldn’t dismiss ${s.payee} — try again, or skip it.`); }
    finally { end(); }
  }

  // Apply the category with the rule ticked on the card, in one request, then move
  // on. The body is built from this card at tap time, so a quick advance can't mix
  // cards. Errors keep the user on the card.
  async function applyCategory(category: string) {
    const g = cur;
    if (!g) return;
    const body = reviewApplyBody(g, category, rb);
    const res = await fetch('/api/budget/review/apply', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const d = await res.json().catch(() => ({} as { error?: string }));
    if (!res.ok) throw new Error((d as { error?: string })?.error || `HTTP ${res.status}`);
    const r = d as { category?: string; ruleCreated?: boolean; matched?: number };
    onCategorized();
    bump('categorized');
    dropSwept();
    const n = g.txns.length;
    setLastDone(`${g.payee} → ${r.category || category}: ${r.ruleCreated
      ? `rule saved, matching ${r.matched ?? 0} transaction${r.matched === 1 ? '' : 's'} and future ones`
      : `${n} charge${n === 1 ? '' : 's'} filed, no rule`}`);
    advance();
  }

  // A rule can sweep merchants further down the queue (a text rule especially), so
  // after each pick re-read what still needs review and drop the cards ahead that
  // have nothing left. Cards already shown, and the current one, stay put.
  function dropSwept() {
    fetch('/api/budget/review')
      .then(r => (r.ok ? r.json() as Promise<{ groups?: ReviewGroup[] }> : null))
      .then(d => {
        if (!d?.groups) return;
        const pending = new Set(d.groups.flatMap(x => x.txns.map(t => t.id)));
        setQueue(q => q && q.filter((x, i) => i <= idxRef.current || x.txns.some(t => pending.has(t.id))));
      })
      .catch(() => { /* best effort: a stale card can still be skipped */ });
  }

  async function assign(category: string) {
    if (!cur || !begin()) return;
    const g = cur;
    try { await applyCategory(category); }
    catch (e) {
      const why = e instanceof Error && !/^HTTP \d+$/.test(e.message) ? ` (${e.message})` : '';
      setError(`Couldn’t categorize ${g.payee}${why} — nothing was changed. Try again, or skip it.`);
    } finally { end(); }
  }

  // Create a brand-new category, then assign it to the current merchant.
  async function createAndAssign(name: string) {
    if (!cur || !begin()) return;
    const g = cur;
    let created = '';
    try {
      const res = await fetch('/api/budget/category', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json().catch(() => ({} as { created?: string }));
      created = d?.created || name.trim();
      await applyCategory(created);
    } catch {
      setError(created
        ? `Created “${created}”, but couldn’t categorize ${g.payee} — try again, or skip it.`
        : `Couldn’t create the “${name}” category — try again.`);
    } finally { end(); }
  }

  function skip() { if (busyRef.current) return; setLastDone(''); bump('skipped'); advance(); }

  // Keyboard: 1–6 pick the matching suggested category, S skips. Off while typing,
  // while the category picker or another dialog sits on top, and mid-request.
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    if (!cur && !curSug) return;
    const blocked = !!document.querySelector('[role="dialog"][aria-modal="true"]:not([data-wizard]), [data-cat-popover]');
    const hit = reviewShortcut(e, { busy: busyRef.current, blocked, choices: cur ? cur.suggestions.length : 0 });
    if (!hit) return;
    e.preventDefault();
    if (hit === 'skip') skip();
    else if (cur) assign(cur.suggestions[hit.pick]);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const overlay: React.CSSProperties = {
    position: 'fixed', inset: 0, background: 'var(--scrim)', zIndex: 4000,
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
  };
  const card: React.CSSProperties = {
    background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16,
    width: 'min(560px, 94vw)', maxHeight: '90vh', overflowY: 'auto',
    boxShadow: 'var(--shadow-modal)', padding: 24,
  };

  return createPortal(
    <div style={overlay} onClick={onClose}>
      <div style={card} onClick={e => e.stopPropagation()} data-wizard="" role="dialog" aria-modal="true" aria-labelledby="quick-review-title">
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div>
            <h2 id="quick-review-title" style={{ fontSize: 18, fontWeight: 700 }}>⚡ Quick review</h2>
            {/* The wizard is all-time, unlike the month-scoped card that opens it. */}
            {queue !== null && !loadError && total > 0 && (
              <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                All months · {catCount} merchant{catCount === 1 ? '' : 's'}
                {suggestions.length > 0 ? ` · ${suggestions.length} possible recurring` : ''}
              </p>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {total > 0 && (
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                {Math.min(idx + 1, total)} / {total}
              </span>
            )}
            <button onClick={onClose} title="Close (Esc)" aria-label="Close" style={{ background: 'transparent', color: 'var(--muted)', fontSize: 20, lineHeight: 1 }}>✕</button>
          </div>
        </div>

        {/* Progress bar */}
        {total > 0 && (
          <div style={{ height: 5, background: 'var(--bg)', borderRadius: 3, overflow: 'hidden', marginBottom: 18 }}>
            <div style={{ width: `${(done / total) * 100}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.2s' }} />
          </div>
        )}

        {queue === null && <p style={{ color: 'var(--muted)', fontSize: 13, padding: '24px 0', textAlign: 'center' }}>Loading…</p>}

        {/* All caught up (either nothing to review, or we reached the end) */}
        {loadError && (
          <div style={{ textAlign: 'center', padding: '28px 0' }}>
            <p style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>Couldn’t load the review queue</p>
            <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 20 }}>Check that the server is running, then try again.</p>
            <button className="btn-primary" onClick={onClose} style={{ fontSize: 13, padding: '8px 18px' }}>Close</button>
          </div>
        )}

        {queue !== null && !loadError && !cur && !curSug && (
          <div style={{ textAlign: 'center', padding: '28px 0' }}>
            <div style={{ fontSize: 40, marginBottom: 10 }}>🎉</div>
            <p style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>
              {total === 0 ? 'Nothing needs review' : 'All caught up!'}
            </p>
            <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 20 }}>
              {total === 0 ? 'Every transaction is categorized and recurring costs are confirmed.' : summaryLine}
            </p>
            <button className="btn-primary" onClick={onClose} style={{ fontSize: 13, padding: '8px 18px' }}>Done</button>
          </div>
        )}

        {/* What the previous pick did — the only trace of it now that no popup follows. */}
        {lastDone && (cur || curSug) && (
          <p role="status" style={{ fontSize: 12, color: 'var(--muted)', marginTop: -8, marginBottom: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={lastDone}>
            <span style={{ color: 'var(--green)' }}>✓</span> {lastDone}
          </p>
        )}

        {/* Current merchant cluster */}
        {cur && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
              <MerchantIcon merchant={cur.merchant} label={cur.payee} size={40} />
              <div style={{ minWidth: 0 }}>
                <p style={{ fontSize: 16, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cur.payee}</p>
                <p style={{ fontSize: 12, color: 'var(--muted)' }}>
                  {cur.count} transaction{cur.count === 1 ? '' : 's'} · {money(cur.total)} · last {shortDate(cur.lastDate)}
                </p>
              </div>
            </div>
            {/* Raw bank descriptor when it says more than the cleaned payee, and the
                account — unless the single charge below already shows both. */}
            {cur.txns.length > 1 && cur.note && (
              <p style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'ui-monospace, SFMono-Regular, monospace' }} title={cur.note}>
                {cur.note}
              </p>
            )}
            {cur.txns.length > 1
              ? <p style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={cur.account}>{cur.account}</p>
              : <div style={{ height: 10 }} />}

            {/* The underlying charges, each shown in full — so aggregators like
                PayPal/Amex reveal everything the bank gave us per transaction. */}
            {cur.txns.length > 0 && (
              <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 10, marginBottom: 16, overflow: 'hidden' }}>
                <p style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5, padding: '8px 12px 4px' }}>
                  {cur.count} charge{cur.count === 1 ? '' : 's'}{cur.count > cur.txns.length ? ` · showing ${cur.txns.length}` : ''}
                </p>
                <div style={{ maxHeight: 264, overflowY: 'auto', padding: '0 6px 6px' }}>
                  {cur.txns.map((t, i) => {
                    const desc = t.description && t.description.toLowerCase() !== cur.payee.toLowerCase() ? t.description : '';
                    const transDay = dayOf(t.transactedAt);
                    const showTrans = !!transDay && transDay !== (dayOf(t.postedAt) || t.date);
                    const showSug = !!t.suggested && t.suggested !== 'Miscellaneous' && t.suggested !== t.importedCategory;
                    return (
                      <div key={i} title="Click for full details"
                        {...rowProps(() => openTxnDetail({
                          id: t.id, amountEdited: t.amountEdited,
                          payee: cur.payee, merchant: cur.merchant, amount: t.amount, account: t.account, date: t.date,
                          postedAt: t.postedAt, transactedAt: t.transactedAt, description: t.description, memo: t.memo,
                          suggested: t.suggested, importedCategory: t.importedCategory || undefined,
                        }))}
                        style={{ padding: '8px 8px', borderTop: i ? '1px solid var(--border)' : 'none', cursor: 'pointer', borderRadius: 6 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                          <span style={{ fontSize: 12, color: 'var(--text)' }}>{fmtDay(t.date)}{t.postedAt ? ` · ${fmtTime(t.postedAt)}` : ''}</span>
                          <span style={{ fontSize: 13, fontWeight: 600, color: t.amount > 0 ? 'var(--green)' : 'var(--text)', flexShrink: 0 }}>{moneyCents(t.amount)}</span>
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.account}>{t.account}</div>
                        {desc && <Field label="desc" value={desc} mono />}
                        {t.memo && <Field label="memo" value={t.memo} />}
                        {(t.importedCategory || showSug || showTrans) && (
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 5 }}>
                            {t.importedCategory && <Badge>🏷 {t.importedCategory}</Badge>}
                            {showSug && <Badge>✨ {t.suggested}</Badge>}
                            {showTrans && <Badge>transacted {fmtDay(transDay)}</Badge>}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}


            {/* The rule this pick creates: conditions as toggle chips, ANDed, with
                each chip's own reach and the combined count live underneath. */}
            <div style={{ marginBottom: 16 }}>
              <p id="qr-rule-label" style={EYEBROW}>Rule: match all ticked</p>
              {rb.status === 'ready' && rb.conds.length > 0 && (
                <div role="group" aria-labelledby="qr-rule-label" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                  {rb.conds.map(c => {
                    const on = rb.sel.has(c.key);
                    const label = maskAmounts(chipLabel(c), privacy);
                    return (
                      <button key={c.key} type="button" className={`bud-fchip${on ? ' on' : ''}`} aria-pressed={on} disabled={busy}
                        onClick={() => rb.toggle(c.key)} title={`${maskAmounts(c.label, privacy)} — ${c.count} on its own`}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%', cursor: busy ? 'default' : 'pointer' }}>
                        <span aria-hidden="true" style={{ fontWeight: 700 }}>{on ? '✓' : '＋'}</span>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{label}</span>
                        <span style={{ fontSize: 11, color: 'var(--muted)', flexShrink: 0 }}>{c.count}</span>
                      </button>
                    );
                  })}
                </div>
              )}
              <p aria-live="polite" style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
                {rb.status === 'loading' || rb.status === 'idle'
                  ? 'Loading rule options… a pick now uses the payee rule.'
                  : rb.status === 'error'
                    ? 'Couldn’t load the rule options — a pick uses the payee rule.'
                    : rb.sel.size === 0
                      ? <>Nothing ticked: a pick changes only the {cur.txns.length === 1 ? 'charge' : `${cur.txns.length} charges`} listed above and creates no rule.</>
                      : rb.countFailed
                        ? 'Couldn’t count the matches — the rule still applies to all of them, plus future ones.'
                        : <>Matches <strong style={{ color: 'var(--accent)' }}>{rb.count == null ? '…' : rb.count}</strong> now, plus future ones.</>}
              </p>
            </div>

            {error && <p role="alert" style={{ fontSize: 12, color: 'var(--red)', marginBottom: 10 }}>{error}</p>}
            <p style={EYEBROW}>Pick a category to apply and move on</p>
            {/* minmax(0, 1fr): a long name truncates instead of pushing the grid off a phone screen. */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8, marginBottom: 16 }}>
              {cur.suggestions.map((c, i) => {
                const isSuggested = c === cur.suggested;
                return (
                  <button key={c} disabled={busy} onClick={() => assign(c)} aria-keyshortcuts={i < 6 ? String(i + 1) : undefined}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', textAlign: 'left', minWidth: 0,
                      background: isSuggested ? 'var(--accent-dim)' : 'var(--bg)',
                      border: `1px solid ${isSuggested ? 'var(--accent)' : 'var(--border)'}`,
                      borderRadius: 10, color: 'var(--text)', fontSize: 13, cursor: busy ? 'default' : 'pointer',
                      opacity: busy ? 0.6 : 1,
                    }}>
                    <span style={{ fontSize: 16, flexShrink: 0 }}>{catEmoji(c)}</span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c}</span>
                    <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                      {isSuggested && <span style={{ fontSize: 10, color: 'var(--accent)' }}>✨</span>}
                      {!isMobile && i < 6 && <KeyHint k={String(i + 1)} />}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Full picker for anything not in the shortlist, + skip */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <CategoryPicker value="" placeholder="Something else…" excludeOther options={cats} groups={groups}
                  suggested={cur.suggested || undefined} onChange={assign} onCreate={createAndAssign}
                  triggerStyle={{ padding: '9px 12px', fontSize: 13 }} zIndex={4100} />
              </div>
              <button className="btn-ghost" disabled={busy} onClick={skip} aria-keyshortcuts="S"
                style={{ fontSize: 13, padding: '9px 14px', flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                Skip{!isMobile && <KeyHint k="S" />}
              </button>
            </div>

            <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 14, lineHeight: 1.5 }}>
              Tick what the rule should match, then pick a category: it applies to the matches and future ones, and moves to the next merchant.
              Untick everything to change only the charges listed.{!isMobile && ' Keys 1–6 pick, S skips.'}
            </p>
          </>
        )}

        {/* Possible-recurring step: confirm to track it, or dismiss it. */}
        {curSug && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
              <MerchantIcon merchant={curSug.merchant} label={curSug.payee} size={40} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <p style={{ fontSize: 16, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{curSug.payee}</p>
                <p style={{ fontSize: 12, color: 'var(--muted)' }}>
                  {curSug.category} · {curSug.occurrences} {curSug.occurrences === 1 ? 'month' : 'months'}
                  {curSug.annual ? ` · billed annually (~${money(curSug.monthlyAvg * 12)}/yr)` : ''} · ~{money(curSug.monthlyAvg)}/mo
                </p>
              </div>
              <span style={{
                fontSize: 9, padding: '2px 7px', borderRadius: 9, textTransform: 'uppercase', letterSpacing: 0.4, flexShrink: 0,
                color: curSug.confidence === 'medium' ? 'var(--amber)' : 'var(--muted)',
                border: `1px solid ${curSug.confidence === 'medium' ? 'var(--amber)' : 'var(--border)'}`,
              }}>{curSug.confidence === 'medium' ? 'likely' : 'maybe'}</span>
            </div>

            <p style={{ fontSize: 12, color: 'var(--text)', margin: '10px 0 4px' }}>
              {curSug.reason}{curSug.aliases?.length ? ` · also "${curSug.aliases.join('", "')}"` : ''}
            </p>

            {/* The charges behind it, so the user can judge before confirming. */}
            {curSug.transactions.length > 0 && (
              <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 10, margin: '12px 0 16px', overflow: 'hidden' }}>
                <p style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5, padding: '8px 12px 4px' }}>
                  {curSug.transactions.length} recent charge{curSug.transactions.length === 1 ? '' : 's'}
                </p>
                <div style={{ maxHeight: 220, overflowY: 'auto', padding: '0 12px 8px' }}>
                  {curSug.transactions.map((t, i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, padding: '6px 0', borderTop: i ? '1px solid var(--border)' : 'none', fontSize: 12 }}>
                      <span>{fmtDay(t.date)}{t.account ? <span style={{ color: 'var(--muted)', marginLeft: 8 }}>{t.account}</span> : null}</span>
                      <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{moneyCents(t.amount)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {error && <p role="alert" style={{ fontSize: 12, color: 'var(--red)', marginBottom: 10 }}>{error}</p>}
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn-ghost" disabled={busy} onClick={skip} aria-keyshortcuts="S"
                title="Decide later" style={{ fontSize: 13, padding: '10px 14px', display: 'inline-flex', alignItems: 'center', gap: 6 }}>Skip{!isMobile && <KeyHint k="S" />}</button>
              <button className="btn-ghost" disabled={busy} onClick={() => dismissRecurring(curSug)}
                style={{ flex: 1, fontSize: 13, padding: '10px 14px' }}>Not recurring</button>
              <button className="btn-primary" disabled={busy} onClick={() => confirmRecurring(curSug)}
                style={{ flex: 1, fontSize: 13, padding: '10px 14px' }}>Confirm recurring</button>
            </div>

            <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 14, lineHeight: 1.5 }}>
              Possible recurring cost. Confirm to track it on the Recurring page, or dismiss if it isn’t.
            </p>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
