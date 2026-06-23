import { useState, useEffect, useCallback } from 'react';
import NetWorthChart from './components/NetWorthChart.tsx';
import ConnectSimpleFIN from './components/ConnectSimpleFIN.tsx';
import ConnectPlaid from './components/ConnectPlaid.tsx';
import AddProperty from './components/AddProperty.tsx';
import Allocation from './pages/Allocation.tsx';
import Budget from './pages/Budget.tsx';
import Forecast from './pages/Forecast.tsx';
import TopNav, { type View } from './components/TopNav.tsx';
import { useApi } from './hooks/useApi.ts';
import { usePersistentState } from './hooks/usePersistentState.ts';

interface Snapshot {
  date: string;
  accounts_total: number;
  real_estate_total: number;
  net_worth: number;
}

type Category = 'banking' | 'brokerage' | 'credit' | 'other';

const CATEGORY_LABELS: Record<Category, string> = {
  banking: 'Cash & Banking',
  brokerage: 'Brokerage',
  credit: 'Credit Cards',
  other: 'Other Accounts',
};
const CATEGORY_ORDER: Category[] = ['brokerage', 'banking', 'credit', 'other'];

interface Account {
  id: string;
  org_name: string;
  name: string;
  renamed: number; // 0/1 from SQLite
  balance: number;
  currency: string;
  category: Category;
  hidden: number; // 0/1 from SQLite
  updated_at: string;
}

interface ManualAsset {
  id: number;
  name: string;
  category: Category;
  value: number;
  updated_at: string;
}

interface Property {
  id: number;
  address: string;
  zestimate: number | null;
  mortgage_balance: number;
  // Amortization inputs — when principal + rate + start are set, mortgage_balance
  // is computed from a standard schedule server-side instead of entered manually.
  mortgage_principal: number | null;
  mortgage_rate: number | null;
  mortgage_start: string | null;
  mortgage_term_years: number | null;
  updated_at: string;
}

interface Connection {
  id: number;
  account_count: number;
  institutions: string;
  created_at: string;
}

interface PlaidItem {
  item_id: string;
  institution_name: string;
  account_count: number;
  created_at: string;
}

function EditableField({ label, initialValue, color, onSave }: {
  label: string;
  initialValue: number | null;
  color: string;
  onSave: (v: number) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(initialValue ?? ''));

  async function save() {
    await onSave(parseNum(value));
    setEditing(false);
  }

  if (editing) {
    return (
      <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
        <input
          value={value}
          onChange={e => setValue(e.target.value)}
          style={{ width: 100, padding: '4px 8px', fontSize: 13 }}
          autoFocus
          onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
        />
        <button className="btn-primary" style={{ fontSize: 11, padding: '4px 8px' }} onClick={save}>Save</button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}>
      <span style={{ color: 'var(--muted)', marginRight: 8 }}>{label}</span>
      <span
        style={{ fontWeight: 600, color, cursor: 'pointer' }}
        onClick={() => setEditing(true)}
        title="Click to edit"
      >{fmt(initialValue)} ✎</span>
    </div>
  );
}

