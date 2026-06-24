import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import MerchantIcon from './MerchantIcon.tsx';
import CategoryPicker, { type PickerGroup } from './CategoryPicker.tsx';
import { openTxnDetail } from './TransactionDetail.tsx';
import RuleSuggestModal, { type RuleCtx } from './RuleSuggestModal.tsx';

// A focused "wizard" for blitzing through transactions that need review. It steps
// through merchant clusters (uncategorized expenses grouped on the server), each
// with its most-probable categories as big one-click buttons. Picking one writes
// a rule with scope 'all', so the choice also sweeps similar transactions —
// clearing the cluster (and look-alikes) in a single tap.

interface ReviewTxn {
  date: string; amount: number; account: string;
  description: string; memo: string; importedCategory: string;
  suggested: string; postedAt: number; transactedAt: number | null;
}
interface ReviewGroup {
  merchant: string; payee: string; account: string;
  count: number; total: number; lastDate: string;
  suggested: string; suggestions: string[];
  note: string; txns: ReviewTxn[];
}

function emojiMapFrom(groups: PickerGroup[]): Record<string, string> {
  const m: Record<string, string> = {};
  for (const g of groups) for (const c of g.categories) m[c.name] = c.emoji;
  return m;
}
function shortDate(d: string) {
  const [, m, day] = d.split('-');
  return `${+m}/${+day}`;
}
function fmtDay(iso: string) {
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}
function fmtTime(unix: number) {
  return new Date(unix * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
function dayOf(unix?: number | null) {
  return unix ? new Date(unix * 1000).toISOString().slice(0, 10) : '';
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

export default function ReviewWizard({ cats, groups, money, onClose, onCategorized }: {
  cats: string[];
  groups: PickerGroup[];
  money: (n: number) => string;
  onClose: () => void;
  onCategorized: () => void; // tell the parent to refresh its budget data
}) {
  const [queue, setQueue] = useState<ReviewGroup[] | null>(null);
  const [idx, setIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const [ruleCtx, setRuleCtx] = useState<RuleCtx | null>(null);
  const emoji = emojiMapFrom(groups);
  const catEmoji = (c: string) => emoji[c] ?? '🏷️';

  useEffect(() => {
    let alive = true;
    fetch('/api/budget/review')
      .then(r => r.json())
      .then((d: { groups: ReviewGroup[] }) => { if (alive) setQueue(d.groups ?? []); })
      .catch(() => { if (alive) setQueue([]); });
    return () => { alive = false; };
  }, []);

  // Esc closes the wizard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const total = queue?.length ?? 0;
  const cur = queue && idx < total ? queue[idx] : null;
  const done = Math.min(idx, total);

  async function assign(category: string) {
    if (!cur || busy) return;
    const g = cur;
    setBusy(true);
    try {
      // Categorize this merchant's cluster, then offer smart rules (merchant /
      // amount / text) for the rest. The rule modal floats above while we advance.
      await fetch('/api/budget/rule', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ merchant: g.merchant, category, scope: 'one' }),
      });
      onCategorized();
    } finally {
      setBusy(false);
    }
    setRuleCtx({ merchant: g.merchant, payee: g.payee, description: g.note || g.txns[0]?.description || '', amount: g.txns[0]?.amount ?? 0, category });
    setIdx(i => i + 1);
  }

  // Create a brand-new category, then assign it to the current merchant.
  async function createAndAssign(name: string) {
    if (!cur || busy) return;
    const res = await fetch('/api/budget/category', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
    });
    const d = await res.json().catch(() => ({} as { created?: string }));
    await assign(d?.created || name.trim());
  }

  function skip() { setIdx(i => i + 1); }

  const overlay: React.CSSProperties = {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 4000,
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
  };
  const card: React.CSSProperties = {
    background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16,
    width: 'min(560px, 94vw)', maxHeight: '90vh', overflowY: 'auto',
    boxShadow: '0 24px 70px rgba(0,0,0,0.6)', padding: 24,
  };

  return createPortal(
    <div style={overlay} onClick={onClose}>
      <div style={card} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700 }}>⚡ Quick review</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {total > 0 && (
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                {Math.min(done + (cur ? 1 : 0), total)} / {total}
              </span>
            )}
            <button onClick={onClose} title="Close" style={{ background: 'transparent', color: 'var(--muted)', fontSize: 20, lineHeight: 1 }}>✕</button>
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
        {queue !== null && !cur && (
          <div style={{ textAlign: 'center', padding: '28px 0' }}>
            <div style={{ fontSize: 40, marginBottom: 10 }}>🎉</div>
            <p style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>
              {total === 0 ? 'Nothing needs review' : 'All caught up!'}
            </p>
            <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 20 }}>
              {total === 0 ? 'Every transaction has a category.' : `You reviewed ${done} merchant${done === 1 ? '' : 's'}.`}
            </p>
            <button className="btn-primary" onClick={onClose} style={{ fontSize: 13, padding: '8px 18px' }}>Done</button>
          </div>
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
            {/* Raw bank descriptor when it says more than the cleaned payee. */}
            {cur.note && (
              <p style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'ui-monospace, SFMono-Regular, monospace' }} title={cur.note}>
                {cur.note}
              </p>
            )}
            <p style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={cur.account}>
              {cur.account}
            </p>

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
                        onClick={() => openTxnDetail({
                          payee: cur.payee, merchant: cur.merchant, amount: t.amount, account: t.account, date: t.date,
                          postedAt: t.postedAt, transactedAt: t.transactedAt, description: t.description, memo: t.memo,
                          suggested: t.suggested, importedCategory: t.importedCategory || undefined,
                        })}
                        style={{ padding: '8px 8px', borderTop: i ? '1px solid var(--border)' : 'none', cursor: 'pointer', borderRadius: 6 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                          <span style={{ fontSize: 12, color: 'var(--text)' }}>{fmtDay(t.date)}{t.postedAt ? ` · ${fmtTime(t.postedAt)}` : ''}</span>
                          <span style={{ fontSize: 13, fontWeight: 600, color: t.amount > 0 ? 'var(--green)' : 'var(--text)', flexShrink: 0 }}>{money(t.amount)}</span>
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


            <p style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>Most likely</p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 16 }}>
              {cur.suggestions.map(c => {
                const isSuggested = c === cur.suggested;
                return (
                  <button key={c} disabled={busy} onClick={() => assign(c)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', textAlign: 'left',
                      background: isSuggested ? 'var(--accent-dim)' : 'var(--bg)',
                      border: `1px solid ${isSuggested ? 'var(--accent)' : 'var(--border)'}`,
                      borderRadius: 10, color: 'var(--text)', fontSize: 13, cursor: busy ? 'default' : 'pointer',
                      opacity: busy ? 0.6 : 1,
                    }}>
                    <span style={{ fontSize: 16, flexShrink: 0 }}>{catEmoji(c)}</span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c}</span>
                    {isSuggested && <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--accent)', flexShrink: 0 }}>✨</span>}
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
              <button className="btn-ghost" disabled={busy} onClick={skip} style={{ fontSize: 13, padding: '9px 14px', flexShrink: 0 }}>Skip</button>
            </div>

            <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 14, lineHeight: 1.5 }}>
              Picking a category categorizes this merchant — then choose how to apply it to similar and future transactions.
            </p>
          </>
        )}
      </div>
      <RuleSuggestModal ctx={ruleCtx} onClose={() => setRuleCtx(null)} onApplied={() => onCategorized()} />
    </div>,
    document.body,
  );
}
