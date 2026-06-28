import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useApi } from '../hooks/useApi.ts';
import TopNav, { type View } from '../components/TopNav.tsx';
import MerchantIcon from '../components/MerchantIcon.tsx';

interface RecurringItem {
  merchant: string;
  payee: string;
  category: string;
  monthlyAvg: number;
  lastAmount: number;
  occurrences: number;
  lastDate: string;
  isFixed: boolean;
  manual?: boolean;
  annual?: boolean;
  edited?: boolean;
  transactions: RecurringTxn[];
}

interface RecurringTxn {
  date: string;
  amount: number;
  account: string;
  payee: string;
  description?: string;
}

interface RecurringSuggestion {
  merchant: string;
  payee: string;
  category: string;
  monthlyAvg: number;
  lastAmount: number;
  occurrences: number;
  lastDate: string;
  isFixed: boolean;
  annual?: boolean;
  reason: string;
  confidence: 'low' | 'medium';
  aliases?: string[];
  transactions: RecurringTxn[];
}

interface RecurringResponse { items: RecurringItem[]; suggestions: RecurringSuggestion[] }

// Colors keyed by the new taxonomy's subcategories (grouped by hue).
const CATEGORY_COLORS: Record<string, string> = {
  'Mortgage': 'var(--red)', 'Rent': '#6c8fff', 'Home Improvement': '#6c8fff', 'Home Services': '#6c8fff',
  'Gas & Electric': 'var(--amber)', 'Water': '#38bdf8', 'Internet & Phone': 'var(--amber)', 'Subscriptions': 'var(--accent)',
  'Insurance': '#2dd4bf', 'Financial Fees': '#2dd4bf', 'Taxes': '#2dd4bf',
  'Medical': '#34d399', 'Fitness': '#34d399',
  'Entertainment & Recreation': '#f472b6', 'Travel & Vacation': '#38bdf8', 'Personal': '#38bdf8',
  'Restaurants & Bars': '#fb923c', 'Coffee Shops': '#fb923c', 'Groceries': '#4ade80',
  'Auto Payment': '#a78bfa', 'Gas': '#a78bfa', 'Parking & Tolls': '#a78bfa', 'Taxi & Ride Shares': '#a78bfa',
  'Shopping': '#fbbf24', 'Clothing': '#fbbf24', 'Electronics': '#fbbf24',
  'Child Care': '#fb923c', 'Charity': '#c084fc', 'Gifts': '#c084fc',
};

function catColor(cat: string) {
  return CATEGORY_COLORS[cat] ?? 'var(--muted)';
}

function fmtDate(d: string) {
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Small badge marking a yearly bill whose displayed /mo figure is amortized (÷12).
function AnnualTag() {
  return (
    <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 9, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--accent)', border: '1px solid var(--accent)', whiteSpace: 'nowrap' }}>
      annual
    </span>
  );
}

