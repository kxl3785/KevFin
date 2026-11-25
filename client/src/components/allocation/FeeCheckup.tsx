import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useApi } from '../../hooks/useApi.ts';
import { usePersistentState } from '../../hooks/usePersistentState.ts';
import { useIsMobile } from '../../hooks/useIsMobile.ts';
import { fmtMoney } from '../../lib/format.ts';
import { DEFAULT_ASSUMPTIONS, DEFAULT_EARNERS, type Assumptions, type Earner } from '../../lib/forecastConfig.ts';
import { collapsedFeeRows, forecastRates, fmtRatio, parseRatioInput, portfolioFeeDrag } from '../../lib/feeDrag.ts';
import { LOCATION_BUCKET_LABELS, bucketLabel, observationText, type LocationBucket, type LocationObservation } from '../../lib/assetLocation.ts';
import { ASSET_CLASS_META } from '../../lib/riskProfiles.ts';
import InfoTip from './InfoTip.tsx';
import { CARD, CardHeader, FOOTER, NOTE, NUM, SkeletonBar, SkeletonStyles, StatTile, SubHeading, TH } from './ui.tsx';

// Fee and account check-up on the Allocation page: what the funds charge each
// year (and what that adds up to over the Forecast's horizon), plus a table of
// which kinds of investments sit in which kinds of account. Collapsed by
// default; nothing is fetched — and no fund-fee lookup leaves the machine —
// until the user opens it. Read-only apart from the user's own fee figures.

type Money = (n: number) => string;
type ExpenseSource = 'manual' | 'provider' | 'stock' | 'not-fund' | 'cash' | 'unknown';
type FeeProvider = 'yahoo' | 'sec';

// Shape served by GET /api/allocation/fees (server/src/services/feeCheckup.ts).
interface FeeRow {
  id: string; symbol: string; name: string; value: number;
  expenseRatio: number | null; source: ExpenseSource; annualCost: number | null;
  provider?: FeeProvider; asOf?: string; // which provider a 'provider' figure came from
}
interface FeeCheckupData {
  rows: FeeRow[];
  totalValue: number; coveredValue: number; coverage: number;
  weightedRatio: number | null; totalAnnualCost: number; unknownCount: number; largestId: string | null;
  location: {
    buckets: LocationBucket[]; classes: string[];
    cells: Record<string, Partial<Record<LocationBucket, number>>>;
    bucketTotals: Record<LocationBucket, number>; classTotals: Record<string, number>; total: number;
    observations: LocationObservation[];
  };
}

const SOURCE_LABEL: Record<ExpenseSource, string> = {
  manual: 'Your figure',
  provider: 'Published fund data',
  stock: 'A single company’s shares: no fund fee',
  'not-fund': 'Not a fund: no fund fee',
  cash: 'Cash: no fund fee',
  unknown: 'No published figure found',
};

// Tooltip/aria text for a row's figure, naming the provider when known.
function sourceLabel(r: FeeRow): string {
  if (r.source === 'provider' && r.provider === 'sec') {
    return `From the fund’s SEC shareholder report${r.asOf ? ` (period ending ${r.asOf})` : ''}`;
  }
  if (r.source === 'provider' && r.provider === 'yahoo') return 'Published fund data (Yahoo Finance)';
  return SOURCE_LABEL[r.source];
}

const LIST_LIMIT = 10;

// PUT JSON and surface failures (fetch only rejects on network errors).
async function putJson(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); if (j?.error) msg = String(j.error); } catch { /* non-JSON body */ }
    throw new Error(msg);
  }
}

function classLabel(key: string): string {
  return ASSET_CLASS_META.find(m => m.key === key)?.label ?? key;
}

