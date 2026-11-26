import { useId, useMemo, useState } from 'react';
import { useApi } from '../../hooks/useApi.ts';
import { usePersistentState } from '../../hooks/usePersistentState.ts';
import { fmtMoney } from '../../lib/format.ts';
import { DEFAULT_ASSUMPTIONS, DEFAULT_EARNERS, type Assumptions, type Earner } from '../../lib/forecastConfig.ts';
import { forecastRates, parseRatioInput, portfolioFeeDrag, type ForecastRates } from '../../lib/feeDrag.ts';
import { LOCATION_BUCKET_LABELS, bucketLabel, observationText, type LocationBucket, type LocationObservation } from '../../lib/assetLocation.ts';
import { ASSET_CLASS_META } from '../../lib/riskProfiles.ts';
import InfoTip from './InfoTip.tsx';
import { CARD, CardHeader, NOTE, NUM, TH } from './ui.tsx';

// Fund fees and asset location on the Investments page. One request,
// GET /api/allocation/fees, feeds three places: the "Fund fees" headline tile,
// the Fee and Cost / yr columns of Positions (where a fee can be entered or
// corrected), and the "Where your investments sit" card here, which shows which
// kinds of investments sit in which kinds of account. Fees are looked up by
// ticker symbol only (the same lookups the allocation itself makes, cached
// ~30 days). Read-only apart from the user's own fee figures.

export type Money = (n: number) => string;
type ExpenseSource = 'manual' | 'provider' | 'stock' | 'not-fund' | 'cash' | 'unknown';
type FeeProvider = 'yahoo' | 'sec';