export default function Recurring({ onNavigate, privacy, onTogglePrivacy, embedded }: {
  onNavigate: (v: View) => void;
  privacy: boolean;
  onTogglePrivacy: () => void;
  embedded?: boolean;
}) {
  const { data, loading, error, refetch } = useApi<RecurringResponse>('/api/recurring');
  const money = (n: number) => (privacy ? '••••••' : '$' + n.toFixed(2));
  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState('All');
  // The entry whose detail box is open (a confirmed item or a suggestion). null = closed.
  const [detail, setDetail] = useState<
    { entry: RecurringItem; kind: 'item' } | { entry: RecurringSuggestion; kind: 'suggestion' } | null
  >(null);

  // Add-item form: collapsed until the user opens it. Category options are fetched
  // lazily from the budget taxonomy the first time the form is shown.
  const [adding, setAdding] = useState(false);
  const [catOptions, setCatOptions] = useState<string[]>([]);
  const [form, setForm] = useState({ payee: '', category: '', amount: '', isFixed: false });
  const [busy, setBusy] = useState(false);

  async function openAdd() {
    setAdding(true);
    if (catOptions.length === 0) {
      try {
        const b = await (await fetch('/api/budget')).json();
        const cats: string[] = (b?.categories ?? []).filter((c: string) => c !== 'Transfers' && c !== 'Credit Card Payment');
        setCatOptions(cats);
        setForm(f => ({ ...f, category: f.category || cats[0] || '' }));
      } catch { /* leave options empty; the input still works as free text */ }
    }
  }

  async function submitAdd() {
    const amount = parseFloat(form.amount);
    if (!form.payee.trim() || !(amount > 0)) return;
    setBusy(true);
    try {
      await fetch('/api/recurring', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payee: form.payee.trim(), category: form.category || 'Miscellaneous', amount, isFixed: form.isFixed }),
      });
      setForm({ payee: '', category: catOptions[0] || '', amount: '', isFixed: false });
      setAdding(false);
      refetch();
    } finally { setBusy(false); }
  }

  async function removeItem(merchant: string) {
    await fetch(`/api/recurring/${encodeURIComponent(merchant)}`, { method: 'DELETE' });
    refetch();
  }

  // Override an item's monthly amount with a user-entered figure.
  async function editAmount(merchant: string, amount: number) {
    await fetch(`/api/recurring/${encodeURIComponent(merchant)}/amount`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount }),
    });
    refetch();
  }

  // Clear an amount override, reverting an auto item to its detected amount.
  async function resetAmount(merchant: string) {
    await fetch(`/api/recurring/${encodeURIComponent(merchant)}/amount`, { method: 'DELETE' });
    refetch();
  }

  // Confirm a suggestion → add it as a tracked recurring item (the detector wasn't
  // sure, the user is). Dismiss → hide it (reuses the same delete path as removal).
  async function confirmSuggestion(s: RecurringSuggestion) {
    setBusy(true);
    try {
      await fetch('/api/recurring', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payee: s.payee, category: s.category, amount: s.monthlyAvg, isFixed: s.isFixed }),
      });
      refetch();
    } finally { setBusy(false); }
  }

  const items = data?.items ?? [];
  const suggestions = data?.suggestions ?? [];
  const allCats = ['All', ...new Set(items.map(i => i.category))];

  const q = search.trim().toLowerCase();
  // One combined list — recurring costs are no longer split into fixed vs flexible.
  const filtered = items
    .filter(item =>
      (catFilter === 'All' || item.category === catFilter) &&
      (!q || item.payee.toLowerCase().includes(q) || item.category.toLowerCase().includes(q)))
    .slice()
    .sort((a, b) => b.monthlyAvg - a.monthlyAvg);

  const totalMonthly = filtered.reduce((s, i) => s + i.monthlyAvg, 0);

  const content = (
    <>
      {!embedded && (
        <div style={{ marginBottom: 24 }}>
          <h1 style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.5px' }}>Recurring Costs</h1>
          <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 4 }}>
            Subscriptions, memberships, utilities and other recurring fees from the past 13 months — the costs worth reviewing and optimizing.
          </p>
        </div>
      )}

      {loading && <p style={{ color: 'var(--muted)' }}>Analyzing transaction history…</p>}
      {error && <p style={{ color: 'var(--red)' }}>Failed to load: {error}</p>}

      {data && (
        <>
          {/* Possible recurring items the detector isn't sure about — shown first so
              the user can confirm or dismiss them before scanning the lists below. */}
          {suggestions.length > 0 && (
            <SuggestionsSection
              suggestions={suggestions}
              money={money}
              busy={busy}
              onConfirm={confirmSuggestion}
              onDismiss={removeItem}
              onInspect={s => setDetail({ entry: s, kind: 'suggestion' })}
            />
          )}

          {/* Summary card — a single combined recurring total. */}
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 18px', marginBottom: 24 }}>
            <p style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 4 }}>Recurring · monthly</p>
            <p style={{ fontSize: 22, fontWeight: 700, color: 'var(--accent)' }}>{money(totalMonthly)}</p>
            <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 4 }}>{filtered.length} recurring items</p>
          </div>

          {/* Filters */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search merchant or category…"
              style={{ flex: '0 1 240px', padding: '6px 10px', fontSize: 13 }}
            />
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {allCats.map(c => (
                <button
                  key={c}
                  onClick={() => setCatFilter(c)}
                  style={{
                    fontSize: 12, padding: '4px 10px', borderRadius: 14,
                    background: catFilter === c ? 'var(--accent)' : 'var(--surface)',
                    color: catFilter === c ? '#fff' : 'var(--muted)',
                    border: '1px solid var(--border)',
                    cursor: 'pointer',
                  }}
                >{c}</button>
              ))}
            </div>
            <button className="btn-primary" onClick={() => (adding ? setAdding(false) : openAdd())}
              style={{ marginLeft: 'auto', fontSize: 13, padding: '6px 12px' }}>
              {adding ? 'Cancel' : '+ Add recurring'}
            </button>
          </div>

          {/* Add-item form */}
          {adding && (
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 16, marginBottom: 20, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <input value={form.payee} onChange={e => setForm(f => ({ ...f, payee: e.target.value }))}
                placeholder="Merchant / name" style={{ flex: '1 1 180px', padding: '6px 10px', fontSize: 13 }} autoFocus />
              <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                style={{ flex: '0 1 200px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', fontSize: 13, padding: '6px 8px', cursor: 'pointer' }}>
                {catOptions.length === 0 && <option value="">Miscellaneous</option>}
                {catOptions.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              <div style={{ display: 'flex', alignItems: 'center', position: 'relative' }}>
                <span style={{ position: 'absolute', left: 9, color: 'var(--muted)', fontSize: 13 }}>$</span>
                <input value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
                  onKeyDown={e => { if (e.key === 'Enter') submitAdd(); }}
                  inputMode="decimal" placeholder="0.00 / mo"
                  style={{ width: 110, padding: '6px 10px 6px 18px', fontSize: 13 }} />
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--muted)', cursor: 'pointer' }}>
                <input type="checkbox" checked={form.isFixed} onChange={e => setForm(f => ({ ...f, isFixed: e.target.checked }))} />
                Fixed / committed
              </label>
              <button className="btn-primary" disabled={busy || !form.payee.trim() || !(parseFloat(form.amount) > 0)}
                onClick={submitAdd} style={{ fontSize: 13, padding: '6px 14px' }}>
                {busy ? 'Adding…' : 'Add'}
              </button>
            </div>
          )}

          {/* All recurring costs in one combined list. */}
          {filtered.length > 0 && (
            <Section
              title="Recurring Costs"
              subtitle="Bills, subscriptions, memberships and recurring services. Tap an amount to edit it."
              items={filtered}
              money={money}
              privacy={privacy}
              onRemove={removeItem}
              onInspect={i => setDetail({ entry: i, kind: 'item' })}
              onEditAmount={editAmount}
              onResetAmount={resetAmount}
            />
          )}

          {filtered.length === 0 && (
            <p style={{ color: 'var(--muted)', fontSize: 14 }}>No recurring items match your filter.</p>
          )}
        </>
      )}

      {detail && (
        <EntryDetail entry={detail.entry} money={money} onClose={() => setDetail(null)}>
          {detail.kind === 'suggestion' ? (
            <>
              <button className="btn-ghost" style={{ fontSize: 13, padding: '6px 16px' }}
                onClick={() => { removeItem(detail.entry.merchant); setDetail(null); }}>Dismiss</button>
              <button className="btn-primary" disabled={busy} style={{ fontSize: 13, padding: '6px 16px' }}
                onClick={() => { confirmSuggestion(detail.entry); setDetail(null); }}>
                {busy ? 'Adding…' : 'Confirm recurring'}
              </button>
            </>
          ) : (
            <>
              <button className="btn-ghost" style={{ fontSize: 13, padding: '6px 16px' }}
                onClick={() => { removeItem(detail.entry.merchant); setDetail(null); }}>Remove from recurring</button>
              <button className="btn-ghost" style={{ fontSize: 13, padding: '6px 16px' }}
                onClick={() => setDetail(null)}>Close</button>
            </>
          )}
        </EntryDetail>
      )}
    </>
  );

  if (embedded) return content;

  return (
    <div className="page" style={{ maxWidth: 960, margin: '0 auto', padding: '32px 24px' }}>
      <TopNav view="budget" onNavigate={onNavigate} privacy={privacy} onTogglePrivacy={onTogglePrivacy} />
      {content}
    </div>
  );
}