// Parse a user-typed money/number string, tolerating commas, $ and spaces
// (e.g. "495,000" or "$495,000" → 495000). parseFloat alone stops at the comma,
// which silently truncates "495,000" to 495.
function parseNum(s: string): number {
  const n = parseFloat(String(s).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}

// Client-side mirror of server/src/util/amortization.ts — for the live preview
// of the remaining balance as the user types loan terms.
function estimateMortgageBalance(principal: number, ratePct: number, startISO: string, termYears: number): number {
  if (!principal || principal <= 0 || !startISO || !termYears) return 0;
  const start = new Date(startISO + 'T00:00:00');
  if (isNaN(start.getTime())) return 0;
  const now = new Date();
  const N = Math.round(termYears * 12);
  let k = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
  if (now.getDate() < start.getDate()) k -= 1;
  k = Math.max(0, Math.min(k, N));
  if (k >= N) return 0;
  const i = ratePct / 100 / 12;
  if (i === 0) return Math.max(0, principal * (1 - k / N));
  const g = Math.pow(1 + i, N), gk = Math.pow(1 + i, k);
  const pay = (principal * (i * g)) / (g - 1);
  return Math.max(0, principal * gk - (pay * (gk - 1)) / i);
}

function dateLabel(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function PropertyRow({ property: p, onRemove, onUpdate }: {
  property: Property;
  onRemove: (id: number) => void;
  onUpdate: () => void;
}) {
  async function patch(body: object) {
    await fetch(`/api/properties/${p.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    onUpdate();
  }

  const hasTerms = p.mortgage_principal != null && p.mortgage_rate != null && !!p.mortgage_start;
  const equity = (p.zestimate ?? 0) - (p.mortgage_balance ?? 0);

  const [editing, setEditing] = useState(false);
  const [principal, setPrincipal] = useState(p.mortgage_principal != null ? String(p.mortgage_principal) : '');
  const [rate, setRate] = useState(p.mortgage_rate != null ? String(p.mortgage_rate) : '');
  const [start, setStart] = useState(p.mortgage_start ?? ''); // YYYY-MM-DD for the date input
  const [term, setTerm] = useState(p.mortgage_term_years != null ? String(p.mortgage_term_years) : '30');

  async function saveTerms() {
    const pr = parseNum(principal);
    if (!pr || !start) return; // need at least a principal and a start month
    await patch({
      mortgage_principal: pr,
      mortgage_rate: parseNum(rate),
      mortgage_start: start,
      mortgage_term_years: Math.round(parseNum(term)) || 30,
    });
    setEditing(false);
  }
  async function clearTerms() {
    await patch({ mortgage_principal: null, mortgage_rate: null, mortgage_start: null, mortgage_term_years: null });
    setEditing(false);
  }

  const preview = estimateMortgageBalance(parseNum(principal), parseNum(rate), start, Math.round(parseNum(term)) || 30);

  const fieldLabel = { fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase' as const, letterSpacing: 0.3 };
  const fieldInput = { padding: '5px 8px', fontSize: 13 };

  return (
    <div style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <p style={{ fontWeight: 500, fontSize: 14 }}>{p.address}</p>
        <button
          className="btn-ghost"
          style={{ fontSize: 11, padding: '2px 8px', color: 'var(--red)' }}
          onClick={() => onRemove(p.id)}
        >Remove</button>
      </div>
      <EditableField label="Value" initialValue={p.zestimate} color="var(--green)"
        onSave={v => patch({ value: v })} />

      {/* Mortgage: read-only when amortized from loan terms, else manually editable */}
      {hasTerms ? (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}>
          <span style={{ color: 'var(--muted)', marginRight: 8 }}>
            Mortgage <span style={{ fontSize: 10, opacity: 0.6 }}>est.</span>
          </span>
          <span style={{ fontWeight: 600, color: 'var(--red)' }}>{fmt(p.mortgage_balance)}</span>
        </div>
      ) : (
        <EditableField label="Mortgage" initialValue={p.mortgage_balance} color="var(--red)"
          onSave={v => patch({ mortgage_balance: v })} />
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginTop: 4 }}>
        <span style={{ color: 'var(--muted)' }}>Equity</span>
        <span style={{ fontWeight: 700, color: equity >= 0 ? 'var(--accent)' : 'var(--red)' }}>{fmt(equity)}</span>
      </div>

      {/* Loan-terms estimator */}
      <div style={{ marginTop: 6 }}>
        {!editing && hasTerms && (
          <p style={{ fontSize: 11, color: 'var(--muted)' }}>
            {fmt(p.mortgage_principal)} at {p.mortgage_rate}% · {p.mortgage_term_years ?? 30}-yr from {dateLabel(p.mortgage_start)}
            <span onClick={() => setEditing(true)} style={{ color: 'var(--accent)', cursor: 'pointer', marginLeft: 8 }}>edit</span>
          </p>
        )}
        {!editing && !hasTerms && (
          <span onClick={() => setEditing(true)} style={{ fontSize: 11, color: 'var(--accent)', cursor: 'pointer' }}>
            ⚙ Estimate from loan terms
          </span>
        )}
        {editing && (
          <div style={{ marginTop: 6, padding: 10, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8 }}>
            <p style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8 }}>
              Estimate the remaining balance from a standard amortization schedule.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <span style={fieldLabel}>Original loan</span>
                <input value={principal} onChange={e => setPrincipal(e.target.value)} placeholder="500000" style={fieldInput} />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <span style={fieldLabel}>Interest rate %</span>
                <input value={rate} onChange={e => setRate(e.target.value)} placeholder="6.5" style={fieldInput} />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <span style={fieldLabel}>Start date</span>
                <input type="date" value={start} onChange={e => setStart(e.target.value)} style={fieldInput} />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <span style={fieldLabel}>Term (years)</span>
                <input value={term} onChange={e => setTerm(e.target.value)} placeholder="30" style={fieldInput} />
              </label>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                Balance today: <strong style={{ color: 'var(--text)' }}>{fmt(preview)}</strong>
              </span>
              <div style={{ display: 'flex', gap: 6 }}>
                {hasTerms && (
                  <button className="btn-ghost" onClick={clearTerms} style={{ fontSize: 11, padding: '4px 8px', color: 'var(--red)' }}>Clear</button>
                )}
                <button className="btn-ghost" onClick={() => setEditing(false)} style={{ fontSize: 11, padding: '4px 8px' }}>Cancel</button>
                <button className="btn-primary" onClick={saveTerms} style={{ fontSize: 11, padding: '4px 8px' }}>Save</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

type RangeKey = '1M' | '3M' | '6M' | 'YTD' | '1Y' | '3Y' | '5Y' | 'ALL';
const RANGES: RangeKey[] = ['1M', '3M', '6M', 'YTD', '1Y', '3Y', '5Y', 'ALL'];

// Earliest 'YYYY-MM-DD' to include for a given range ('' = no lower bound).
function rangeCutoff(range: RangeKey): string {
  const d = new Date();
  switch (range) {
    case '1M': d.setMonth(d.getMonth() - 1); break;
    case '3M': d.setMonth(d.getMonth() - 3); break;
    case '6M': d.setMonth(d.getMonth() - 6); break;
    case '1Y': d.setFullYear(d.getFullYear() - 1); break;
    case '3Y': d.setFullYear(d.getFullYear() - 3); break;
    case '5Y': d.setFullYear(d.getFullYear() - 5); break;
    case 'YTD': return `${new Date().getFullYear()}-01-01`;
    case 'ALL': return '';
  }
  return d.toISOString().slice(0, 10);
}

const INDEX_OPTIONS: { key: string; symbol: string; label: string }[] = [
  { key: 'none', symbol: '', label: 'No index' },
  { key: 'sp500', symbol: 'SPY', label: 'S&P 500' },
  { key: 'qqq', symbol: 'QQQ', label: 'Nasdaq 100 (QQQ)' },
  { key: 'target', symbol: 'VFIFX', label: 'Target Retmt 2050' },
];

// When privacy mode is on, all money is masked. Set from App's render so the
// whole subtree (which re-renders on toggle) picks it up without prop-drilling.
let HIDE_BALANCES = false;

function fmt(n: number | null) {
  if (HIDE_BALANCES) return '••••••';
  if (n == null) return '—';
  return '$' + Math.round(n).toLocaleString();
}

const CAT_OPTIONS: { value: Category; label: string }[] = [
  { value: 'brokerage', label: 'Brokerage' },
  { value: 'banking', label: 'Cash & Banking' },
  { value: 'credit', label: 'Credit Cards' },
  { value: 'other', label: 'Other' },
];

function AccountRow({ account: a, byInstitution, onRename, onHide }: {
  account: Account;
  byInstitution: boolean;
  onRename: (id: string, name: string | null) => void;
  onHide: (id: string, hidden: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(a.name);

  function commit() {
    if (draft.trim() && draft.trim() !== a.name) onRename(a.id, draft.trim());
    setEditing(false);
  }

  return (
    <div
      draggable={!editing}
      onDragStart={e => { e.dataTransfer.setData('text/plain', a.id); e.dataTransfer.effectAllowed = 'move'; }}
      style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '5px 0', fontSize: 13, cursor: editing ? 'text' : 'grab',
      }}
    >
      <span style={{ color: 'var(--muted)', fontSize: 12, marginRight: 6, cursor: 'grab' }} title="Drag to another section">⠿</span>
      {editing ? (
        <input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          autoFocus
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
          style={{ flex: 1, marginRight: 8, padding: '2px 6px', fontSize: 13 }}
        />
      ) : (
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <span
            onClick={() => { setDraft(a.name); setEditing(true); }}
            title="Click to rename"
            style={{ cursor: 'pointer' }}
          >{a.name} <span style={{ fontSize: 10, opacity: 0.5 }}>✎</span></span>
          {!byInstitution && <span style={{ fontSize: 11, color: 'var(--muted)' }}> ({a.org_name})</span>}
          {a.renamed ? (
            <span onClick={() => onRename(a.id, null)} title="Reset to original name"
              style={{ fontSize: 10, color: 'var(--muted)', cursor: 'pointer', marginLeft: 6 }}>reset</span>
          ) : null}
        </span>
      )}
      <span
        onClick={() => onHide(a.id, true)}
        title="Hide from list and net worth"
        style={{ fontSize: 11, color: 'var(--muted)', cursor: 'pointer', marginRight: 8, opacity: 0.6 }}
      >hide</span>
      <span style={{ color: a.balance < 0 ? 'var(--red)' : 'var(--text)', minWidth: 80, textAlign: 'right' }}>
        {fmt(a.balance)}
      </span>
    </div>
  );
}

function AccountGroups({ accounts, byInstitution, onRecategorize, onRename, onHide }: {
  accounts: Account[];
  byInstitution: boolean;
  onRecategorize: (id: string, category: Category) => void;
  onRename: (id: string, name: string | null) => void;
  onHide: (id: string, hidden: boolean) => void;
}) {
  const [overCat, setOverCat] = useState<Category | null>(null);
  const [collapsedList, setCollapsedList] = usePersistentState<Category[]>('mon.collapsedCategories', []);
  const [collapsedInst, setCollapsedInst] = usePersistentState<string[]>('mon.collapsedInstitutions', []);
  const [showHidden, setShowHidden] = usePersistentState<boolean>('mon.showHidden', false);
  const collapsed = new Set(collapsedList);
  const collapsedInstSet = new Set(collapsedInst);

  function toggleCollapse(cat: Category) {
    setCollapsedList(prev => (prev.includes(cat) ? prev.filter(c => c !== cat) : [...prev, cat]));
  }
  // Keyed by `${category}|${org}` so an institution that appears in more than one
  // category (e.g. a brokerage that also has a credit card) collapses independently.
  function toggleInstitution(key: string) {
    setCollapsedInst(prev => (prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]));
  }

  const visible = accounts.filter(a => !a.hidden);
  const hidden = accounts.filter(a => a.hidden);

  return (
    <div style={{ marginTop: 8 }}>
      {CATEGORY_ORDER.map(cat => {
        const rows = visible.filter(a => a.category === cat);
        const subtotal = rows.reduce((s, a) => s + a.balance, 0);
        const orgs = byInstitution ? [...new Set(rows.map(r => r.org_name))].sort() : [null];
        const isOver = overCat === cat;
        const isCollapsed = collapsed.has(cat);

        return (
          <div
            key={cat}
            onDragOver={e => { e.preventDefault(); if (overCat !== cat) setOverCat(cat); }}
            onDragLeave={() => setOverCat(c => (c === cat ? null : c))}
            onDrop={e => {
              e.preventDefault();
              const id = e.dataTransfer.getData('text/plain');
              setOverCat(null);
              if (id) onRecategorize(id, cat);
            }}
            style={{
              marginTop: 12, padding: '6px 8px', borderRadius: 8,
              border: isOver ? '1px dashed var(--accent)' : '1px solid transparent',
              background: isOver ? 'rgba(108,143,255,0.08)' : 'transparent',
              transition: 'background 0.1s',
            }}
          >
            <div
              onClick={() => toggleCollapse(cat)}
              style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                fontSize: 12, fontWeight: 700, textTransform: 'uppercase',
                letterSpacing: 0.5, color: 'var(--muted)', marginBottom: 4, cursor: 'pointer',
              }}
            >
              <span>
                <span style={{ display: 'inline-block', width: 12, opacity: 0.7 }}>{isCollapsed ? '▸' : '▾'}</span>
                {CATEGORY_LABELS[cat]}
                {isCollapsed && rows.length > 0 && (
                  <span style={{ opacity: 0.5, fontWeight: 400, marginLeft: 6 }}>({rows.length})</span>
                )}
              </span>
              <span>{fmt(subtotal)}</span>
            </div>
            {isCollapsed ? null : rows.length === 0 ? (
              <p style={{ fontSize: 12, color: 'var(--muted)', opacity: 0.6, padding: '4px 0' }}>
                Drag an account here…
              </p>
            ) : (
              orgs.map(org => {
                const orgRows = org === null ? rows : rows.filter(r => r.org_name === org);
                const instKey = `${cat}|${org}`;
                const instCollapsed = byInstitution && org !== null && collapsedInstSet.has(instKey);
                const orgSubtotal = orgRows.reduce((s, a) => s + a.balance, 0);
                return (
                  <div key={org ?? '_all'} style={{ marginLeft: byInstitution ? 8 : 0 }}>
                    {byInstitution && org !== null && (
                      <div
                        onClick={() => toggleInstitution(instKey)}
                        title={instCollapsed ? 'Expand institution' : 'Collapse institution'}
                        style={{
                          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          fontSize: 12, fontWeight: 600, color: 'var(--text)', marginTop: 6,
                          cursor: 'pointer', padding: '2px 0',
                        }}
                      >
                        <span>
                          <span style={{ display: 'inline-block', width: 12, opacity: 0.6 }}>{instCollapsed ? '▸' : '▾'}</span>
                          {org}
                          {instCollapsed && orgRows.length > 0 && (
                            <span style={{ opacity: 0.5, fontWeight: 400, marginLeft: 6 }}>({orgRows.length})</span>
                          )}
                        </span>
                        <span style={{ color: 'var(--muted)' }}>{fmt(orgSubtotal)}</span>
                      </div>
                    )}
                    {!instCollapsed && orgRows.map(a => (
                      <AccountRow key={a.id} account={a} byInstitution={byInstitution} onRename={onRename} onHide={onHide} />
                    ))}
                  </div>
                );
              })
            )}
          </div>
        );
      })}

      {/* Hidden accounts — excluded from net worth, reversible */}
      {hidden.length > 0 && (
        <div style={{ marginTop: 16, paddingTop: 10, borderTop: '1px dashed var(--border)' }}>
          <span
            onClick={() => setShowHidden(s => !s)}
            style={{ fontSize: 12, color: 'var(--muted)', cursor: 'pointer' }}
          >
            {showHidden ? '▾' : '▸'} Hidden accounts ({hidden.length}) · excluded from net worth
          </span>
          {showHidden && hidden.map(a => (
            <div key={a.id} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '5px 0', fontSize: 13, opacity: 0.6,
            }}>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {a.name} <span style={{ fontSize: 11, color: 'var(--muted)' }}>({a.org_name})</span>
              </span>
              <span onClick={() => onHide(a.id, false)} title="Unhide"
                style={{ fontSize: 11, color: 'var(--accent)', cursor: 'pointer', marginRight: 8 }}>unhide</span>
              <span style={{ minWidth: 80, textAlign: 'right' }}>{fmt(a.balance)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ManualAssetRow({ asset, onUpdate }: { asset: ManualAsset; onUpdate: () => void }) {
  async function patch(body: object) {
    await fetch(`/api/assets/${asset.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    onUpdate();
  }
  async function remove() {
    await fetch(`/api/assets/${asset.id}`, { method: 'DELETE' });
    onUpdate();
  }
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '8px 0', borderBottom: '1px solid var(--border)',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ fontWeight: 500, fontSize: 14 }}>{asset.name}</p>
        <select
          value={asset.category}
          onChange={e => patch({ category: e.target.value })}
          style={{ background: 'transparent', border: 'none', color: 'var(--muted)', fontSize: 11, cursor: 'pointer', paddingLeft: 0 }}
        >
          {CAT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      <EditableField label="" initialValue={asset.value} color="var(--green)" onSave={v => patch({ value: v })} />
      <button className="btn-ghost" style={{ fontSize: 11, padding: '2px 8px', color: 'var(--red)', marginLeft: 8 }}
        onClick={remove}>Remove</button>
    </div>
  );
}

function AddManualAsset({ onAdded }: { onAdded: () => void }) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [category, setCategory] = useState<Category>('other');
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setLoading(true);
    await fetch('/api/assets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, value: parseNum(value), category }),
    });
    setName(''); setValue(''); setCategory('other');
    setLoading(false);
    onAdded();
  }

  return (
    <form onSubmit={submit} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Treasury bonds" style={{ flex: 2, minWidth: 140 }} />
      <input value={value} onChange={e => setValue(e.target.value)} placeholder="Value" style={{ flex: 1, minWidth: 90 }} />
      <select value={category} onChange={e => setCategory(e.target.value as Category)}
        style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', fontSize: 14, padding: '0 8px' }}>
        {CAT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <button type="submit" className="btn-primary" disabled={loading} style={{ whiteSpace: 'nowrap' }}>
        {loading ? 'Adding…' : '+ Add Asset'}
      </button>
    </form>
  );
}

