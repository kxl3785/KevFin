import { useState } from 'react';
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
}

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

export default function Recurring({ onNavigate, privacy, onTogglePrivacy, embedded }: {
  onNavigate: (v: View) => void;
  privacy: boolean;
  onTogglePrivacy: () => void;
  embedded?: boolean;
}) {
  const { data, loading, error, refetch } = useApi<RecurringItem[]>('/api/recurring');
  const money = (n: number) => (privacy ? '••••••' : '$' + n.toFixed(2));
  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState('All');

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

  const items = data ?? [];
  const allCats = ['All', ...new Set(items.map(i => i.category))];

  const q = search.trim().toLowerCase();
  const filtered = items.filter(item =>
    (catFilter === 'All' || item.category === catFilter) &&
    (!q || item.payee.toLowerCase().includes(q) || item.category.toLowerCase().includes(q))
  );

  const fixed = filtered.filter(i => i.isFixed);
  const flexible = filtered.filter(i => !i.isFixed);

  const totalFixed = fixed.reduce((s, i) => s + i.monthlyAvg, 0);
  const totalFlexible = flexible.reduce((s, i) => s + i.monthlyAvg, 0);

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
          {/* Summary cards */}
          <div className="stack-mobile" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 24 }}>
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 18px' }}>
              <p style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 4 }}>Fixed / Committed · monthly</p>
              <p style={{ fontSize: 22, fontWeight: 700, color: 'var(--red)' }}>{money(totalFixed)}</p>
              <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 4 }}>{fixed.length} recurring items</p>
            </div>
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 18px' }}>
              <p style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 4 }}>Flexible Recurring · monthly</p>
              <p style={{ fontSize: 22, fontWeight: 700, color: 'var(--accent)' }}>{money(totalFlexible)}</p>
              <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 4 }}>{flexible.length} recurring items · cancellable</p>
            </div>
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

          {/* Fixed / Committed */}
          {fixed.length > 0 && (
            <Section
              title="Fixed Commitments"
              subtitle="Mortgage and utility bills — difficult to cancel or reduce short-term."
              items={fixed}
              money={money}
              onRemove={removeItem}
            />
          )}

          {/* Flexible */}
          {flexible.length > 0 && (
            <Section
              title="Flexible Recurring"
              subtitle="Subscriptions, memberships and recurring services — review what you can cut."
              items={flexible}
              money={money}
              onRemove={removeItem}
            />
          )}

          {filtered.length === 0 && (
            <p style={{ color: 'var(--muted)', fontSize: 14 }}>No recurring items match your filter.</p>
          )}
        </>
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

function Section({ title, subtitle, items, money, onRemove }: {
  title: string;
  subtitle: string;
  items: RecurringItem[];
  money: (n: number) => string;
  onRemove: (merchant: string) => void;
}) {
  const monthlyTotal = items.reduce((s, i) => s + i.monthlyAvg, 0);
  const GRID = '3fr 1fr 1fr 1fr 90px 32px';

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
        <div key={item.merchant} style={{ display: 'grid', gridTemplateColumns: GRID, gap: 8, alignItems: 'center', fontSize: 13, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <MerchantIcon merchant={item.merchant} label={item.payee} size={28} />
            <div style={{ minWidth: 0 }}>
              <p style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {item.payee}
                {item.manual && <span style={{ marginLeft: 6, fontSize: 9, color: 'var(--accent)', border: '1px solid var(--accent)', borderRadius: 9, padding: '0px 6px', textTransform: 'uppercase', letterSpacing: 0.4, verticalAlign: 'middle' }}>added</span>}
              </p>
              <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1 }}>{item.manual ? 'added manually' : `last ${fmtDate(item.lastDate)}`}</p>
            </div>
          </div>
          <span style={{ textAlign: 'right', fontWeight: 600 }}>{money(item.monthlyAvg)}</span>
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
            onClick={() => onRemove(item.merchant)}
            title={item.manual ? 'Delete this manual item' : 'Remove from recurring (hide)'}
            aria-label={`Remove ${item.payee}`}
            style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: 0 }}
          >×</button>
        </div>
      ))}
      </div></div>
    </div>
  );
}