// Shape served by GET /api/allocation/fees (server/src/services/feeCheckup.ts).
export interface FeeRow {
  id: string; symbol: string; name: string; value: number;
  expenseRatio: number | null; source: ExpenseSource; annualCost: number | null;
  provider?: FeeProvider; asOf?: string; // which provider a 'provider' figure came from
}
export interface FeeCheckupData {
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

export const FEES_URL = '/api/allocation/fees';

export function useFeeCheckup() {
  return useApi<FeeCheckupData>(FEES_URL);
}

// The Forecast's saved plan: return, inflation and end age, plus earner 0's
// age (the Forecast's "Current age"), for the "fees over N years" figure.
// Read-only here — the setters are never used, so nothing is written back.
export function useForecastRates(): ForecastRates {
  const [savedPlan] = usePersistentState<Assumptions>('mon.fcAssumptions', DEFAULT_ASSUMPTIONS);
  const [savedEarners] = usePersistentState<Earner[]>('mon.fcEarners', DEFAULT_EARNERS);
  return useMemo(() => forecastRates(savedPlan, savedEarners), [savedPlan, savedEarners]);
}

// Each fund grown at the return less its own fee, gaps summed (stocks, cash and
// unknown funds add nothing). null when no fee is known at all.
export function feeDragOver(data: FeeCheckupData | null, rates: ForecastRates): number | null {
  return data && data.weightedRatio != null ? portfolioFeeDrag(data.rows, rates) : null;
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
export function sourceLabel(r: FeeRow): string {
  if (r.source === 'provider' && r.provider === 'sec') {
    return `From the fund’s SEC shareholder report${r.asOf ? ` (period ending ${r.asOf})` : ''}`;
  }
  if (r.source === 'provider' && r.provider === 'yahoo') return 'Published fund data (Yahoo Finance)';
  return SOURCE_LABEL[r.source];
}

// Per-row costs are often small; show cents under $10 so "$0" never hides a real fee.
export const fineMoney = (privacy: boolean): Money => n => (privacy ? '••••••' : fmtMoney(n, { cents: n > 0 && n < 10 }));

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

// Inline editor for one holding's fee, typed as a percent ("0.25"). Shown in
// the Positions table, in a row under the holding.
export function RatioEditor({ row, onDone, onSaved }: { row: FeeRow; onDone: () => void; onSaved: () => void }) {
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
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
      <label htmlFor={inputId} style={{ fontSize: 12, color: 'var(--muted)' }}>
        Yearly fee for {row.symbol || row.name}
      </label>
      <input id={inputId} value={text} onChange={e => setText(e.target.value)} autoFocus inputMode="decimal" placeholder="e.g. 0.25"
        aria-invalid={invalid} aria-describedby={invalid ? `${inputId}-err` : undefined}
        onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') onDone(); }}
        style={{ width: 72, padding: '5px 8px', fontSize: 13, background: 'var(--surface)', border: `1px solid ${invalid ? 'var(--red)' : 'var(--border)'}`, borderRadius: 6, color: 'var(--text)', textAlign: 'right' }} />
      <span aria-hidden="true" style={{ fontSize: 12, color: 'var(--muted)' }}>%</span>
      <button type="button" className="btn-primary btn-sm" onClick={() => save()} disabled={saving || invalid || !('ratio' in parsed) || parsed.ratio == null}>{saving ? 'Saving…' : 'Save'}</button>
      {row.source === 'manual' && (
        <button type="button" className="btn-ghost btn-sm" onClick={() => save(true)} disabled={saving}
          title="Remove your figure and use the published one, if any">Clear</button>
      )}
      <button type="button" className="btn-ghost btn-sm" onClick={onDone} disabled={saving}>Cancel</button>
      {invalid && <span id={`${inputId}-err`} style={{ flexBasis: '100%', fontSize: 12, color: 'var(--red)' }}>{parsed.error}</span>}
      {err && <span role="alert" style={{ flexBasis: '100%', fontSize: 12, color: 'var(--red)' }}>{err}</span>}
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
  const thStyle: React.CSSProperties = { ...TH, ...NUM, fontSize: 11, padding: '0 0 6px 12px', borderBottom: '1px solid var(--border)' };
  const tdStyle: React.CSSProperties = { ...NUM, padding: '8px 0 8px 12px', borderBottom: '1px solid var(--border)' };
  return (
    <div className="scroll-x"><div className="tbl-scroll" style={{ ['--tbl-min']: `${150 + buckets.length * 96}px` } as React.CSSProperties}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <caption style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
          Investments by kind and by account tax type
        </caption>
        <thead>
          <tr>
            <th scope="col" style={{ ...thStyle, textAlign: 'left', paddingLeft: 0 }}><span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>Kind of investment</span></th>
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

// "Where your investments sit": the asset-location table, with whatever it
// observes (bonds in taxable, foreign stock in a Roth…) as one callout.
export default function AccountTypesCard({ fees, money, reserveRight = 0 }: {
  fees: { data: FeeCheckupData | null; loading: boolean; error: string | null; refetch: () => unknown };
  money: Money;
  reserveRight?: number;
}) {
  const { data, loading, error, refetch } = fees;
  const observations = (data?.location.observations ?? [])
    .map(o => observationText(o, money))
    .filter((t): t is string => !!t);
  return (
    <section aria-label="Where your investments sit" style={{ ...CARD, height: '100%', boxSizing: 'border-box' }}>
      <CardHeader reserveRight={reserveRight} title="Where your investments sit"
        tip="Sometimes called asset location: the same investment is taxed differently depending on the kind of account holding it. Account types follow the Forecast page, including any accounts you reassigned there."
        subtitle="Brokerage and retirement holdings by kind and by account tax type." />
      {loading && !data ? (
        <p role="status" style={NOTE}>Looking up your accounts…</p>
      ) : !data ? (
        <p role="alert" style={{ color: 'var(--red)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          Couldn't load this{error ? `: ${error}` : ''}.
          <button type="button" className="btn-ghost btn-sm" onClick={() => refetch()}>Retry</button>
        </p>
      ) : (
        <>
          <LocationTable loc={data.location} money={money} />
          {observations.length > 0 && (
            <p className="inv-callout" style={{ marginTop: 12 }}>
              <strong>{observations.length === 1 ? '1 thing' : `${observations.length} things`} to look at.</strong>{' '}
              {observations.join(' ')}
            </p>
          )}
        </>
      )}
    </section>
  );
}