// Ambiguous / edge-case candidates surfaced at the top for one-tap triage:
// confirm (start tracking it) or dismiss (hide it). Each carries a plain-language
// reason so the user understands why it's only a maybe.
function SuggestionsSection({ suggestions, money, busy, onConfirm, onDismiss, onInspect }: {
  suggestions: RecurringSuggestion[];
  money: (n: number) => string;
  busy: boolean;
  onConfirm: (s: RecurringSuggestion) => void;
  onDismiss: (merchant: string) => void;
  onInspect: (s: RecurringSuggestion) => void;
}) {
  // Stop a click on an action button from also opening the detail box.
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--amber)', borderRadius: 12, padding: 20, marginBottom: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4, gap: 8, flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: 16, fontWeight: 600 }}>Possibly recurring{suggestions.length > 1 ? ` · ${suggestions.length}` : ''}</h2>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>Tap a row for detail · confirm or dismiss</span>
      </div>
      <p style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 16 }}>
        These look like they might recur but didn't meet the bar to auto-detect — e.g. seen only once, billed irregularly, or under more than one name.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {suggestions.map(s => (
          <div key={s.merchant}
            onClick={() => onInspect(s)}
            role="button" tabIndex={0}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onInspect(s); } }}
            title="View the charges behind this suggestion"
            style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderTop: '1px solid var(--border)', cursor: 'pointer' }}>
            <MerchantIcon merchant={s.merchant} label={s.payee} size={28} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.payee}</span>
                <span style={{
                  fontSize: 11, padding: '2px 8px', borderRadius: 10,
                  background: catColor(s.category) + '22', color: catColor(s.category), border: `1px solid ${catColor(s.category)}44`,
                }}>{s.category}</span>
                <span style={{
                  fontSize: 9, padding: '1px 6px', borderRadius: 9, textTransform: 'uppercase', letterSpacing: 0.4,
                  color: s.confidence === 'medium' ? 'var(--amber)' : 'var(--muted)',
                  border: `1px solid ${s.confidence === 'medium' ? 'var(--amber)' : 'var(--border)'}`,
                }}>{s.confidence === 'medium' ? 'likely' : 'maybe'}</span>
                {s.annual && <AnnualTag />}
              </div>
              <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
                {s.annual ? `Billed annually (~${money(s.monthlyAvg * 12)}/yr). ` : ''}{s.reason}{s.aliases?.length ? ` · also "${s.aliases.join('", "')}"` : ''}
              </p>
            </div>
            <span style={{ fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap' }}>~{money(s.monthlyAvg)}/mo</span>
            <button className="btn-primary" disabled={busy} onClick={e => { stop(e); onConfirm(s); }}
              title="Track this as recurring" style={{ fontSize: 12, padding: '5px 10px' }}>Confirm</button>
            <button onClick={e => { stop(e); onDismiss(s.merchant); }} title="Dismiss — not recurring"
              aria-label={`Dismiss ${s.payee}`}
              style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: 0 }}>×</button>
          </div>
        ))}
      </div>
    </div>
  );
}