export default function App() {
  const [view, setView] = useState<View>('dashboard');
  const [refreshing, setRefreshing] = useState(false);
  const [byInstitution, setByInstitution] = usePersistentState('mon.byInstitution', true);
  const [privacy, setPrivacy] = usePersistentState('mon.privacy', false);
  const [range, setRange] = usePersistentState<RangeKey>('mon.range', 'ALL');
  const [chartMode, setChartMode] = usePersistentState<'stacked' | 'lines'>('mon.chartMode', 'stacked');
  const [backfilling, setBackfilling] = useState(false);
  const [excluded, setExcluded] = usePersistentState<string[]>('mon.excluded', []);
  const [indexKey, setIndexKey] = usePersistentState('mon.indexKey', 'none');
  const [indexSeries, setIndexSeries] = useState<{ date: string; close: number }[]>([]);
  HIDE_BALANCES = privacy; // synced each render so fmt() everywhere honors it

  const showAccounts = !excluded.includes('accounts');
  const showRealEstate = !excluded.includes('real_estate');
  const indexOpt = INDEX_OPTIONS.find(o => o.key === indexKey) ?? INDEX_OPTIONS[0];

  // Switching views should land at the top, not wherever the last view was scrolled.
  useEffect(() => { window.scrollTo(0, 0); }, [view]);

  // Fetch the comparison index series when the selection changes.
  useEffect(() => {
    if (!indexOpt.symbol) { setIndexSeries([]); return; }
    let cancelled = false;
    fetch(`/api/net-worth/index?symbol=${encodeURIComponent(indexOpt.symbol)}`)
      .then(r => r.json())
      .then(d => { if (!cancelled) setIndexSeries(Array.isArray(d) ? d : []); })
      .catch(() => { if (!cancelled) setIndexSeries([]); });
    return () => { cancelled = true; };
  }, [indexOpt.symbol]);

  function toggleExclude(key: string) {
    setExcluded(prev => (prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]));
  }

  // Clicking a series in the chart legend toggles the same inclusion as the cards.
  function toggleSeries(dataKey: string) {
    if (dataKey === 'accounts_total') toggleExclude('accounts');
    else if (dataKey === 'real_estate_total') toggleExclude('real_estate');
  }

  const { data: history, refetch: refetchHistory } = useApi<Snapshot[]>('/api/net-worth/history?days=10000');
  const { data: breakdown, refetch: refetchBreakdown } = useApi<{ accounts: Account[]; manualAssets: ManualAsset[]; properties: Property[] }>('/api/net-worth/breakdown');
  const { data: connections, refetch: refetchConnections } = useApi<Connection[]>('/api/simplefin/connections');
  const { data: plaidItems, refetch: refetchPlaid } = useApi<PlaidItem[]>('/api/plaid/items');

  const latest = history?.[0];

  const refetchAll = useCallback(() => {
    refetchHistory();
    refetchBreakdown();
    refetchConnections();
    refetchPlaid();
  }, [refetchHistory, refetchBreakdown, refetchConnections, refetchPlaid]);

  async function triggerRefresh() {
    setRefreshing(true);
    await fetch('/api/net-worth/refresh', { method: 'POST' });
    refetchAll();
    setRefreshing(false);
  }

  async function triggerBackfill() {
    setBackfilling(true);
    await fetch('/api/net-worth/backfill', { method: 'POST' });
    refetchHistory();
    setBackfilling(false);
  }

  const visibleHistory = (history ?? []).filter(s => s.date >= rangeCutoff(range));

  // Apply category exclusions, recomputing the net-worth line.
  // Sort ascending so the index forward-fill below aligns correctly (the API
  // returns snapshots newest-first).
  const displayed = [...visibleHistory]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(s => {
      const acc = showAccounts ? s.accounts_total : 0;
      const re = showRealEstate ? s.real_estate_total : 0;
      // Pass zeroed values so the stacked area chart renders the correct height.
      return { date: s.date, accounts_total: acc, real_estate_total: re, net_worth: acc + re };
    });

  // Overlay the index, normalized so it starts at the displayed net worth.
  let chartData: (typeof displayed[number] & { index?: number | null })[] = displayed;
  if (indexSeries.length && displayed.length) {
    const filled: number[] = [];
    let i = 0;
    let last = indexSeries[0].close;
    for (const pt of displayed) {
      while (i < indexSeries.length && indexSeries[i].date <= pt.date) { last = indexSeries[i].close; i++; }
      filled.push(last);
    }
    const factor = filled[0] ? displayed[0].net_worth / filled[0] : 1;
    chartData = displayed.map((pt, k) => ({ ...pt, index: filled[k] * factor }));
  }

  async function removeProperty(id: number) {
    await fetch(`/api/properties/${id}`, { method: 'DELETE' });
    refetchAll();
  }

  async function removeConnection(id: number) {
    await fetch(`/api/simplefin/connections/${id}`, { method: 'DELETE' });
    refetchAll();
  }

  async function removePlaidItem(itemId: string) {
    await fetch(`/api/plaid/items/${itemId}`, { method: 'DELETE' });
    refetchAll();
  }

  async function recategorize(id: string, category: Category) {
    await fetch(`/api/simplefin/accounts/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category }),
    });
    refetchAll();
  }

  async function renameAccount(id: string, name: string | null) {
    await fetch(`/api/simplefin/accounts/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    refetchAll();
  }

  async function hideAccount(id: string, hidden: boolean) {
    await fetch(`/api/simplefin/accounts/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hidden }),
    });
    refetchAll();
  }

  if (view === 'allocation')
    return <Allocation onNavigate={setView} privacy={privacy} onTogglePrivacy={() => setPrivacy(p => !p)} />;
  if (view === 'budget')
    return <Budget onNavigate={setView} privacy={privacy} onTogglePrivacy={() => setPrivacy(p => !p)} />;
  if (view === 'forecast')
    return <Forecast onNavigate={setView} privacy={privacy} onTogglePrivacy={() => setPrivacy(p => !p)} />;

  return (
    <div style={{ maxWidth: 960, margin: '0 auto', padding: '32px 24px' }}>
      {/* Persistent nav + icon actions */}
      <TopNav
        view="dashboard"
        onNavigate={setView}
        privacy={privacy}
        onTogglePrivacy={() => setPrivacy(p => !p)}
        onRefresh={triggerRefresh}
        refreshing={refreshing}
      />

      {/* Title */}
      <div style={{ marginBottom: 32 }}>
        <h1 style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.5px' }}>KevFin</h1>
        <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 4 }}>Net Worth Tracker</p>
      </div>

      {/* KPI cards — Accounts / Real Estate toggle their inclusion in the graph */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 32 }}>
        {[
          {
            label: 'Net Worth',
            value: latest ? (showAccounts ? latest.accounts_total : 0) + (showRealEstate ? latest.real_estate_total : 0) : null,
            color: 'var(--accent)', key: null, excluded: false,
          },
          { label: 'Accounts', value: latest?.accounts_total ?? null, color: 'var(--amber)', key: 'accounts', excluded: !showAccounts },
          { label: 'Real Estate', value: latest?.real_estate_total ?? null, color: 'var(--green)', key: 'real_estate', excluded: !showRealEstate },
        ].map(card => {
          const isHero = card.key === null;
          return (
          <div
            key={card.label}
            onClick={() => card.key && toggleExclude(card.key)}
            title={card.key ? (card.excluded ? 'Click to include in graph' : 'Click to exclude from graph') : undefined}
            style={{
              background: isHero ? 'var(--accent-dim)' : 'var(--surface)',
              border: `1px solid ${isHero ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: 12, padding: '20px 24px',
              cursor: card.key ? 'pointer' : 'default',
              opacity: card.excluded ? 0.45 : 1,
              transition: 'opacity 0.12s',
            }}
          >
            <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 8 }}>
              {card.label}
              {card.excluded && <span style={{ fontSize: 11, marginLeft: 6 }}>(hidden)</span>}
            </p>
            <p style={{
              fontSize: isHero ? 30 : 26, fontWeight: 700, color: card.color,
              textDecoration: card.excluded ? 'line-through' : 'none',
            }}>{fmt(card.value)}</p>
          </div>
          );
        })}
      </div>

      {/* Chart */}
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 12, padding: '24px', marginBottom: 32,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <h2 style={{ fontSize: 16, fontWeight: 600 }}>History</h2>
            {/* Chart style: stacked composition vs zoomed trend lines */}
            <div style={{ display: 'flex', gap: 2, background: 'var(--bg)', borderRadius: 8, padding: 2 }}>
              {(['stacked', 'lines'] as const).map(m => (
                <button
                  key={m}
                  onClick={() => setChartMode(m)}
                  title={m === 'stacked' ? 'Stacked composition (from $0)' : 'Trend lines, zoomed to show change'}
                  style={{
                    padding: '4px 10px', fontSize: 12, borderRadius: 6,
                    background: chartMode === m ? 'var(--accent)' : 'transparent',
                    color: chartMode === m ? '#fff' : 'var(--muted)',
                  }}
                >{m === 'stacked' ? 'Stacked' : 'Lines'}</button>
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {/* Range selector */}
            <div style={{ display: 'flex', gap: 2, background: 'var(--bg)', borderRadius: 8, padding: 2 }}>
              {RANGES.map(r => (
                <button
                  key={r}
                  onClick={() => setRange(r)}
                  style={{
                    padding: '4px 10px', fontSize: 12, borderRadius: 6,
                    background: range === r ? 'var(--accent)' : 'transparent',
                    color: range === r ? '#fff' : 'var(--muted)',
                  }}
                >{r}</button>
              ))}
            </div>
            <select
              value={indexKey}
              onChange={e => setIndexKey(e.target.value)}
              title="Compare against an index"
              style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', fontSize: 12, padding: '4px 8px' }}
            >
              {INDEX_OPTIONS.map(o => <option key={o.key} value={o.key}>{o.key === 'none' ? 'Compare…' : `vs ${o.label}`}</option>)}
            </select>
            <button className="btn-ghost" onClick={triggerBackfill} disabled={backfilling}
              style={{ fontSize: 12, padding: '4px 10px' }}
              title="Reconstruct ~5 years: cash/credit from transactions; brokerage from holdings × historical market prices; real estate from the Zillow Home Value Index (ZHVI) for the ZIP, anchored to the current Zestimate">
              {backfilling ? 'Backfilling…' : '⟲ Backfill'}
            </button>
          </div>
        </div>
        {visibleHistory.length > 0
          ? <div style={{ filter: privacy ? 'blur(10px)' : 'none', transition: 'filter 0.15s', pointerEvents: privacy ? 'none' : 'auto' }}>
              <NetWorthChart
                data={chartData}
                mode={chartMode}
                showAccounts={showAccounts}
                showRealEstate={showRealEstate}
                indexLabel={indexOpt.symbol ? indexOpt.label : undefined}
                onToggleSeries={toggleSeries}
              />
            </div>
          : <p style={{ color: 'var(--muted)', textAlign: 'center', padding: '40px 0' }}>
              {history && history.length > 0
                ? 'No snapshots in this range — try a wider one or click Backfill.'
                : 'No history yet — click Backfill to reconstruct it, or Refresh Now for today.'}
            </p>
        }
        {visibleHistory.length > 0 && (
          <p style={{ color: 'var(--muted)', fontSize: 11, marginTop: 10, opacity: 0.7 }}>
            Historical points reconstruct cash & credit from transactions, brokerage from each holding's
            historical market price (untickered index funds like 529 portfolios use proxy ETFs), and real
            estate from the Zillow Home Value Index (ZHVI) for the ZIP, anchored to the current Zestimate.
            Crypto is held flat. Daily snapshots capture changes going forward.
          </p>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
        {/* Institutions */}
        <div style={{
          background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 24,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <h2 style={{ fontSize: 16, fontWeight: 600 }}>Financial Accounts</h2>
            {breakdown?.accounts && breakdown.accounts.length > 0 && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={byInstitution}
                  onChange={e => setByInstitution(e.target.checked)}
                  style={{ width: 'auto', cursor: 'pointer' }}
                />
                Group by institution
              </label>
            )}
          </div>

          {/* Account balances first */}
          {breakdown?.accounts && breakdown.accounts.length > 0
            ? <AccountGroups
                accounts={breakdown.accounts}
                byInstitution={byInstitution}
                onRecategorize={recategorize}
                onRename={renameAccount}
                onHide={hideAccount}
              />
            : <p style={{ color: 'var(--muted)', fontSize: 14 }}>
                No accounts yet — connect an institution below.
              </p>
          }

          {/* Connections management + connect buttons at the bottom */}
          <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
            {connections?.map(conn => (
              <div key={conn.id} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0',
              }}>
                <div>
                  <p style={{ fontWeight: 500, fontSize: 13 }}>{conn.institutions || 'Pending…'}</p>
                  <p style={{ color: 'var(--muted)', fontSize: 12 }}>{conn.account_count} account{conn.account_count !== 1 ? 's' : ''}</p>
                </div>
                <button className="btn-ghost" style={{ fontSize: 12, padding: '4px 10px', color: 'var(--red)' }}
                  onClick={() => removeConnection(conn.id)}>Remove</button>
              </div>
            ))}
            {plaidItems?.map(item => (
              <div key={item.item_id} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0',
              }}>
                <div>
                  <p style={{ fontWeight: 500, fontSize: 13 }}>
                    {item.institution_name} <span style={{ fontSize: 10, color: 'var(--accent)' }}>via Plaid</span>
                  </p>
                  <p style={{ color: 'var(--muted)', fontSize: 12 }}>{item.account_count} account{item.account_count !== 1 ? 's' : ''}</p>
                </div>
                <button className="btn-ghost" style={{ fontSize: 12, padding: '4px 10px', color: 'var(--red)' }}
                  onClick={() => removePlaidItem(item.item_id)}>Remove</button>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <ConnectPlaid onSuccess={refetchAll} />
              <ConnectSimpleFIN onSuccess={refetchAll} />
            </div>
          </div>
        </div>

        {/* Properties */}
        <div style={{
          background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 24,
        }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>Real Estate</h2>
          <div>
            {breakdown?.properties && breakdown.properties.length === 0 && (
              <p style={{ color: 'var(--muted)', fontSize: 14 }}>No properties added yet.</p>
            )}
            {breakdown?.properties?.map(p => (
              <PropertyRow key={p.id} property={p} onRemove={removeProperty} onUpdate={refetchAll} />
            ))}
          </div>
          <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
            <AddProperty onAdded={refetchAll} />
          </div>
        </div>
      </div>

      {/* Manual assets (Treasury bonds, cash, collectibles, etc.) */}
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 12, padding: 24, marginTop: 24,
      }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>Manual Assets</h2>
        <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 16 }}>
          Anything not connected automatically — Treasury bonds, physical cash, private investments.
        </p>
        <div>
          {breakdown?.manualAssets && breakdown.manualAssets.length === 0 && (
            <p style={{ color: 'var(--muted)', fontSize: 14 }}>No manual assets added yet.</p>
          )}
          {breakdown?.manualAssets?.map(a => (
            <ManualAssetRow key={a.id} asset={a} onUpdate={refetchAll} />
          ))}
        </div>
        <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
          <AddManualAsset onAdded={refetchAll} />
        </div>
      </div>
    </div>
  );
}
