import { useState, useEffect, useCallback, useRef } from 'react';
import NetWorthChart from '../components/NetWorthChart.tsx';
import ConnectSimpleFIN from '../components/ConnectSimpleFIN.tsx';
import ConnectPlaid from '../components/ConnectPlaid.tsx';
import AddProperty from '../components/AddProperty.tsx';
import ZillowKey from '../components/ZillowKey.tsx';
import TopNav, { type View } from '../components/TopNav.tsx';
import { useApi } from '../hooks/useApi.ts';
import { usePersistentState } from '../hooks/usePersistentState.ts';
import { remainingMortgageBalance, monthlyMortgagePayment, amortizeYear } from '../lib/mortgage.ts';
import { parseNum, parseNumOrNull, sqliteUtcToIso } from '../lib/parseNum.ts';
import { RANGES, rangeCutoff, type RangeKey } from '../lib/dateRange.ts';
import { sinceLabel, visitTitle } from '../lib/sinceLabel.ts';
import { fmtMoney, fmtMoneyCompact, fmtDate, fmtMonth } from '../lib/format.ts';
import {
  accountMix, composedValue, headlineChanges, payoffMonth, sparkValues, type MixKey,
} from '../lib/dashboardSummary.ts';
import { institutionLogo } from '../lib/institutionLogo.ts';
import { relTime, newestTimestamp } from '../lib/relTime.ts';
import type {
  Snapshot, Account, ManualAsset, Property, Connection, PlaidItem, AccountCategory,
} from '@shared/apiTypes';

// The dashboard page: net-worth KPIs and history chart, connected accounts,
// real estate and manual assets. Extracted from App.tsx, which is now just the
// shell (routes, privacy state, the assistant). Response types come from the
// shared API contract (@shared/apiTypes) instead of hand-copied interfaces.

// The three headline figures, snapshotted so the dashboard can show how each has
// moved since the user's previous visit (persisted under `mon.lastSession`).
interface SessionSnapshot {
  net_worth: number;
  accounts_total: number;
  real_estate_total: number;
  // When this visit began (ISO). Optional: snapshots stored before it was added
  // still load, and just get the undated "since last visit" label.
  at?: string;
}

// Captured once per page load rather than per mount: the dashboard unmounts when
// the user visits another section, and re-reading the stored snapshot on return
// would compare this session against itself (always "+$0").
let sessionBaseline: SessionSnapshot | null = null;
let baselineCaptured = false;
// This page load's visit time (ISO), fixed on first use and stamped into the stored snapshot.
let visitAt: string | null = null;

type Category = AccountCategory;

const CATEGORY_LABELS: Record<Category, string> = {
  banking: 'Cash & Banking',
  brokerage: 'Brokerage',
  credit: 'Credit Cards',
  other: 'Other Accounts',
};
const CATEGORY_ORDER: Category[] = ['brokerage', 'banking', 'credit', 'other'];

// Text-link look for small actions (edit / hide / close …). They're real <button>s
// so they're keyboard-focusable; this strips the global button chrome.
const linkBtn: React.CSSProperties = {
  background: 'none', border: 'none', padding: 0, borderRadius: 4,
  fontFamily: 'inherit', fontSize: 11, fontWeight: 400, color: 'var(--accent)', cursor: 'pointer',
};

function EditableField({ label, initialValue, color, onSave, name }: {
  label: string;
  /** Accessible name when the visible label is empty (e.g. "I Bonds value"). */
  name?: string;
  initialValue: number | null;
  color: string;
  onSave: (v: number) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(initialValue ?? ''));

  async function save() {
    // Blank/unparseable input cancels — saving it as 0 would zero out a property
    // value (or any other figure) just because the field was cleared.
    const v = parseNumOrNull(value);
    if (v != null) await onSave(v);
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
      <button
        style={{ ...linkBtn, fontSize: 13, fontWeight: 600, color }}
        // Refresh the draft on open — the value may have changed (e.g. a sync)
        // since mount, and saving a stale draft would overwrite the fresh one.
        onClick={() => { setValue(String(initialValue ?? '')); setEditing(true); }}
        title="Click to edit"
        aria-label={`Edit ${name ?? (label || 'value')}`}
      >{fmt(initialValue)} ✎</button>
    </div>
  );
}