// Shared detail box for a recurring item OR a suggestion: the charges behind it
// (newest first), plus — for suggestions — why it was flagged. Action buttons are
// supplied by the caller as children so the same box serves both.
type DetailEntry = RecurringItem | RecurringSuggestion;
function EntryDetail({ entry: e, money, onClose, children }: {
  entry: DetailEntry;
  money: (n: number) => string;
  onClose: () => void;
  children: React.ReactNode; // footer action buttons
}) {
  const txns = e.transactions ?? [];
  const sugg = 'reason' in e ? e : null; // suggestion-only fields
  const rate = e.annual ? `billed annually · ~${money(e.monthlyAvg * 12)}/yr → ~${money(e.monthlyAvg)}/mo` : `~${money(e.monthlyAvg)}/mo`;
  const sub = e.occurrences
    ? `${e.category} · ${e.occurrences} ${e.occurrences === 1 ? 'month' : 'months'} · ${rate}`
    : `${e.category} · added manually · ${rate}`;
  return createPortal(
    <div onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 5000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={ev => ev.stopPropagation()}
        style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, width: 480, maxWidth: '100%', maxHeight: '85vh', overflowY: 'auto', boxShadow: '0 24px 60px rgba(0,0,0,0.6)' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '18px 20px', borderBottom: '1px solid var(--border)' }}>
          <MerchantIcon merchant={e.merchant} label={e.payee} size={40} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <p style={{ fontSize: 16, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.payee}</p>
            <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 1 }}>{sub}</p>
          </div>
          {sugg && (
            <span style={{
              fontSize: 9, padding: '2px 7px', borderRadius: 9, textTransform: 'uppercase', letterSpacing: 0.4, flexShrink: 0,
              color: sugg.confidence === 'medium' ? 'var(--amber)' : 'var(--muted)',
              border: `1px solid ${sugg.confidence === 'medium' ? 'var(--amber)' : 'var(--border)'}`,
            }}>{sugg.confidence === 'medium' ? 'likely' : 'maybe'}</span>
          )}
        </div>

        {/* Why it's a suggestion (suggestions only) */}
        {sugg && (
          <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)' }}>
            <p style={{ fontSize: 13, color: 'var(--text)' }}>{sugg.reason}</p>
            {sugg.aliases?.length ? (
              <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>Also seen as: {sugg.aliases.map(a => `"${a}"`).join(', ')}</p>
            ) : null}
          </div>
        )}

        {/* The charges behind it */}
        <div style={{ padding: '12px 20px' }}>
          {txns.length === 0 ? (
            <p style={{ fontSize: 13, color: 'var(--muted)' }}>Added manually — no charge history.</p>
          ) : (
            <>
              <p style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>
                {txns.length} recent {txns.length === 1 ? 'charge' : 'charges'}
              </p>
              {txns.map((t, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, padding: '7px 0', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
                  <div style={{ minWidth: 0 }}>
                    <span>{fmtDate(t.date)}</span>
                    {t.account && <span style={{ color: 'var(--muted)', fontSize: 11, marginLeft: 8 }}>{t.account}</span>}
                    {t.payee && t.payee.toLowerCase() !== e.payee.toLowerCase() && (
                      <span style={{ color: 'var(--muted)', fontSize: 11, marginLeft: 8, overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.payee}</span>
                    )}
                  </div>
                  <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{money(t.amount)}</span>
                </div>
              ))}
            </>
          )}
        </div>

        {/* Actions (supplied by caller) */}
        <div style={{ padding: '4px 20px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Section({ title, subtitle, items, money, privacy, onRemove, onInspect, onEditAmount, onResetAmount }: {
  title: string;
  subtitle: string;
  items: RecurringItem[];
  money: (n: number) => string;
  privacy: boolean;
  onRemove: (merchant: string) => void;
  onInspect: (item: RecurringItem) => void;
  onEditAmount: (merchant: string, amount: number) => void;
  onResetAmount: (merchant: string) => void;
}) {
  const monthlyTotal = items.reduce((s, i) => s + i.monthlyAvg, 0);
  const GRID = '3fr 1fr 1fr 1fr 90px 32px';

  // Amount editing happens in a small popover anchored to the clicked amount cell.
  const [edit, setEdit] = useState<{ item: RecurringItem; rect: DOMRect } | null>(null);
  const openEdit = (item: RecurringItem, e: React.MouseEvent) => {
    e.stopPropagation();
    setEdit({ item, rect: (e.currentTarget as HTMLElement).getBoundingClientRect() });
  };

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 20, marginBottom: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600 }}>{title}</h2>
        <span style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 600 }}>
          {money(monthlyTotal)} / mo
        </span>
      </div>
      <p style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 16 }}>{subtitle}</p>

      {/* Scroll the table sideways on a phone so the amount columns keep a legible
          width instead of wrapping the dollar figures. */}
      <div className="scroll-x"><div className="tbl-scroll" style={{ ['--tbl-min']: '592px' } as React.CSSProperties}>
      <div style={{ display: 'grid', gridTemplateColumns: GRID, gap: 8, fontSize: 11, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, paddingBottom: 8, borderBottom: '1px solid var(--border)' }}>
        <span>Merchant</span>
        <span style={{ textAlign: 'right' }}>Avg/mo</span>
        <span style={{ textAlign: 'right' }}>Last</span>
        <span style={{ textAlign: 'center' }}>Times</span>
        <span>Category</span>
        <span />
      </div>

      {items.map(item => (
        <div key={item.merchant}
          onClick={() => onInspect(item)}
          role="button" tabIndex={0}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onInspect(item); } }}
          title="View the charges behind this item"
          style={{ display: 'grid', gridTemplateColumns: GRID, gap: 8, alignItems: 'center', fontSize: 13, padding: '8px 0', borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <MerchantIcon merchant={item.merchant} label={item.payee} size={28} />
            <div style={{ minWidth: 0 }}>
              <p style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.payee}</span>
                {item.annual && <AnnualTag />}
                {item.manual && <span style={{ fontSize: 9, color: 'var(--accent)', border: '1px solid var(--accent)', borderRadius: 9, padding: '0px 6px', textTransform: 'uppercase', letterSpacing: 0.4 }}>added</span>}
              </p>
              <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1 }}>
                {item.annual ? `~${money(item.monthlyAvg * 12)}/yr · ` : ''}{item.manual ? 'added manually' : `last ${fmtDate(item.lastDate)}`}
              </p>
            </div>
          </div>
          <span
            onClick={privacy ? undefined : e => openEdit(item, e)}
            title={privacy ? undefined : 'Click to edit the monthly amount'}
            style={{ textAlign: 'right', fontWeight: 600, cursor: privacy ? 'default' : 'text', borderBottom: privacy ? 'none' : '1px dashed var(--border)' }}
          >{money(item.monthlyAvg)}{item.edited ? ' ✎' : ''}</span>
          <span style={{ textAlign: 'right', color: 'var(--muted)' }}>{item.manual ? '—' : money(item.lastAmount)}</span>
          <span style={{ textAlign: 'center', color: 'var(--muted)' }}>
            {item.manual ? '—' : `${item.occurrences}×`}
          </span>
          <span style={{
            fontSize: 11, padding: '2px 8px', borderRadius: 10, textAlign: 'center',
            background: catColor(item.category) + '22',
            color: catColor(item.category),
            border: `1px solid ${catColor(item.category)}44`,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{item.category}</span>
          <button
            onClick={e => { e.stopPropagation(); onRemove(item.merchant); }}
            title={item.manual ? 'Delete this manual item' : 'Remove from recurring (hide)'}
            aria-label={`Remove ${item.payee}`}
            style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: 0 }}
          >×</button>
        </div>
      ))}
      </div></div>

      {edit && (
        <AmountEditPopover
          item={edit.item}
          rect={edit.rect}
          money={money}
          onSave={amt => { if (Math.abs(amt - edit.item.monthlyAvg) > 0.005) onEditAmount(edit.item.merchant, amt); setEdit(null); }}
          onReset={() => { onResetAmount(edit.item.merchant); setEdit(null); }}
          onClose={() => setEdit(null)}
        />
      )}
    </div>
  );
}