// Inline editor for one holding's fee, typed as a percent ("0.25").
function RatioEditor({ row, onDone, onSaved }: { row: FeeRow; onDone: () => void; onSaved: () => void }) {
  const [text, setText] = useState(row.source === 'manual' && row.expenseRatio != null ? String(Number((row.expenseRatio * 100).toFixed(4))) : '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const parsed = parseRatioInput(text);
  const inputId = useId();

  async function save(clear = false) {
    if (!clear && ('error' in parsed || parsed.ratio == null)) return;
    setSaving(true); setErr(null);
    try {
      await putJson('/api/allocation/expense-ratio', { symbol: row.id, expenseRatio: clear ? null : (parsed as { ratio: number }).ratio });
      onSaved();
      onDone();
    } catch (e) {
      setErr(`Couldn't save: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  const invalid = 'error' in parsed;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
      <label htmlFor={inputId} style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
        Yearly fee for {row.symbol || row.name}, in percent
      </label>
      <input id={inputId} value={text} onChange={e => setText(e.target.value)} autoFocus inputMode="decimal" placeholder="e.g. 0.25"
        aria-invalid={invalid} aria-describedby={invalid ? `${inputId}-err` : undefined}
        onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') onDone(); }}
        style={{ width: 72, padding: '5px 8px', fontSize: 13, background: 'var(--bg)', border: `1px solid ${invalid ? 'var(--red)' : 'var(--border)'}`, borderRadius: 6, color: 'var(--text)', textAlign: 'right' }} />
      <span aria-hidden="true" style={{ fontSize: 12, color: 'var(--muted)' }}>%</span>
      <button type="button" className="btn-primary btn-sm" onClick={() => save()} disabled={saving || invalid || !('ratio' in parsed) || parsed.ratio == null}>{saving ? 'Saving…' : 'Save'}</button>
      {row.source === 'manual' && (
        <button type="button" className="btn-ghost btn-sm" onClick={() => save(true)} disabled={saving}
          title="Remove your figure and use the published one, if any">Clear</button>
      )}
      <button type="button" className="btn-ghost btn-sm" onClick={onDone} disabled={saving}>Cancel</button>
      {invalid && <span id={`${inputId}-err`} style={{ flexBasis: '100%', textAlign: 'right', fontSize: 12, color: 'var(--red)' }}>{parsed.error}</span>}
      {err && <span role="alert" style={{ flexBasis: '100%', textAlign: 'right', fontSize: 12, color: 'var(--red)' }}>{err}</span>}
    </div>
  );
}

function FeeList({ data, money, moneyFine, onSaved }: { data: FeeCheckupData; money: Money; moneyFine: Money; onSaved: () => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  // Unknown rows always show (they sort last), so the "+ add" the note
  // points to is never hidden behind "Show all".
  const shown = showAll ? data.rows : collapsedFeeRows(data.rows, LIST_LIMIT);
  // Return keyboard focus to the row's fee button when its editor closes
  // (save, Enter, Escape or Cancel); otherwise it falls back to the page top.
  const feeButtons = useRef(new Map<string, HTMLButtonElement>());
  const lastEdited = useRef<string | null>(null);
  useEffect(() => {
    if (editing != null || lastEdited.current == null) return;
    feeButtons.current.get(lastEdited.current)?.focus();
    lastEdited.current = null;
  }, [editing]);
  const startEdit = (id: string) => { lastEdited.current = id; setEditing(id); };
  const feeRef = (id: string) => (el: HTMLButtonElement | null) => {
    if (el) feeButtons.current.set(id, el); else feeButtons.current.delete(id);
  };
  const cols = 'minmax(0, 2.2fr) minmax(84px, 1fr) minmax(96px, 1fr) minmax(92px, 1fr)';
  const head: React.CSSProperties = { ...TH, ...NUM };
  return (
    <div>
      <div className="scroll-x"><div className="tbl-scroll" style={{ ['--tbl-min']: '540px' } as React.CSSProperties}>
        <div role="table" aria-label="Yearly fund fees, largest cost first">
          <div role="row" style={{ display: 'grid', gridTemplateColumns: cols, gap: 12, padding: '0 0 6px', borderBottom: '1px solid var(--border)' }}>
            <span role="columnheader" style={TH}>Holding</span>
            <span role="columnheader" style={head}>Value</span>
            <span role="columnheader" style={{ ...head, display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 4 }}>
              Yearly fee <InfoTip text="The fund's expense ratio: the share of your balance it takes each year to run the fund. It comes out of the fund's value automatically, so it never shows up as a bill." />
            </span>
            <span role="columnheader" style={head}>Cost per year</span>
          </div>
          {shown.map(r => {
            const largest = r.id === data.largestId;
            return (
              <div role="row" key={r.id} style={{ display: 'grid', gridTemplateColumns: cols, gap: 12, alignItems: 'center', fontSize: 13, padding: '7px 0', minHeight: 36, borderBottom: '1px solid var(--border)' }}>
                <span role="cell" style={{ minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ fontWeight: 600, flex: 'none', minWidth: 44 }}>{r.symbol || '—'}</span>
                  <span title={r.name} style={{ color: 'var(--muted)', fontSize: 12, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                </span>
                <span role="cell" style={NUM}>{money(r.value)}</span>
                <span role="cell" style={NUM}>
                  {editing === r.id ? (
                    <RatioEditor row={r} onDone={() => setEditing(null)} onSaved={onSaved} />
                  ) : r.expenseRatio == null ? (
                    <button type="button" ref={feeRef(r.id)} onClick={() => startEdit(r.id)}
                      style={{ background: 'transparent', border: 'none', color: 'var(--accent)', fontSize: 12, padding: '4px 0', cursor: 'pointer' }}
                      aria-label={`Add the yearly fee for ${r.symbol || r.name}`}>
                      Unknown · + add
                    </button>
                  ) : (
                    <button type="button" ref={feeRef(r.id)} onClick={() => startEdit(r.id)} title={`${sourceLabel(r)} · click to enter your own figure`}
                      aria-label={`${fmtRatio(r.expenseRatio)} a year, ${sourceLabel(r)}. Edit the yearly fee for ${r.symbol || r.name}`}
                      style={{ background: 'transparent', border: 'none', color: 'var(--text)', fontSize: 13, padding: '2px 0', cursor: 'pointer', borderBottom: '1px dashed var(--border)', borderRadius: 0, fontVariantNumeric: 'tabular-nums' }}>
                      {(r.source === 'stock' || r.source === 'cash' || r.source === 'not-fund') && <span style={{ color: 'var(--muted)', fontSize: 12, marginRight: 6 }}>{r.source === 'stock' ? 'stock' : r.source === 'cash' ? 'cash' : 'not a fund'}</span>}
                      {r.source === 'manual' && <span style={{ color: 'var(--accent)', fontSize: 12, marginRight: 6 }}>yours</span>}
                      {r.source === 'provider' && r.provider && <span style={{ color: 'var(--muted)', fontSize: 11, marginRight: 6 }}>{r.provider === 'sec' ? 'SEC report' : 'Yahoo'}</span>}
                      {fmtRatio(r.expenseRatio)}
                    </button>
                  )}
                </span>
                <span role="cell" style={{ ...NUM, color: r.annualCost == null ? 'var(--muted)' : 'var(--text)', fontWeight: largest ? 600 : 400 }}>
                  {largest && <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--amber)', marginRight: 6 }}>Largest</span>}
                  {r.annualCost == null ? '—' : moneyFine(r.annualCost)}
                </span>
              </div>
            );
          })}
        </div>
      </div></div>
      {(showAll ? data.rows.length > LIST_LIMIT : shown.length < data.rows.length) && (
        <button type="button" onClick={() => setShowAll(s => !s)} aria-expanded={showAll}
          style={{ background: 'transparent', border: 'none', color: 'var(--accent)', fontSize: 12, padding: '8px 0 0', cursor: 'pointer', minHeight: 32 }}>
          {showAll ? 'Show fewer' : `Show all ${data.rows.length}`}
        </button>
      )}
    </div>
  );
}

function LocationTable({ loc, money }: { loc: FeeCheckupData['location']; money: Money }) {
  // Only the account types the user actually has get a column.
  const buckets = loc.buckets.filter(b => (loc.bucketTotals[b] ?? 0) > 0.5);
  if (!loc.classes.length || !buckets.length) {
    return <p style={{ color: 'var(--muted)', fontSize: 13 }}>No investment accounts to show.</p>;
  }
  const cell = (v: number | undefined) => (v != null && v > 0.5 ? money(v) : '—');
  const thStyle: React.CSSProperties = { ...TH, ...NUM, padding: '0 0 6px 12px', borderBottom: '1px solid var(--border)' };
  const tdStyle: React.CSSProperties = { ...NUM, padding: '8px 0 8px 12px', borderBottom: '1px solid var(--border)' };
  return (
    <div className="scroll-x"><div className="tbl-scroll" style={{ ['--tbl-min']: `${180 + buckets.length * 110}px` } as React.CSSProperties}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <caption style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
          Investments by kind and by account tax type
        </caption>
        <thead>
          <tr>
            <th scope="col" style={{ ...thStyle, textAlign: 'left', paddingLeft: 0 }}>Kind of investment</th>
            {buckets.map(b => (
              <th key={b} scope="col" style={thStyle}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  {bucketLabel(b)} <InfoTip text={LOCATION_BUCKET_LABELS[b]?.hint ?? ''} width={220} />
                </span>
              </th>
            ))}
            <th scope="col" style={thStyle}>Total</th>
          </tr>
        </thead>
        <tbody>
          {loc.classes.map(c => (
            <tr key={c}>
              <th scope="row" style={{ ...tdStyle, textAlign: 'left', paddingLeft: 0, fontWeight: 400 }}>{classLabel(c)}</th>
              {buckets.map(b => <td key={b} style={{ ...tdStyle, color: (loc.cells[c]?.[b] ?? 0) > 0.5 ? 'var(--text)' : 'var(--muted)' }}>{cell(loc.cells[c]?.[b])}</td>)}
              <td style={{ ...tdStyle, color: 'var(--muted)' }}>{cell(loc.classTotals[c])}</td>
            </tr>
          ))}
          <tr>
            <th scope="row" style={{ ...tdStyle, textAlign: 'left', paddingLeft: 0, fontWeight: 600, borderBottom: 'none' }}>Total</th>
            {buckets.map(b => <td key={b} style={{ ...tdStyle, fontWeight: 600, borderBottom: 'none' }}>{cell(loc.bucketTotals[b])}</td>)}
            <td style={{ ...tdStyle, fontWeight: 600, borderBottom: 'none' }}>{cell(loc.total)}</td>
          </tr>
        </tbody>
      </table>
    </div></div>
  );
}

function FeeCheckupBody({ privacy, money }: { privacy: boolean; money: Money }) {
  const { data, loading, error, refetch } = useApi<FeeCheckupData>('/api/allocation/fees');
  // The Forecast's saved plan: return, inflation and end age, plus earner 0's
  // age (the Forecast's "Current age"), for the "over N years" tile.
  // Read-only here — the setters are never used, so nothing is written back.
  const [savedPlan] = usePersistentState<Assumptions>('mon.fcAssumptions', DEFAULT_ASSUMPTIONS);
  const [savedEarners] = usePersistentState<Earner[]>('mon.fcEarners', DEFAULT_EARNERS);
  const rates = useMemo(() => forecastRates(savedPlan, savedEarners), [savedPlan, savedEarners]);
  const isMobile = useIsMobile();
  // Per-row costs are often small; show cents under $10 so "$0" never hides a real fee.
  const moneyFine: Money = n => (privacy ? '••••••' : fmtMoney(n, { cents: n > 0 && n < 10 }));

  if (loading) {
    return (
      <div role="status" aria-busy="true" aria-label="Looking up fund fees">
        <SkeletonStyles />
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 10 }}>
          {[0, 1, 2].map(i => (
            <div key={i} style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px', height: 90 }}>
              <SkeletonBar width="50%" height={10} />
              <SkeletonBar width="35%" height={20} style={{ marginTop: 12 }} />
              <SkeletonBar width="65%" height={8} style={{ marginTop: 10 }} />
            </div>
          ))}
        </div>
        <div style={{ display: 'grid', gap: 14, marginTop: 28 }}>
          {[0, 1, 2, 3, 4, 5].map(i => <SkeletonBar key={i} height={12} width={`${92 - i * 6}%`} />)}
        </div>
      </div>
    );
  }
  // A failed refetch (after a save, say) keeps the last good figures: the full
  // error state is only for when there is nothing to show.
  if (!data) {
    return (
      <p role="alert" style={{ color: 'var(--red)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        Couldn't load the fee check-up{error ? `: ${error}` : ''}.
        <button type="button" className="btn-ghost" onClick={() => refetch()} style={{ fontSize: 12, padding: '4px 12px' }}>Retry</button>
      </p>
    );
  }
  const refreshError = error ? (
    <p role="alert" style={{ color: 'var(--red)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
      Couldn't refresh the fee check-up: {error}. Showing the last figures.
      <button type="button" className="btn-ghost" onClick={() => refetch()} style={{ fontSize: 12, padding: '3px 10px' }}>Retry</button>
    </p>
  ) : null;
  if (!data.rows.length) {
    return <div>{refreshError}<p style={{ color: 'var(--muted)', fontSize: 13 }}>No brokerage holdings to check yet.</p></div>;
  }

  const ratio = data.weightedRatio;
  // Each fund grown at the return less its own fee, gaps summed (stocks, cash
  // and unknown funds add nothing). null when no fee is known at all.
  const dragCost = ratio != null ? portfolioFeeDrag(data.rows, rates) : null;
  // 0.07 → "7%", 0.025 → "2.5%" (one decimal at most, trailing zero dropped).
  const pct = (x: number) => `${Number.isFinite(x) ? Number((x * 100).toFixed(1)) : 0}%`;
  const unknownValue = Math.max(0, data.totalValue - data.coveredValue);
  const observations = data.location.observations
    .map(o => observationText(o, money))
    .filter((t): t is string => !!t);

  return (
    <div>
      {refreshError}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 10 }}>
        <StatTile label="Average yearly fee" value={ratio == null ? '—' : fmtRatio(ratio)} tipLabel=""
          sub={ratio == null ? 'No fee figures yet' : 'Weighted by how much you hold of each'}
          tip="The value-weighted expense ratio across your holdings with a known fee. Single stocks and cash count as 0%, since they charge no fund fee." />
        <StatTile label="Fees this year" value={ratio == null ? '—' : money(data.totalAnnualCost)}
          sub={ratio == null ? 'No fee figures yet' : "At today's balances"} />
        <StatTile label={`Fees over ${rates.years} year${rates.years === 1 ? '' : 's'}`} value={dragCost != null ? money(dragCost) : '—'} tipLabel=""
          sub={`In today's dollars, at ${pct(rates.expectedReturn)} growth and ${pct(rates.inflation)} inflation${rates.fromSavedPlan ? ' from your Forecast' : ' (Forecast defaults)'}`}
          tip="How much smaller these holdings would be after the Forecast's horizon because of fees: each fund is grown at the full return and at the return minus its own fee, with no new money added, and the gaps are added up. It counts the growth each year's fee would have earned, so it's more than the yearly cost times the years. Funds with an unknown fee are left out." />
      </div>

      {data.unknownCount > 0 && (
        <p style={{ ...NOTE, marginTop: 12, borderLeft: '3px solid var(--amber)', paddingLeft: 10 }}>
          <strong style={{ color: 'var(--text)' }}>Partial picture:</strong>{' '}
          {data.unknownCount} holding{data.unknownCount === 1 ? '' : 's'} ({money(unknownValue)}, {pct(1 - data.coverage)} of these investments) {data.unknownCount === 1 ? 'has' : 'have'} no published fee, so {data.unknownCount === 1 ? 'it is' : 'they are'} left out of the figures above.
          {' '}Use “+ add” in the list to enter a fee from the fund's fact sheet.
        </p>
      )}

      {/* Two tables, stacked. Side by side, the location table (one column per
          account type, ~750px) was cut off and the short table left a gap beside
          the long holdings list. The short summary table comes first. */}
      <div style={{ display: 'grid', gap: 28 }}>
        <div style={{ minWidth: 0, order: 2 }}>
          <SubHeading>What each holding costs</SubHeading>
          <FeeList data={data} money={money} moneyFine={moneyFine} onSaved={() => refetch()} />
        </div>
        <div style={{ minWidth: 0, order: 1 }}>
          <SubHeading tip="Sometimes called asset location: the same investment is taxed differently depending on the kind of account holding it. Account types follow the Forecast page, including any accounts you reassigned there.">
            Where your investments sit
          </SubHeading>
          <p style={{ ...NOTE, marginTop: -4, marginBottom: 8 }}>Brokerage and retirement holdings by kind and by account tax type.</p>
          <LocationTable loc={data.location} money={money} />
          {observations.length > 0 && (
            <ul style={{ listStyle: 'none', margin: '12px 0 0', padding: 0, display: 'grid', gap: 6 }}>
              {observations.map(t => (
                <li key={t} style={{ ...NOTE, display: 'flex', gap: 8, alignItems: 'baseline' }}>
                  <span aria-hidden="true" style={{ flex: 'none', width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)', transform: 'translateY(-1px)' }} />
                  <span>{t}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <p style={FOOTER}>
        Estimates for planning, not advice. Fund fees come from published fund data (Yahoo Finance, or the fund's SEC shareholder report when Yahoo has none), looked up by ticker symbol only, and can lag a fund's latest change; your own figures always take precedence.
      </p>
    </div>
  );
}

export default function FeeCheckup({ privacy, money }: { privacy: boolean; money: Money }) {
  const [open, setOpen] = usePersistentState('mon.feeCheckupOpen', false);
  const bodyId = useId();
  return (
    <section aria-label="Fees and account check-up" style={CARD}>
      <CardHeader
        title="Fees and account check-up"
        collapse={{ open, onToggle: () => setOpen(o => !o), controls: bodyId }}
        subtitle={open
          ? 'What your funds charge each year, and which kinds of investments sit in which kinds of account.'
          : 'What your funds charge each year, and where your investments sit. Opening this looks up each fund’s published fee by ticker symbol.'}
      />
      {open && <div id={bodyId}><FeeCheckupBody privacy={privacy} money={money} /></div>}
    </section>
  );
}