// Live preview of the remaining balance as the user types loan terms. The
// amortization math lives in ./lib/mortgage.ts (shared with the Forecast).
const estimateMortgageBalance = remainingMortgageBalance;

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n !== 1 ? 's' : ''}`;
}

function dateLabel(iso: string | null): string {
  return iso ? fmtDate(iso) : '';
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
  // No value yet → no equity to show (the mortgage still counts in the Home equity
  // card, as the server's snapshot does) rather than a misleading negative figure.
  const equity = p.zestimate == null ? null : p.zestimate - (p.mortgage_balance ?? 0);

  const [editing, setEditing] = useState(false);
  const [costsOpen, setCostsOpen] = useState(false);
  const [principal, setPrincipal] = useState(p.mortgage_principal != null ? String(p.mortgage_principal) : '');
  const [rate, setRate] = useState(p.mortgage_rate != null ? String(p.mortgage_rate) : '');
  const [start, setStart] = useState(p.mortgage_start ?? ''); // YYYY-MM-DD for the date input
  const [term, setTerm] = useState(p.mortgage_term_years != null ? String(p.mortgage_term_years) : '30');

  const [termsError, setTermsError] = useState<string | null>(null);
  // Open the loan-terms editor from what's saved, so a cancelled draft (or terms
  // just cleared) never reappears and gets saved by mistake.
  function openTerms() {
    setPrincipal(p.mortgage_principal != null ? String(p.mortgage_principal) : '');
    setRate(p.mortgage_rate != null ? String(p.mortgage_rate) : '');
    setStart(p.mortgage_start ?? '');
    setTerm(p.mortgage_term_years != null ? String(p.mortgage_term_years) : '30');
    setTermsError(null);
    setEditing(true);
  }
  async function saveTerms() {
    const pr = parseNum(principal);
    if (!pr || !start) { // need at least a principal and a start month
      setTermsError('Enter the original loan amount and the start date.');
      return;
    }
    setTermsError(null);
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

  // Card figures. LTV and the equity bar need a value; payoff needs loan terms.
  const owed = p.mortgage_balance ?? 0;
  const equityShare = p.zestimate != null && p.zestimate > 0 && equity != null
    ? Math.max(0, Math.min(1, equity / p.zestimate)) : null;
  const ltv = p.zestimate != null && p.zestimate > 0 && owed > 0 ? owed / p.zestimate : null;
  const payoff = hasTerms ? payoffMonth(p.mortgage_start, p.mortgage_term_years) : null;
  const comma = p.address.indexOf(',');
  const street = comma > 0 ? p.address.slice(0, comma) : p.address;
  const place = comma > 0 ? p.address.slice(comma + 1).trim() : '';
  // Four "—" rows read as missing data; until one is filled in they fold into one prompt.
  const hasCosts = [p.property_tax_annual, p.insurance_annual, p.hoa_annual, p.rental_income_annual].some(v => v != null);
  // Tax + insurance + HOA a year; mortgage interest is added below when known.
  const carryingYearly = (p.property_tax_annual ?? 0) + (p.insurance_annual ?? 0) + (p.hoa_annual ?? 0);
  // The mortgage payment over the next 12 months, split the same way the Budget
  // housing view does: interest is a cost (gone, like rent paid to the bank);
  // principal isn't — it moves cash into equity, so net worth doesn't drop.
  // Only known when loan terms are filled in.
  const loan = hasTerms
    ? amortizeYear(
        remainingMortgageBalance(p.mortgage_principal!, p.mortgage_rate!, p.mortgage_start!, p.mortgage_term_years ?? 30),
        p.mortgage_rate!,
        monthlyMortgagePayment(p.mortgage_principal!, p.mortgage_rate!, p.mortgage_term_years ?? 30))
    : null;
  const interestYearly = loan?.interest ?? 0;
  const principalYearly = loan?.principal ?? 0;
  const costsYearly = carryingYearly + interestYearly;
  // Net = rental income less every true cost of owning (interest included when
  // known). Cash flow also subtracts principal: what actually leaves the account.
  const incomeYearly = p.rental_income_annual ?? 0;
  const netYearly = incomeYearly - costsYearly;
  const cashFlowYearly = netYearly - principalYearly;
  const netColor = netYearly > 0 ? 'var(--green)' : netYearly < 0 ? 'var(--red)' : 'var(--text)';
  const costsTitle = loan
    ? 'Costs = property tax, insurance, HOA and the next 12 months of mortgage interest. Principal isn\'t a cost: it builds equity'
    : 'Costs = property tax, insurance and HOA. Add loan terms to include mortgage interest';

  return (
    <div className="db-prop">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <span className="db-house" aria-hidden="true">
          <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /><path d="M10 21v-6h4v6" />
          </svg>
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontWeight: 600, fontSize: 14, lineHeight: 1.3 }}>{street}</p>
          {place && <p className="db-sub">{place}</p>}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <EditableField label="Value" initialValue={p.zestimate} color="var(--text)"
          onSave={v => patch({ value: v })} />

        {/* Mortgage: read-only when amortized from loan terms, else manually editable */}
        {hasTerms ? (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}>
            <span style={{ color: 'var(--muted)', marginRight: 8 }}>
              Mortgage <span style={{ fontSize: 10, opacity: 0.8 }}>est.</span>
            </span>
            <span style={{ fontWeight: 600 }}>{fmt(p.mortgage_balance)}</span>
          </div>
        ) : (
          <EditableField label="Mortgage" initialValue={p.mortgage_balance} color="var(--text)"
            onSave={v => patch({ mortgage_balance: v })} />
        )}
      </div>

      {equityShare != null ? (
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="db-bar" style={{ height: 8 }} aria-hidden="true">
            <i style={{ width: `${equityShare * 100}%`, background: 'var(--green)' }} />
          </span>
          <span className="db-legend spread">
            <span>
              <span className="db-swatch" style={{ background: 'var(--green)' }} />Equity{' '}
              <strong style={{ color: equity != null && equity < 0 ? 'var(--red)' : 'var(--text)' }}>{fmt(equity)}</strong>
            </span>
            {owed > 0 && <span>Owed {fmt(owed)}</span>}
          </span>
        </div>
      ) : (
        <p className="db-sub" style={{ marginTop: 10 }}>
          Add a value to see equity (the mortgage still counts in Home equity above).
        </p>
      )}

      {(ltv != null || payoff || (hasTerms && p.mortgage_rate != null)) && (
        <div className="db-stats" style={{ marginTop: 12 }}>
          {hasTerms && p.mortgage_rate != null && <div className="db-stat"><span>Rate</span>{p.mortgage_rate}%</div>}
          {ltv != null && <div className="db-stat"><span>Loan-to-value</span>{(ltv * 100).toFixed(1)}%</div>}
          {payoff && <div className="db-stat"><span>Payoff</span>{fmtMonth(`${payoff}-01`)}</div>}
        </div>
      )}

      {/* Carrying costs & income (annual). Informational here; feed the Budget housing
          breakdown and the Forecast's housing cash flow. Folded to one summary row
          until opened, so each home stays short enough to sit beside the accounts. */}
      {costsOpen ? (
        <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.3 }}>Carrying costs / yr</span>
            <button onClick={() => setCostsOpen(false)} aria-expanded style={{ ...linkBtn, fontSize: 11 }}>done</button>
          </span>
          <EditableField label="Property tax" initialValue={p.property_tax_annual} color="var(--text)"
            onSave={v => patch({ property_tax_annual: v })} />
          <EditableField label="Insurance" initialValue={p.insurance_annual} color="var(--text)"
            onSave={v => patch({ insurance_annual: v })} />
          <EditableField label="HOA" initialValue={p.hoa_annual} color="var(--text)"
            onSave={v => patch({ hoa_annual: v })} />
          {loan && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}
                title="Interest over the next 12 months, from the loan terms. A true cost: it doesn't build equity">
                <span style={{ color: 'var(--muted)', marginRight: 8 }}>
                  Mortgage interest <span style={{ fontSize: 10, opacity: 0.8 }}>est.</span>
                </span>
                <span style={{ fontWeight: 600 }}>{fmt(interestYearly)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}
                title="Principal over the next 12 months. Not a cost: it moves cash into home equity">
                <span style={{ color: 'var(--muted)', marginRight: 8 }}>
                  Principal <span style={{ fontSize: 10, opacity: 0.8 }}>builds equity</span>
                </span>
                <span style={{ color: 'var(--muted)' }}>{fmt(principalYearly)}</span>
              </div>
            </>
          )}
          <EditableField label="Rental / income" initialValue={p.rental_income_annual} color="var(--green)"
            onSave={v => patch({ rental_income_annual: v })} />
          <div title={costsTitle} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, paddingTop: 6, borderTop: '1px dashed var(--border)' }}>
            <span style={{ color: 'var(--muted)', marginRight: 8 }}>
              Net / yr <span style={{ fontSize: 10, opacity: 0.8 }}>{loan ? 'after interest' : 'before mortgage'}</span>
            </span>
            <span style={{ fontWeight: 600, color: netColor }}>{fmtSigned(netYearly)}</span>
          </div>
          {loan && principalYearly > 0 && (
            <p className="db-sub" style={{ textAlign: 'right' }}>
              Cash flow after the full payment {fmtSigned(cashFlowYearly)}/yr
            </p>
          )}
        </div>
      ) : hasCosts ? (
        <button className="db-fold-row" onClick={() => setCostsOpen(true)} aria-expanded={false}
          title={`Show and edit property tax, insurance, HOA and rental income. ${costsTitle}.`}>
          <span style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>Carrying costs</span>
          {incomeYearly > 0 ? (
            // With rental income the headline is the net; the two parts sit beside it.
            <span style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'baseline', gap: '2px 8px' }}>
              <span style={{ color: 'var(--muted)', fontSize: 12, whiteSpace: 'nowrap' }}>
                {fmt(costsYearly)} costs · <span style={{ color: 'var(--green)' }}>+{fmt(incomeYearly)}</span> income
              </span>
              <span style={{ whiteSpace: 'nowrap' }}>
                <span style={{ fontWeight: 600, color: netColor }}>{fmtSigned(netYearly)}/yr</span>
                <span style={{ color: 'var(--muted)', fontSize: 12 }}> net</span>
                <span aria-hidden="true" style={{ color: 'var(--muted)', fontSize: 12, marginLeft: 8 }}>▸</span>
              </span>
            </span>
          ) : (
            <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span style={{ fontWeight: 600 }}>{fmt(costsYearly)}/yr</span>
              <span aria-hidden="true" style={{ color: 'var(--muted)', fontSize: 12 }}>▸</span>
            </span>
          )}
        </button>
      ) : (
        <button className="db-dashed" style={{ marginTop: 12 }} onClick={() => setCostsOpen(true)}>
          + Add carrying costs (tax, insurance, HOA, rent) to see the true cost of owning
        </button>
      )}

      {/* Loan-terms estimator */}
      <div style={{ marginTop: 10 }}>
        {!editing && (
          <div style={{ display: 'flex', justifyContent: hasTerms ? 'space-between' : 'flex-end', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--muted)' }}>
            {hasTerms && (
              <span>{fmt(p.mortgage_principal)} at {p.mortgage_rate}% · {p.mortgage_term_years ?? 30}-yr from {dateLabel(p.mortgage_start)}</span>
            )}
            <button onClick={openTerms} aria-label={`Edit loan terms and history for ${p.address}`} style={{ ...linkBtn, flexShrink: 0 }}>edit</button>
          </div>
        )}
        {editing && (<>
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
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
              <span style={{ fontSize: 12, color: termsError ? 'var(--red)' : 'var(--muted)' }} role={termsError ? 'alert' : undefined}>
                {termsError ?? <>Balance today: <strong style={{ color: 'var(--text)' }}>{fmt(preview)}</strong></>}
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
          {/* Value history is an editing tool (paste Zillow history), so it only appears here. */}
          <ValueHistory propertyId={p.id} address={p.address} onChanged={onUpdate} />
          <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
            <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px', color: 'var(--red)' }}
              onClick={() => onRemove(p.id)}>Remove property</button>
          </div>
        </>)}
      </div>
    </div>
  );
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// Parse the Zestimate table copied from Zillow's "Table view" into dated points.
// Zillow rows look like "Jul 2026    $1,035,800" (tab- or space-separated); we
// also accept "2026-07"/"07/2026" dates and "$1.04M"/"$980K" values. Each row
// needs both a recognisable month and a $ amount, so header/label lines drop out.
function parseZillowTable(text: string): { date: string; value: number }[] {
  const out: { date: string; value: number }[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    let date: string | null = null;
    let m: RegExpMatchArray | null;
    if ((m = line.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{4})\b/i))) {
      date = `${m[2]}-${String(MONTHS[m[1].slice(0, 3).toLowerCase()]).padStart(2, '0')}-01`;
    } else if ((m = line.match(/\b(\d{4})-(\d{2})\b/))) {
      date = `${m[1]}-${m[2]}-01`;
    } else if ((m = line.match(/\b(\d{1,2})\/(\d{4})\b/))) {
      date = `${m[2]}-${String(m[1]).padStart(2, '0')}-01`;
    }
    if (!date || seen.has(date)) continue;

    // Value always carries a "$" on Zillow, so requiring it avoids grabbing the year.
    let value: number | null = null;
    let v: RegExpMatchArray | null;
    if ((v = line.match(/\$\s*([\d.]+)\s*([MmKk])\b/))) {
      value = Math.round(parseFloat(v[1]) * (v[2].toLowerCase() === 'm' ? 1e6 : 1e3));
    } else if ((v = line.match(/\$\s*([\d,]+)/))) {
      value = parseInt(v[1].replace(/,/g, ''), 10);
    }
    if (value == null || !isFinite(value) || value <= 0) continue;

    seen.add(date);
    out.push({ date, value });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// Per-property Zestimate history. A home's own Zestimate history is more accurate
// than KevFin's default ZIP-level ZHVI curve, so we let the user paste Zillow's
// table (or add points by hand); the backend then rebuilds the net-worth trend
// from these points instead of ZHVI.
function ValueHistory({ propertyId, address, onChanged }: {
  propertyId: number; address: string; onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [points, setPoints] = useState<{ date: string; value: number }[]>([]);
  const [date, setDate] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');

  // A Zillow search that resolves to this property's page, where the "Home value"
  // (Zestimate) history chart lives — read the dated values off it and enter them here.
  const zillowUrl = `https://www.zillow.com/homes/${encodeURIComponent(address)}_rb/`;

  async function load() {
    const r = await fetch(`/api/properties/${propertyId}/history`);
    if (r.ok) setPoints(await r.json());
  }
  useEffect(() => { if (open) load(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  async function add() {
    const v = parseNum(value);
    if (!date || !v) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/properties/${propertyId}/history`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, value: v }),
      });
      if (r.ok) { setPoints(await r.json()); setDate(''); setValue(''); onChanged(); }
    } finally { setBusy(false); }
  }

  async function del(d: string) {
    setBusy(true);
    try {
      const r = await fetch(`/api/properties/${propertyId}/history/${d}`, { method: 'DELETE' });
      if (r.ok) { setPoints(await r.json()); onChanged(); }
    } finally { setBusy(false); }
  }

  const parsed = pasteText.trim() ? parseZillowTable(pasteText) : [];

  async function importBulk() {
    if (!parsed.length) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/properties/${propertyId}/history/bulk`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ points: parsed }),
      });
      if (r.ok) { setPoints(await r.json()); setPasteText(''); onChanged(); }
    } finally { setBusy(false); }
  }

  if (!open) {
    return (
      <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
        <button onClick={() => setOpen(true)} aria-expanded={false} style={linkBtn}>
          📈 Value history{points.length ? ` (${points.length})` : ''}
        </button>
      </div>
    );
  }

  const cell = { padding: '5px 8px', fontSize: 13 };
  const note = { fontSize: 11, color: 'var(--muted)', margin: '0 0 8px', lineHeight: 1.5 };

  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.3, color: 'var(--muted)' }}>Value history</span>
        <button onClick={() => setOpen(false)} aria-expanded style={linkBtn}>close</button>
      </div>

      <p style={note}>
        A home's own Zestimate history tracks <em>this</em> property, so it's more accurate
        than KevFin's default ZIP-level estimate (ZHVI). Paste it once and the net-worth
        trend follows your home instead of the neighborhood average.
      </p>
      <ol style={{ ...note, paddingLeft: 16 }}>
        <li>
          <a href={zillowUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>
            Open this home's Zestimate history on Zillow →
          </a>
        </li>
        <li>Choose <strong>Table view</strong>, select all, and copy.</li>
        <li>Paste below and Import.</li>
      </ol>

      <textarea
        value={pasteText}
        onChange={e => setPasteText(e.target.value)}
        rows={4}
        placeholder={'Paste Zillow’s table here\ne.g.  Jul 2026    $1,035,800'}
        style={{ fontSize: 12, padding: 8, resize: 'vertical', fontFamily: 'inherit', width: '100%', boxSizing: 'border-box' }}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginTop: 6 }}>
        <span style={{ fontSize: 11, color: pasteText.trim() && !parsed.length ? 'var(--red)' : 'var(--muted)' }}>
          {pasteText.trim()
            ? (parsed.length
                ? `Found ${parsed.length} points (${fmtMonth(parsed[0].date)} → ${fmtMonth(parsed[parsed.length - 1].date)})`
                : 'No date/value rows recognized')
            : 'Paste from Zillow, or add points by hand below.'}
        </span>
        <button className="btn-primary" onClick={importBulk} disabled={busy || !parsed.length}
          style={{ fontSize: 11, padding: '4px 10px', flexShrink: 0 }}>{busy ? '…' : `Import ${parsed.length || ''}`.trim()}</button>
      </div>

      {points.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 10 }}>
          <span style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.3 }}>
            {points.length} saved point{points.length > 1 ? 's' : ''}
          </span>
          {points.map(pt => (
            <div key={pt.date} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}>
              <span style={{ color: 'var(--muted)' }}>{fmtDate(pt.date)}</span>
              <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <strong>{fmt(pt.value)}</strong>
                <button onClick={() => { if (!busy) del(pt.date); }} title="Remove" aria-label={`Remove value for ${fmtDate(pt.date)}`}
                  style={{ ...linkBtn, color: 'var(--red)' }}>✕</button>
              </span>
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 10 }}>
        {!manualOpen ? (
          <button onClick={() => setManualOpen(true)} style={linkBtn}>+ add a single dated value</button>
        ) : (
          <div style={{ display: 'flex', gap: 6 }}>
            <input type="date" value={date} onChange={e => setDate(e.target.value)} style={{ ...cell, flex: 1 }} />
            <input value={value} onChange={e => setValue(e.target.value)} placeholder="Value" inputMode="numeric"
              style={{ ...cell, width: 100 }} onKeyDown={e => { if (e.key === 'Enter') add(); }} />
            <button className="btn-primary" onClick={add} disabled={busy || !date || !value}
              style={{ fontSize: 11, padding: '4px 10px' }}>{busy ? '…' : 'Add'}</button>
          </div>
        )}
      </div>
    </div>
  );
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
  return fmtMoney(n);
}