// Small popover for editing one item's monthly amount, anchored under the cell.
// Offers quick fills that spread the original charge across its billing period —
// monthly (×1), quarterly (÷3), or annual (÷12) — to land on the right monthly
// run-rate, plus (for an overridden auto item) a reset back to the detected amount.
function AmountEditPopover({ item, rect, money, onSave, onReset, onClose }: {
  item: RecurringItem;
  rect: DOMRect;
  money: (n: number) => string;
  onSave: (amount: number) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const [draft, setDraft] = useState(String(round2(item.monthlyAvg)));
  const base = item.lastAmount || item.monthlyAvg; // the original (last) charge amount
  const save = () => { const v = parseFloat(draft); if (v > 0) onSave(v); else onClose(); };

  const W = 244;
  const left = Math.max(8, Math.min(rect.right - W, window.innerWidth - W - 8));
  const top = Math.min(rect.bottom + 6, window.innerHeight - 230);

  const chip = (label: string, value: number) => (
    <button onMouseDown={e => e.preventDefault()} onClick={() => setDraft(String(round2(value)))}
      style={{ flex: 1, fontSize: 11, padding: '6px 4px', borderRadius: 8, background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)', cursor: 'pointer', lineHeight: 1.3 }}>
      <div style={{ fontWeight: 600 }}>{label}</div>
      <div style={{ color: 'var(--muted)' }}>{money(value)}/mo</div>
    </button>
  );

  return createPortal(
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 5200 }}>
      <div onClick={e => e.stopPropagation()}
        style={{ position: 'fixed', top, left, width: W, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, boxShadow: '0 16px 44px rgba(0,0,0,0.55)', padding: 14 }}>
        <p style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>Monthly amount</p>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
          <span style={{ position: 'absolute', marginLeft: 9, color: 'var(--muted)', fontSize: 13 }}>$</span>
          <input value={draft} onChange={e => setDraft(e.target.value)} autoFocus inputMode="decimal"
            onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') onClose(); }}
            style={{ width: '100%', padding: '7px 10px 7px 18px', fontSize: 14, textAlign: 'right' }} />
        </div>

        <p style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 6 }}>If the {money(base)} charge is billed:</p>
        <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
          {chip('Monthly', base)}
          {chip('Quarterly', base / 3)}
          {chip('Annual', base / 12)}
        </div>

        {item.edited && (
          <button onMouseDown={e => e.preventDefault()} onClick={onReset}
            style={{ width: '100%', fontSize: 12, padding: '7px', borderRadius: 8, background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)', cursor: 'pointer', marginBottom: 10 }}>
            ↩ Reset to detected amount
          </button>
        )}

        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn-ghost" onClick={onClose} style={{ flex: 1, fontSize: 13, padding: '7px' }}>Cancel</button>
          <button className="btn-primary" onClick={save} style={{ flex: 1, fontSize: 13, padding: '7px' }}>Save</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