// Signed money for a net figure: "+$42,056" / "−$980" / "$0". Honors privacy mode.
function fmtSigned(n: number): string {
  if (HIDE_BALANCES) return '••••••';
  return fmtMoney(n, { sign: true });
}

// A compact signed-money delta for the KPI cards: "+$1,234" / "−$980". Honors
// privacy mode like fmt(). Returns '' when the change rounds to zero so the
// caller can drop the badge entirely rather than render a noisy "+$0".
function fmtDelta(n: number): string {
  // Zero check first: privacy must hide a badge's amount, not add a badge that
  // wouldn't otherwise show (it also shifted the cards' height on toggle).
  if (Math.round(n) === 0) return '';
  if (HIDE_BALANCES) return '•••';
  return fmtMoney(n, { sign: true });
}

// One change badge on the net-worth card: "+$5,184 · 0.8% 30d". Green or red by
// direction; neutral (and without the percentage) in privacy mode. Renders nothing
// when the change rounds to $0.
function ChangeChip({ amount, pct, note, title }: { amount: number; pct?: number | null; note: string; title: string }) {
  const text = fmtDelta(amount);
  if (!text) return null;
  const tone = HIDE_BALANCES ? '' : amount > 0 ? ' up' : ' down';
  return (
    <span className={'db-chip' + tone} title={title}>
      {text}{!HIDE_BALANCES && pct != null ? ` · ${(Math.abs(pct) * 100).toFixed(1)}%` : ''}
      <span className="db-chip-note">{note}</span>
    </span>
  );
}

// The net-worth card's 90-day trend. Stretched to its box (the stroke keeps its
// width), filled with a fade of the accent. Blurred in privacy mode like the chart.
function Sparkline({ values, blurred }: { values: number[]; blurred: boolean }) {
  const lo = Math.min(...values), hi = Math.max(...values);
  const span = hi - lo || 1;
  const line = values.map((v, i) =>
    `${i ? 'L' : 'M'}${((i / (values.length - 1)) * 100).toFixed(2)} ${(36 - ((v - lo) / span) * 32).toFixed(2)}`).join(' ');
  const rising = values[values.length - 1] >= values[0];
  return (
    <svg className="db-spark" viewBox="0 0 100 40" preserveAspectRatio="none" role="img"
      aria-label={`Net worth over the last 90 days, ${rising ? 'up' : 'down'}`}
      style={{ filter: blurred ? 'blur(6px)' : 'none' }}>
      <defs>
        <linearGradient id="db-spark-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--accent)" stopOpacity={0.32} />
          <stop offset="1" stopColor="var(--accent)" stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={`${line} L100 40 L0 40 Z`} fill="url(#db-spark-fill)" />
      <path d={line} fill="none" stroke="var(--accent)" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

const CAT_OPTIONS: { value: Category; label: string }[] = [
  { value: 'brokerage', label: 'Brokerage' },
  { value: 'banking', label: 'Cash & Banking' },
  { value: 'credit', label: 'Credit Cards' },
  { value: 'other', label: 'Other' },
];

// "Fidelity" → "Fi", "Bilt Rewards" → "BR".
function monogram(org: string): string {
  const words = org.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 1).toUpperCase() + words[0].slice(1, 2).toLowerCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

// Institution mark: the bundled logo when there is one, else initials. Both sit
// in the same white tile (same size, padding, radius and border), so the list
// reads as one set in every theme and logos keep the light ground they're drawn for.
function Monogram({ org, size = 32 }: { org: string; size?: number }) {
  const logo = institutionLogo(org);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [logo]);
  const small = size < 28;
  return (
    <span className="acct-mono" aria-hidden="true" style={{
      width: size, height: size, borderRadius: small ? 7 : 9, fontSize: small ? 10 : 12,
      padding: logo && !failed ? Math.round(size * 0.14) : 0,
    }}>
      {logo && !failed
        ? <img src={logo} alt="" width={size} height={size} loading="lazy" onError={() => setFailed(true)} />
        : monogram(org)}
    </span>
  );
}

// Slices of the "Accounts & assets" mix bar.
const MIX_COLORS: Record<MixKey, string> = {
  investing: 'var(--accent)',
  cash: 'var(--accent-2)',
  other: 'var(--muted)',
};

// A balance that displays as $0 (closed cards, empty sweep accounts).
function isZero(a: Account): boolean {
  return Math.abs(a.balance) < 0.005;
}

// One account. Outside Edit mode it's just monogram, name and balance; Edit mode
// brings back the rename, recategorize, hide and drag-to-move controls.
function AccountRow({ account: a, byInstitution, editMode, onRecategorize, onRename, onHide }: {
  account: Account;
  byInstitution: boolean;
  editMode: boolean;
  onRecategorize: (id: string, category: Category) => void;
  onRename: (id: string, name: string | null) => void;
  onHide: (id: string, hidden: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(a.name);

  function commit() {
    if (draft.trim() && draft.trim() !== a.name) onRename(a.id, draft.trim());
    setEditing(false);
  }

  const draggable = editMode && !editing;
  return (
    <div
      className={'acct-row' + (editMode ? ' editing' : '')}
      draggable={draggable}
      onDragStart={draggable ? e => { e.dataTransfer.setData('text/plain', a.id); e.dataTransfer.effectAllowed = 'move'; } : undefined}
      style={{ cursor: draggable ? 'grab' : undefined, paddingLeft: byInstitution ? 14 : 4 }}
    >
      {editMode && (
        <span style={{ color: 'var(--muted)', fontSize: 12, cursor: 'grab' }} title="Drag to another section" aria-hidden="true">⠿</span>
      )}
      {!byInstitution && <Monogram org={a.org_name} />}
      {editing ? (
        <input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          autoFocus
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
          aria-label={`New name for ${a.name}`}
          style={{ flex: 1, minWidth: 0, padding: '4px 8px', fontSize: 13 }}
        />
      ) : (
        <span className="acct-name">
          {editMode ? (
            // The name truncates and "reset" keeps its place beside it, so a long
            // renamed account can't push the reset link out of view.
            <span className="acct-rename">
              <button
                onClick={() => { setDraft(a.name); setEditing(true); }}
                title={`Rename ${a.name}`}
                aria-label={`Rename ${a.name}`}
                style={{ ...linkBtn, fontSize: 14, color: 'inherit', textAlign: 'left' }}
              >{a.name} <span style={{ fontSize: 11, opacity: 0.5 }} aria-hidden>✎</span></button>
              {a.renamed ? (
                <button onClick={() => onRename(a.id, null)} title="Reset to original name"
                  style={{ ...linkBtn, fontSize: 11, color: 'var(--muted)', flex: 'none' }}>reset</button>
              ) : null}
            </span>
          ) : (
            <span title={a.name}>{a.name}</span>
          )}
          {!byInstitution && <span className="db-sub">{a.org_name}</span>}
        </span>
      )}
      {/* Keyboard/touch-friendly fallback for the drag-to-recategorize gesture. */}
      {editMode && !editing && (<span className="acct-edit-tools">
        <select
          value={a.category}
          draggable={false}
          onMouseDown={e => e.stopPropagation()}
          onClick={e => e.stopPropagation()}
          onChange={e => onRecategorize(a.id, e.target.value as Category)}
          title="Change category"
          aria-label={`Category for ${a.name}`}
          style={{ fontSize: 12, padding: '3px 6px', maxWidth: 120 }}
        >
          {CAT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <button
          onClick={() => onHide(a.id, true)}
          title="Hide from list and net worth"
          aria-label={`Hide ${a.name} from list and net worth`}
          style={{ ...linkBtn, fontSize: 12, color: 'var(--muted)' }}
        >hide</button>
      </span>)}
      <span className="acct-bal" style={{ color: a.balance < 0 ? 'var(--red)' : 'var(--text)' }}>
        {fmt(a.balance)}
      </span>
    </div>
  );
}

function AccountGroups({ accounts, byInstitution, editMode, onRecategorize, onRename, onHide }: {
  accounts: Account[];
  byInstitution: boolean;
  editMode: boolean;
  onRecategorize: (id: string, category: Category) => void;
  onRename: (id: string, name: string | null) => void;
  onHide: (id: string, hidden: boolean) => void;
}) {
  const [overCat, setOverCat] = useState<Category | null>(null);
  const [collapsedList, setCollapsedList] = usePersistentState<Category[]>('mon.collapsedCategories', []);
  const [collapsedInst, setCollapsedInst] = usePersistentState<string[]>('mon.collapsedInstitutions', []);
  const [showHidden, setShowHidden] = usePersistentState<boolean>('mon.showHidden', false);
  const [showZero, setShowZero] = usePersistentState<boolean>('mon.showZeroBalances', false);
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
  // $0 accounts fold into one line outside Edit mode (Edit shows everything, so
  // they can still be dragged, renamed or hidden). They're still in net worth.
  const zeros = visible.filter(isZero);
  const listed = editMode || showZero ? visible : visible.filter(a => !isZero(a));
  const subtotalOf = (cat: Category) => visible.filter(a => a.category === cat).reduce((s, a) => s + a.balance, 0);
  const positiveTotal = CATEGORY_ORDER.reduce((s, cat) => s + Math.max(0, subtotalOf(cat)), 0);

  return (
    <div style={{ marginTop: 4 }}>
      {CATEGORY_ORDER.map(cat => {
        const rows = listed.filter(a => a.category === cat);
        // Empty sections are only drop targets, so they appear only while editing.
        if (!editMode && rows.length === 0) return null;
        const subtotal = subtotalOf(cat);
        const share = subtotal > 0 && positiveTotal > 0 ? Math.round((subtotal / positiveTotal) * 100) : null;
        const orgs = byInstitution ? [...new Set(rows.map(r => r.org_name))].sort() : [null];
        const isOver = overCat === cat;
        const isCollapsed = collapsed.has(cat);

        return (
          <div
            key={cat}
            onDragOver={editMode ? e => { e.preventDefault(); if (overCat !== cat) setOverCat(cat); } : undefined}
            onDragLeave={editMode ? () => setOverCat(c => (c === cat ? null : c)) : undefined}
            onDrop={editMode ? e => {
              e.preventDefault();
              const id = e.dataTransfer.getData('text/plain');
              setOverCat(null);
              if (id) onRecategorize(id, cat);
            } : undefined}
            style={{
              marginTop: 12, padding: '2px 4px', borderRadius: 10,
              border: isOver ? '1px dashed var(--accent)' : '1px solid transparent',
              background: isOver ? 'var(--accent-dim)' : 'transparent',
              transition: 'background 0.1s',
            }}
          >
            <button className="acct-group-head" onClick={() => toggleCollapse(cat)} aria-expanded={!isCollapsed}>
              <span className="acct-group-name">
                <span style={{ display: 'inline-block', width: 12, opacity: 0.7 }} aria-hidden>{isCollapsed ? '▸' : '▾'}</span>
                {CATEGORY_LABELS[cat]}
                {isCollapsed && rows.length > 0 && (
                  <span style={{ opacity: 0.6, fontWeight: 400, marginLeft: 6 }}>({rows.length})</span>
                )}
              </span>
              <span style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
                {share != null && <span className="db-sub">{share}%</span>}
                <span style={{ fontSize: 13, fontWeight: 600, color: subtotal < 0 ? 'var(--red)' : 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>{fmt(subtotal)}</span>
              </span>
            </button>
            {isCollapsed ? null : rows.length === 0 ? (
              <p style={{ fontSize: 12, color: 'var(--muted)', padding: '6px 4px' }}>
                Drag an account here…
              </p>
            ) : (
              orgs.map(org => {
                const orgRows = org === null ? rows : rows.filter(r => r.org_name === org);
                const instKey = `${cat}|${org}`;
                const instCollapsed = byInstitution && org !== null && collapsedInstSet.has(instKey);
                const orgSubtotal = orgRows.reduce((s, a) => s + a.balance, 0);
                return (
                  <div key={org ?? '_all'}>
                    {byInstitution && org !== null && (
                      <button
                        className="acct-inst-head"
                        onClick={() => toggleInstitution(instKey)}
                        aria-expanded={!instCollapsed}
                        title={instCollapsed ? 'Expand institution' : 'Collapse institution'}
                      >
                        <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                          <Monogram org={org} size={24} />
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{org}</span>
                          {instCollapsed && orgRows.length > 0 && (
                            <span style={{ opacity: 0.6, fontWeight: 400 }}>({orgRows.length})</span>
                          )}
                        </span>
                        {/* A lone account's row already shows this figure. */}
                        {(orgRows.length > 1 || instCollapsed) && (
                          <span style={{ color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>{fmt(orgSubtotal)}</span>
                        )}
                      </button>
                    )}
                    {!instCollapsed && orgRows.map(a => (
                      <AccountRow key={a.id} account={a} byInstitution={byInstitution} editMode={editMode}
                        onRecategorize={onRecategorize} onRename={onRename} onHide={onHide} />
                    ))}
                  </div>
                );
              })
            )}
          </div>
        );
      })}

      {!editMode && zeros.length > 0 && (
        <div className="db-note-strip" style={{ marginTop: 14 }}>
          <span>
            {showZero
              ? `Showing ${plural(zeros.length, 'zero-balance account')}`
              : `${plural(zeros.length, 'zero-balance account')} not shown (${zeros.slice(0, 3).map(a => a.name).join(', ')}${zeros.length > 3 ? ', …' : ''})`}
          </span>
          <button onClick={() => setShowZero(s => !s)} style={{ ...linkBtn, fontSize: 12 }}>{showZero ? 'Hide them' : 'Show'}</button>
        </div>
      )}

      {/* Hidden accounts — excluded from net worth, reversible */}
      {hidden.length > 0 && (
        <div style={{ marginTop: 14, paddingTop: 10, borderTop: '1px dashed var(--border)' }}>
          <button
            onClick={() => setShowHidden(s => !s)}
            aria-expanded={showHidden}
            style={{ ...linkBtn, fontSize: 12, color: 'var(--muted)' }}
          >
            {showHidden ? '▾' : '▸'} Hidden accounts ({hidden.length}) · excluded from net worth
          </button>
          {showHidden && hidden.map(a => (
            <div key={a.id} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '5px 0', fontSize: 13, opacity: 0.6,
            }}>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {a.name} <span style={{ fontSize: 11, color: 'var(--muted)' }}>({a.org_name})</span>
              </span>
              <button onClick={() => onHide(a.id, false)} title="Unhide" aria-label={`Unhide ${a.name}`}
                style={{ ...linkBtn, marginRight: 8 }}>unhide</button>
              <span style={{ minWidth: 80, textAlign: 'right' }}>{fmt(a.balance)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Inline editor for a manual asset's annual growth/interest rate. A null rate
// reads as a muted "+ rate" prompt; clearing the field (empty) sets it back to
// null, which the Forecast treats as "leave in the investment pool".
function RateField({ rate, onSave }: { rate: number | null; onSave: (v: number | null) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(rate != null ? String(rate) : '');

  async function save() {
    const trimmed = value.trim();
    // Blank clears the rate; anything unreadable ("abc") cancels instead of saving 0%.
    const v = trimmed === '' ? null : parseNumOrNull(trimmed);
    if (trimmed === '' || v != null) await onSave(v);
    setEditing(false);
  }

  if (editing) {
    return (
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <input
          value={value}
          onChange={e => setValue(e.target.value)}
          placeholder="e.g. 4.5"
          style={{ width: 64, padding: '4px 6px', fontSize: 12 }}
          autoFocus
          onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
        />
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>%/yr</span>
        <button className="btn-primary" style={{ fontSize: 11, padding: '4px 8px' }} onClick={save}>Save</button>
      </div>
    );
  }

  return (
    <button
      onClick={() => { setValue(rate != null ? String(rate) : ''); setEditing(true); }}
      title="Annual growth/interest rate used to project this asset in the Forecast"
      aria-label="Edit annual growth rate"
      style={{
        ...linkBtn, fontSize: 12, whiteSpace: 'nowrap',
        color: rate != null ? 'var(--accent)' : 'var(--muted)',
        opacity: rate != null ? 1 : 0.7,
      }}
    >{rate != null ? `${rate}%/yr ✎` : '+ rate'}</button>
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
    if (!confirm(`Remove “${asset.name}” from your net worth?`)) return;
    await fetch(`/api/assets/${asset.id}`, { method: 'DELETE' });
    onUpdate();
  }
  return (
    // flex-wrap: on a phone the rate/value/Remove controls drop to a second line
    // instead of squeezing the name down to a sliver.
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8,
      padding: '8px 0', borderBottom: '1px solid var(--border)',
    }}>
      <div style={{ flex: '1 1 160px', minWidth: 0 }}>
        <p style={{ fontWeight: 500, fontSize: 14 }}>{asset.name}</p>
        <select
          value={asset.category}
          onChange={e => patch({ category: e.target.value })}
          style={{ background: 'transparent', border: 'none', color: 'var(--muted)', fontSize: 11, cursor: 'pointer', paddingLeft: 0 }}
        >
          {CAT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      <div>
        <RateField rate={asset.interest_rate} onSave={v => patch({ interest_rate: v })} />
      </div>
      <EditableField label="" name={`${asset.name} value`} initialValue={asset.value} color="var(--green)" onSave={v => patch({ value: v })} />
      <button className="btn-ghost" style={{ fontSize: 11, padding: '2px 8px', color: 'var(--red)' }}
        onClick={remove}>Remove</button>
    </div>
  );
}

function AddManualAsset({ onAdded }: { onAdded: () => void }) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [rate, setRate] = useState('');
  const [category, setCategory] = useState<Category>('other');
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setLoading(true);
    await fetch('/api/assets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Blank rate → null (legacy investment-pool behavior in the Forecast).
      body: JSON.stringify({ name, value: parseNum(value), category, interest_rate: rate.trim() === '' ? null : parseNum(rate) }),
    });
    setName(''); setValue(''); setRate(''); setCategory('other');
    setLoading(false);
    onAdded();
  }

  return (
    <form onSubmit={submit} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Treasury bonds" style={{ flex: 2, minWidth: 140 }} />
      <input value={value} onChange={e => setValue(e.target.value)} placeholder="Value" style={{ flex: 1, minWidth: 90 }} />
      <input value={rate} onChange={e => setRate(e.target.value)} placeholder="Rate %/yr" title="Optional annual growth/interest rate, used in the Forecast" style={{ flex: 1, minWidth: 80 }} />
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

// Inline notice strip (sync failure, server unreachable).
const bannerStyle: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
  padding: '10px 14px', borderRadius: 10, fontSize: 13,
  background: 'var(--surface)', border: '1px solid var(--red)',
};

export default function Dashboard({ onNavigate, privacy, onTogglePrivacy }: {
  onNavigate: (v: View) => void; privacy: boolean; onTogglePrivacy: () => void;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [byInstitution, setByInstitution] = usePersistentState('mon.byInstitution', true);
  const [range, setRange] = usePersistentState<RangeKey>('mon.range', 'ALL');
  const [chartMode, setChartMode] = usePersistentState<'stacked' | 'lines'>('mon.chartMode', 'stacked');
  const [backfilling, setBackfilling] = useState(false);
  // Last sync / backfill problem or result, shown inline (dismissible / replaced on the next run).
  const [syncError, setSyncError] = useState<string | null>(null);
  const [backfillNote, setBackfillNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [excluded, setExcluded] = usePersistentState<string[]>('mon.excluded', []);
  const [indexKey, setIndexKey] = usePersistentState('mon.indexKey', 'none');
  const [indexSeries, setIndexSeries] = useState<{ date: string; close: number }[]>([]);
  const [showConnections, setShowConnections] = usePersistentState('mon.showConnections', false);
  // Account rows stay quiet until the user asks to edit them.
  const [editAccounts, setEditAccounts] = useState(false);
  // The add-a-home / add-an-asset forms open from their card's header button.
  const [addPropOpen, setAddPropOpen] = useState(false);
  const [addAssetOpen, setAddAssetOpen] = useState(false);
  // The chart's ⋯ menu (Rebuild history). Closes on an outside click or Escape.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [menuOpen]);
  HIDE_BALANCES = privacy; // synced each render so fmt() everywhere honors it

  const showAccounts = !excluded.includes('accounts');
  const showRealEstate = !excluded.includes('real_estate');
  const indexOpt = INDEX_OPTIONS.find(o => o.key === indexKey) ?? INDEX_OPTIONS[0];

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

  const { data: history, loading: historyLoading, error: historyError, refetch: refetchHistory } = useApi<Snapshot[]>('/api/net-worth/history?days=10000');
  const { data: breakdown, loading: breakdownLoading, error: breakdownError, refetch: refetchBreakdown } = useApi<{ accounts: Account[]; manualAssets: ManualAsset[]; properties: Property[] }>('/api/net-worth/breakdown');
  const { data: connections, refetch: refetchConnections } = useApi<Connection[]>('/api/simplefin/connections');
  const { data: plaidItems, refetch: refetchPlaid } = useApi<PlaidItem[]>('/api/plaid/items');

  const latest = history?.[0];
  // Nothing has loaded and the requests failed: the server is down/unreachable, which
  // must not read as an empty account.
  const serverDown = !!historyError && !history && !!breakdownError && !breakdown;
  // updated_at of the most recently synced visible account (SQLite UTC, see relTime).
  const syncedAt = newestTimestamp((breakdown?.accounts ?? []).filter(a => !a.hidden).map(a => a.updated_at));

  // "Change since last session" for the KPI cards. `lastSession` persists the
  // headline figures from the previous visit; the first time this page load sees
  // real figures we freeze those into the module-level session baseline (so the
  // deltas stay stable while the user is here, including across navigation) and
  // then keep the stored baseline updated to the newest figures, so the NEXT
  // visit compares against where things stood when this session ended.
  const [lastSession, setLastSession] = usePersistentState<SessionSnapshot | null>('mon.lastSession', null);
  const [baseline, setBaseline] = useState<SessionSnapshot | null>(sessionBaseline);

  const visitTip = visitTitle(baseline?.at);

  useEffect(() => {
    if (!latest) return;
    if (!baselineCaptured) {
      baselineCaptured = true;
      sessionBaseline = lastSession; // prior-session figures; null on first-ever visit
      setBaseline(lastSession);
    }
    // Stamp the snapshot with this page load's visit time. `visitAt` never changes
    // after it's first set, so once the write lands (lastSession.at === visitAt) the
    // effect's re-run sees nothing to do and can't loop; it's also idempotent under
    // StrictMode's double-run. The baseline above was captured first, so it keeps
    // the PREVIOUS visit's `at`.
    visitAt ??= new Date().toISOString();
    const snap: SessionSnapshot = {
      net_worth: latest.net_worth,
      accounts_total: latest.accounts_total,
      real_estate_total: latest.real_estate_total,
      at: visitAt,
    };
    // A later visit (another open tab) owns the snapshot: leave it alone. Without
    // this, two tabs kept overwriting each other's `at` — dozens of writes a second,
    // each one synced to /api/prefs.
    if (lastSession?.at && lastSession.at > visitAt) return;
    if (!lastSession
      || lastSession.at !== visitAt
      || lastSession.net_worth !== snap.net_worth
      || lastSession.accounts_total !== snap.accounts_total
      || lastSession.real_estate_total !== snap.real_estate_total) {
      setLastSession(snap);
    }
  }, [latest, lastSession, setLastSession]);

  const refetchAll = useCallback(() => {
    refetchHistory();
    refetchBreakdown();
    refetchConnections();
    refetchPlaid();
  }, [refetchHistory, refetchBreakdown, refetchConnections, refetchPlaid]);

  // Mirrors Setup's "Sync now" (SyncSection.syncNow): same endpoint, same
  // force-refresh of every source. The server snapshots even when one provider
  // fails (then answers 500), so new data may have been saved: always refetch, and
  // surface the failure as a banner instead of leaving the page stale. finally
  // also guarantees the spinner resets if the request throws.
  async function triggerRefresh() {
    setRefreshing(true);
    setSyncError(null);
    try {
      const res = await fetch('/api/net-worth/refresh', { method: 'POST' });
      if (!res.ok) {
        const d = await res.json().catch(() => ({} as { error?: string }));
        setSyncError(d.error || `Couldn't refresh everything (HTTP ${res.status}).`);
      }
    } catch (e) {
      console.error('Sync failed:', e);
      setSyncError("Couldn't reach the KevFin server.");
    } finally {
      refetchAll();
      setRefreshing(false);
    }
  }

  async function triggerBackfill() {
    if (!confirm('Rebuild up to 5 years of history from transactions and market prices? Daily totals will be replaced with estimates.')) return;
    setBackfilling(true);
    setBackfillNote(null);
    // finally: a thrown fetch (server down) must not leave the button stuck on "Backfilling…".
    try {
      const res = await fetch('/api/net-worth/backfill', { method: 'POST' });
      const d = await res.json().catch(() => ({} as { snapshots?: number; error?: string }));
      if (!res.ok) {
        setBackfillNote({ ok: false, text: d.error || `Backfill failed (HTTP ${res.status})` });
      } else {
        setBackfillNote({ ok: true, text: typeof d.snapshots === 'number' ? `Rebuilt ${plural(d.snapshots, 'daily point')} of history.` : 'History rebuilt.' });
      }
      refetchHistory();
    } catch (e) {
      console.error('Backfill failed:', e);
      setBackfillNote({ ok: false, text: 'Backfill failed — could not reach the server.' });
    } finally {
      setBackfilling(false);
    }
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
    const p = breakdown?.properties?.find(x => x.id === id);
    if (!confirm(`Remove ${p ? `“${p.address}”` : 'this property'} and its mortgage details from your net worth?`)) return;
    await fetch(`/api/properties/${id}`, { method: 'DELETE' });
    refetchAll();
  }

  async function removeConnection(id: number, label: string) {
    if (!confirm(`Remove ${label}? Its accounts will stop syncing and be removed from your net worth.`)) return;
    await fetch(`/api/simplefin/connections/${id}`, { method: 'DELETE' });
    refetchAll();
  }

  async function removePlaidItem(itemId: string, label: string) {
    if (!confirm(`Remove ${label}? Its accounts will stop syncing and be removed from your net worth.`)) return;
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

  // Summary-card figures. Each follows the series switched on in the cards, the
  // same way the hero total and the chart do.
  const comp = { accounts: showAccounts, realEstate: showRealEstate };
  const changes = history ? headlineChanges(history, comp) : { d30: null, ytd: null };
  const spark = history ? sparkValues(history, comp) : [];
  const mix = breakdown ? accountMix(breakdown.accounts, breakdown.manualAssets) : [];
  const properties = breakdown?.properties ?? [];
  const manualAssets = breakdown?.manualAssets ?? [];
  // With nothing added yet the form is the card's whole point, so it shows open.
  const showAddProperty = addPropOpen || (!!breakdown && properties.length === 0);
  const showAddAsset = addAssetOpen || (!!breakdown && manualAssets.length === 0);
  const homeValue = properties.reduce((s, p) => s + (p.zestimate ?? 0), 0);
  const owedTotal = properties.reduce((s, p) => s + (p.mortgage_balance ?? 0), 0);
  // The equity share compares like with like: a property with no value yet
  // contributes neither its (missing) value nor its mortgage.
  const owedOnValued = properties.reduce((s, p) => s + (p.zestimate != null ? (p.mortgage_balance ?? 0) : 0), 0);
  const equityShare = homeValue > 0 ? Math.max(0, Math.min(1, (homeValue - owedOnValued) / homeValue)) : 0;
  const soloPayoff = properties.length === 1 ? payoffMonth(properties[0].mortgage_start, properties[0].mortgage_term_years) : null;
  const activeAccounts = (breakdown?.accounts ?? []).filter(a => !a.hidden);
  const institutionCount = new Set(activeAccounts.map(a => a.org_name)).size;
  const syncStale = !!syncedAt && Date.now() - new Date(sqliteUtcToIso(syncedAt)).getTime() > 3 * 86_400_000;
  const heroValue = latest ? composedValue(latest, comp) : null;
  const heroDelta = latest && baseline
    ? composedValue(latest, comp) - ((showAccounts ? baseline.accounts_total : 0) + (showRealEstate ? baseline.real_estate_total : 0))
    : null;
  const sinceTip = visitTip ? `Change since your last visit (${visitTip})` : 'Change since your last visit';
  const sfInstitutions = new Set((connections ?? []).flatMap(c => (c.institutions ? c.institutions.split(', ') : []))).size;
  const plaidCount = plaidItems?.length ?? 0;
  const connectionSummary = [
    sfInstitutions > 0 ? `SimpleFIN · ${plural(sfInstitutions, 'institution')}` : '',
    plaidCount > 0 ? `Plaid · ${plural(plaidCount, 'institution')}` : '',
  ].filter(Boolean).join('   ·   ');

  // The two secondary cards double as chart toggles, as before.
  const secondary = [
    {
      key: 'accounts', label: 'Accounts & assets', color: 'var(--accent)', excluded: !showAccounts,
      value: latest?.accounts_total ?? null,
      delta: latest && baseline ? latest.accounts_total - baseline.accounts_total : null,
      hint: 'Linked accounts plus manual assets, with credit cards netted out. Hidden accounts are left out.',
      foot: mix.length > 0 ? (
        <>
          <span className="db-bar" style={{ marginTop: 'auto' }}>
            {mix.map(m => <i key={m.key} style={{ width: `${m.share * 100}%`, background: MIX_COLORS[m.key] }} />)}
          </span>
          <span className="db-legend">
            {mix.map(m => (
              <span key={m.key}><span className="db-swatch" style={{ background: MIX_COLORS[m.key] }} />{m.label} {Math.round(m.share * 100)}%</span>
            ))}
          </span>
        </>
      ) : null,
    },
    {
      key: 'real_estate', label: 'Home equity', color: 'var(--green)', excluded: !showRealEstate,
      value: latest?.real_estate_total ?? null,
      delta: latest && baseline ? latest.real_estate_total - baseline.real_estate_total : null,
      hint: 'Home value minus mortgage balance, summed across your properties.',
      foot: homeValue > 0 ? (
        <>
          <span className="db-bar" style={{ marginTop: 'auto' }}>
            <i style={{ width: `${equityShare * 100}%`, background: 'var(--green)' }} />
          </span>
          <span className="db-legend spread">
            <span>{HIDE_BALANCES ? 'Equity' : `${Math.round(equityShare * 100)}% of ${fmtMoneyCompact(homeValue)} home value`}</span>
            <span>{soloPayoff ? `Payoff ${fmtMonth(`${soloPayoff}-01`)}` : `Mortgage ${fmt(owedTotal)}`}</span>
          </span>
        </>
      ) : null,
    },
  ];

  return (
    <div className="page" style={{ maxWidth: 1280, margin: '0 auto', padding: '32px 24px' }}>
      {/* Persistent nav + icon actions; the freshness note sits beside them. */}
      <TopNav
        view="dashboard"
        onNavigate={onNavigate}
        privacy={privacy}
        onTogglePrivacy={onTogglePrivacy}
        onRefresh={triggerRefresh}
        refreshing={refreshing}
        status={syncedAt ? `Synced ${relTime(syncedAt)}` : undefined}
        statusStale={syncStale}
      />

      {serverDown && (
        <div role="alert" style={{ ...bannerStyle, marginBottom: 20 }}>
          <span>Can't reach the KevFin server — check that it's running, then reload.</span>
        </div>
      )}
      {syncError && (
        <div role="alert" style={{ ...bannerStyle, marginBottom: 20 }}>
          <span>{syncError} Showing the latest data that did sync.</span>
          <button className="btn-ghost" onClick={() => setSyncError(null)} aria-label="Dismiss"
            style={{ fontSize: 11, padding: '2px 8px', flexShrink: 0 }}>✕</button>
        </div>
      )}

      {/* Summary: net worth leads; the two parts below it toggle their place in the chart. */}
      <div className="db-kpis">
        <div className="db-card db-hero">
          <div className="db-hero-text">
            {/* The hero follows the same composition as the chart, so say so when a
                card is switched off instead of silently showing a partial total.
                One line, short wording and a link-style "Show all": a longer or
                taller label used to push the sparkline onto a second row, which
                grew every card in the row (156px → 231px) on each toggle. */}
            <span className="db-label db-hero-label">
              <span className="db-hero-label-text">
                {!showAccounts && !showRealEstate ? 'Net worth: nothing selected'
                  : !showRealEstate ? 'Net worth: accounts only'
                  : !showAccounts ? 'Net worth: home equity only'
                  : 'Net worth'}
                {latest && ` · ${fmtDate(latest.date)}`}
              </span>
              {(!showAccounts || !showRealEstate) && (
                <button onClick={() => setExcluded([])} style={{ ...linkBtn, fontSize: 12, flex: 'none' }}>Show all</button>
              )}
            </span>
            <span className="db-figure">{fmt(heroValue)}</span>
            <div className="db-chips">
              {heroDelta != null && <ChangeChip amount={heroDelta} note={sinceLabel(baseline?.at)} title={sinceTip} />}
              {changes.d30 && <ChangeChip amount={changes.d30.amount} pct={changes.d30.pct} note="30d" title="Change over the last 30 days" />}
              {changes.ytd && <ChangeChip amount={changes.ytd.amount} pct={changes.ytd.pct} note="YTD" title="Change since the end of last year" />}
            </div>
          </div>
          {spark.length > 1 && <Sparkline values={spark} blurred={privacy} />}
        </div>

        {secondary.map(card => {
          const deltaText = !card.excluded && card.delta != null ? fmtDelta(card.delta) : '';
          return (
            <button
              key={card.key}
              type="button"
              className={'db-card db-kpi' + (card.excluded ? ' excluded' : '')}
              aria-pressed={!card.excluded}
              onClick={() => toggleExclude(card.key)}
              title={`${card.hint} ${card.excluded ? 'Click to include in the chart.' : 'Click to leave out of the chart.'}`}
            >
              <span className="db-label">
                <span className="db-swatch" style={{ background: card.color }} />
                {card.label}
                {card.excluded && <span style={{ fontSize: 11, marginLeft: 6 }}>(not in chart)</span>}
              </span>
              <span style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                <span className="db-figure-sm" style={{ textDecoration: card.excluded ? 'line-through' : 'none' }}>{fmt(card.value)}</span>
                {deltaText && (
                  <span title={sinceTip} style={{
                    fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap',
                    color: privacy ? 'var(--muted)' : (card.delta ?? 0) > 0 ? 'var(--green)' : 'var(--red)',
                  }}>
                    {deltaText}
                    <span style={{ fontWeight: 400, color: 'var(--muted)', marginLeft: 4 }}>{sinceLabel(baseline?.at)}</span>
                  </span>
                )}
              </span>
              {card.foot}
            </button>
          );
        })}
      </div>

      {/* Chart */}
      <section className="db-card" aria-label="Net worth history" style={{ marginBottom: 20 }}>
        <div className="db-head" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <h2>History</h2>
            {/* Chart style: stacked composition vs zoomed trend lines */}
            <div className="seg" role="group" aria-label="Chart style">
              {(['stacked', 'lines'] as const).map(m => (
                <button
                  key={m}
                  className={'seg-btn' + (chartMode === m ? ' active' : '')}
                  aria-pressed={chartMode === m}
                  onClick={() => setChartMode(m)}
                  title={m === 'stacked' ? 'Stacked composition (from $0)' : 'Trend lines, zoomed to show change'}
                >{m === 'stacked' ? 'Stacked' : 'Lines'}</button>
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
            {/* Range selector — scrolls sideways on a phone instead of overflowing */}
            <div className="seg scroll-row" role="group" aria-label="Range">
              {RANGES.map(r => (
                <button key={r} className={'seg-btn' + (range === r ? ' active' : '')} aria-pressed={range === r}
                  onClick={() => setRange(r)}>{r}</button>
              ))}
            </div>
            <select
              value={indexKey}
              onChange={e => setIndexKey(e.target.value)}
              title="Compare against an index"
              aria-label="Compare against an index"
              style={{ fontSize: 12, padding: '6px 8px' }}
            >
              {INDEX_OPTIONS.map(o => <option key={o.key} value={o.key}>{o.key === 'none' ? 'Compare…' : `vs ${o.label}`}</option>)}
            </select>
            <div className="db-menu-wrap" ref={menuRef}>
              <button
                className="btn-icon"
                style={{ width: 34, height: 34 }}
                onClick={() => setMenuOpen(o => !o)}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label="More history options"
                title="More history options"
              >
                <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
              </button>
              {menuOpen && (
                <div className="db-menu" role="menu">
                  <button role="menuitem" disabled={backfilling} onClick={() => { setMenuOpen(false); triggerBackfill(); }}>
                    Rebuild history…
                    <small>Re-estimates about 5 years from your transactions, market prices and home values</small>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
        {backfilling && <p role="status" style={{ fontSize: 12, marginBottom: 12, color: 'var(--muted)' }}>Rebuilding history…</p>}
        {backfillNote && !backfilling && (
          <p role="status" style={{ fontSize: 12, marginBottom: 12, color: backfillNote.ok ? 'var(--muted)' : 'var(--red)' }}>{backfillNote.text}</p>
        )}
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
              {history
                ? (history.length > 0
                    ? 'No history in this range — try a wider one, or ⋯ → Rebuild history.'
                    : 'No history yet — use ⋯ → Rebuild history, or Sync (top right) to record today.')
                : historyError ? "Can't reach the KevFin server."
                : historyLoading ? 'Loading…'
                : ''}
            </p>
        }
      </section>

      <div className="db-cols">
        {/* Accounts */}
        {/* Left: everything held as a balance (linked accounts, then manual
            assets). Right: real estate. Keeps the two columns close in height. */}
        <div className="db-col-main db-col-stack">
        <section className="db-card" aria-label="Accounts">
          <div className="db-head" style={{ marginBottom: 6 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <h2>Accounts</h2>
              {activeAccounts.length > 0 && (
                <span className="db-sub">{plural(activeAccounts.length, 'account')} · {plural(institutionCount, 'institution')}</span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {breakdown?.accounts && breakdown.accounts.length > 0 && (<>
                <div className="seg" role="group" aria-label="Group accounts by">
                  <button className={'seg-btn' + (!byInstitution ? ' active' : '')} aria-pressed={!byInstitution} onClick={() => setByInstitution(false)}>Type</button>
                  <button className={'seg-btn' + (byInstitution ? ' active' : '')} aria-pressed={byInstitution} onClick={() => setByInstitution(true)}>Institution</button>
                </div>
                <button className="btn-ghost btn-sm" aria-pressed={editAccounts} onClick={() => setEditAccounts(e => !e)}
                  title="Rename, recategorize or hide accounts">{editAccounts ? 'Done' : 'Edit'}</button>
              </>)}
              <button className="btn-primary btn-sm" onClick={() => setShowConnections(true)}>+ Connect</button>
            </div>
          </div>

          {breakdown?.accounts && breakdown.accounts.length > 0
            ? <AccountGroups
                accounts={breakdown.accounts}
                byInstitution={byInstitution}
                editMode={editAccounts}
                onRecategorize={recategorize}
                onRename={renameAccount}
                onHide={hideAccount}
              />
            : breakdown
              ? <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 10 }}>
                  No accounts yet{showConnections ? ' — connect an institution below.' : ' — click + Connect to link a bank or brokerage.'}
                </p>
              : <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 10 }}>
                  {breakdownError ? "Can't reach the KevFin server." : breakdownLoading ? 'Loading…' : ''}
                </p>
          }

          {/* Connections management — collapsed by default to keep the dashboard clean */}
          <div className="db-head" style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
            <span className="db-sub">{connectionSummary || 'No connections yet'}</span>
            <button
              onClick={() => setShowConnections(s => !s)}
              aria-expanded={showConnections}
              style={{ ...linkBtn, fontSize: 12 }}
            >{showConnections ? 'Close connections' : 'Manage connections'}</button>
          </div>
          {showConnections && (
            <div style={{ marginTop: 12 }}>
              {/* Grouped by provider. A SimpleFIN connection is one token that can span
                  many institutions; each Plaid item is one institution's login. Either
                  way, one row = one thing Remove disconnects. */}
              {[
                {
                  provider: 'SimpleFIN',
                  rows: (connections ?? []).map(conn => {
                    const n = conn.institutions ? conn.institutions.split(', ').length : 0;
                    return {
                      key: `sf-${conn.id}`,
                      title: conn.institutions || 'Pending…',
                      detail: `${plural(conn.account_count, 'account')}${n > 1 ? ` · ${plural(n, 'institution')}` : ''}`,
                      onRemove: () => removeConnection(conn.id, n > 1 ? `this SimpleFIN connection (${n} institutions)` : conn.institutions || 'this SimpleFIN connection'),
                    };
                  }),
                },
                {
                  provider: 'Plaid',
                  rows: (plaidItems ?? []).map(item => ({
                    key: `pl-${item.item_id}`,
                    title: item.institution_name,
                    detail: plural(item.account_count, 'account'),
                    onRemove: () => removePlaidItem(item.item_id, item.institution_name),
                  })),
                },
              ].filter(g => g.rows.length > 0).map((g, gi) => (
                <div key={g.provider} style={{ marginTop: gi > 0 ? 12 : 0 }}>
                  <p style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 2 }}>
                    {g.provider}
                  </p>
                  {g.rows.map(r => (
                    <div key={r.key} style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '6px 0',
                    }}>
                      <div style={{ minWidth: 0 }}>
                        <p style={{ fontWeight: 500, fontSize: 13 }}>{r.title}</p>
                        <p style={{ color: 'var(--muted)', fontSize: 12 }}>{r.detail}</p>
                      </div>
                      <button className="btn-ghost" style={{ fontSize: 12, padding: '4px 10px', color: 'var(--red)', flexShrink: 0 }}
                        onClick={r.onRemove}>Remove</button>
                    </div>
                  ))}
                </div>
              ))}
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <ConnectPlaid onSuccess={refetchAll} />
                <ConnectSimpleFIN onSuccess={refetchAll} />
              </div>
            </div>
          )}
        </section>

          {/* Manual assets (Treasury bonds, cash, collectibles, etc.) */}
          <section className="db-card" aria-label="Manual assets">
            <div className="db-head" style={{ marginBottom: 4 }}>
              <h2>Manual assets</h2>
              {manualAssets.length > 0 && (
                <button className="btn-ghost btn-sm" aria-expanded={showAddAsset} onClick={() => setAddAssetOpen(o => !o)}>
                  {showAddAsset ? 'Cancel' : '+ Asset'}
                </button>
              )}
            </div>
            <p className="db-sub" style={{ marginBottom: 10 }}>
              Anything not connected automatically — Treasury bonds, physical cash, private investments.
            </p>
            <div>
              {breakdown && manualAssets.length === 0 && (
                <p style={{ color: 'var(--muted)', fontSize: 14 }}>No manual assets added yet.</p>
              )}
              {manualAssets.map(a => (
                <ManualAssetRow key={a.id} asset={a} onUpdate={refetchAll} />
              ))}
            </div>
            {showAddAsset && (
              <div style={{ marginTop: 14, paddingTop: 14, borderTop: manualAssets.length ? '1px solid var(--border)' : 'none' }}>
                <AddManualAsset onAdded={() => { refetchAll(); setAddAssetOpen(false); }} />
              </div>
            )}
          </section>
        </div>

        <div className="db-col-side">
          {/* Properties */}
          <section className="db-card" aria-label="Real estate">
            <div className="db-head" style={{ marginBottom: 14 }}>
              <h2>Real estate</h2>
              {properties.length > 0 && (
                <button className="btn-ghost btn-sm" aria-expanded={showAddProperty} onClick={() => setAddPropOpen(o => !o)}>
                  {showAddProperty ? 'Cancel' : '+ Property'}
                </button>
              )}
            </div>
            {properties.length === 0 && breakdown && (
              <p style={{ color: 'var(--muted)', fontSize: 14 }}>No properties added yet.</p>
            )}
            {properties.map(p => (
              <PropertyRow key={p.id} property={p} onRemove={removeProperty} onUpdate={refetchAll} />
            ))}
            {/* Adding a home (and the value-lookup keys it uses) only when asked for,
                or straight away when there are none yet. */}
            {showAddProperty && (
              <div style={{ marginTop: 16, paddingTop: 16, borderTop: properties.length ? '1px solid var(--border)' : 'none' }}>
                <AddProperty onAdded={() => { refetchAll(); setAddPropOpen(false); }} />
                <ZillowKey />
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
