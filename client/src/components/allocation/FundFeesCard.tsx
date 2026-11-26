import { useId, useState } from 'react';
import { fmtRatio } from '../../lib/feeDrag.ts';
import { feeGroups, foldList, freeLine, holdingLabel, namedList } from '../../lib/fundFees.ts';
import { feeDragOver, fineMoney, sourceLabel, useForecastRates, type FeeCheckupData, type FeeRow, type Money } from './FeeCheckup.tsx';
import { CARD, CardHeader, NOTE, StatTile, SubHeading } from './ui.tsx';

// "Fund fees" on the Investments page: what the user's funds charge a year,
// the same three figures as the headline tile (yearly cost, value-weighted
// average, long-run drag; all from the one fee check-up request, so they can't
// disagree), then which holdings the fees go to. Read-only: a fee is entered or
// corrected in Positions' Fee column, which the note about missing figures
// links to. Privacy mode masks every amount (the page's formatters); fee
// percentages aren't private.

// One headline figure's slot: grows to fill its row, wraps below ~140px.
const FIGURE: React.CSSProperties = { flex: '1 1 140px', minWidth: 0, display: 'grid' };
const SR_ONLY: React.CSSProperties ={ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' };

// "12%" / "0.4%" / "<0.1%": whole percents unless that would hide a sliver.
const share = (p: number) => (p >= 0.01 ? `${Math.round(p * 100)}%` : p >= 0.001 ? `${(p * 100).toFixed(1)}%` : '<0.1%');

export default function FundFeesCard({ fees, money, privacy, onShowPositions, reserveRight = 0 }: {
  fees: { data: FeeCheckupData | null; loading: boolean; error: string | null; refetch: () => unknown };
  money: Money;
  privacy: boolean;
  /** Jump to Positions, where a missing fee is entered. Gets the link's click. */
  onShowPositions?: (e: React.MouseEvent) => void;
  reserveRight?: number;
}) {
  const { data, loading, error, refetch } = fees;
  const rates = useForecastRates();
  const drag = feeDragOver(data, rates);
  const groups = feeGroups(data?.rows ?? []);
  const rate = `${Math.round(rates.expectedReturn * 1000) / 10}%`;

  let body: React.ReactNode;
  if (loading && !data) {
    body = <p role="status" style={NOTE}>Looking up fund fees…</p>;
  } else if (!data) {
    body = (
      <p role="alert" style={{ color: 'var(--red)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        Fees unavailable{error ? `: ${error}` : ''}.
        <button type="button" className="btn-ghost btn-sm" onClick={() => refetch()}>Retry</button>
      </p>
    );
  } else {
    body = (
      <>
        {data.weightedRatio == null ? (
          <p style={{ fontSize: 13 }}>
            No fee figures yet{groups.unknown.length ? '' : ': there are no holdings to look up'}.
          </p>
        ) : (
          <>
            {/* Three across when they fit; in a narrow card the first two share a
                row and the long-run figure takes the next one whole. */}
            <div role="group" aria-label="Fund fee figures" style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              <div style={FIGURE}><StatTile label="Cost per year" value={money(data.totalAnnualCost)} unit="/ yr" sub="at today’s balances"
                tip="Each holding’s value times its yearly fee, added up. Funds take the fee out of their value day by day, so it never shows up as a bill." /></div>
              <div style={FIGURE}><StatTile label="Average fee" value={fmtRatio(data.weightedRatio)} sub="weighted by value"
                tip="The expense ratio across your holdings with a known fee, each weighted by its value. Single stocks and cash count as 0%." /></div>
              <div style={FIGURE}><StatTile label={`Over ${rates.years} yrs`} value={drag != null ? money(drag) : '—'}
                sub={rates.fromSavedPlan ? 'with your Forecast’s rates' : 'with the Forecast’s defaults'}
                tip={`How much smaller these holdings would be after the Forecast’s horizon because of fees: each fund grown at ${rate} a year and at ${rate} less its own fee, with nothing added or taken out, the gap stated in today’s dollars. More than ${rates.years} times the yearly cost, because each year’s fee also loses the growth it would have earned. Rates ${rates.fromSavedPlan ? 'from your Forecast' : 'are the Forecast’s defaults until you set your own there'}.`} /></div>
            </div>
            {/* Nothing charging (only stocks and cash): the line below says so. */}
            {groups.charging.length > 0 && <FeeList rows={groups.charging} total={data.totalAnnualCost} money={money} privacy={privacy} />}
          </>
        )}
        {(() => {
          const line = freeLine(groups.free);
          return line && (
            <p style={{ ...NOTE, marginTop: 12 }} title={groups.free.map(holdingLabel).join(', ')}>{line}</p>
          );
        })()}
        {groups.unknown.length > 0 && (
          <p className="inv-callout" style={{ marginTop: 12 }}>
            {groups.unknown.length === 1 ? '1 holding has' : `${groups.unknown.length} holdings have`} no fee figure, so{' '}
            {groups.unknown.length === 1 ? 'it isn’t' : 'they aren’t'} in these totals: {namedList(groups.unknown.map(holdingLabel))}.{' '}
            <a href="#inv-positions" className="inv-link" onClick={onShowPositions} style={{ fontSize: 13 }}>
              Add {groups.unknown.length === 1 ? 'its fee' : 'their fees'} in Positions
            </a>
          </p>
        )}
      </>
    );
  }

  return (
    <section aria-label="Fund fees" style={{ ...CARD, height: '100%', boxSizing: 'border-box' }}>
      <CardHeader reserveRight={reserveRight} title="Fund fees"
        subtitle="What your funds charge each year at today’s balances." />
      {body}
    </section>
  );
}

// "Where the fees go": each holding that charges a fee, largest yearly cost
// first, with its fee, its yearly cost and (a bar) its share of all yearly
// fees, in Bond quality's "Held in" columns.
function FeeList({ rows, total, money, privacy }: {
  rows: { row: FeeRow; share: number }[]; total: number; money: Money; privacy: boolean;
}) {
  const [all, setAll] = useState(false);
  const listId = useId();
  const fine = fineMoney(privacy);
  const { shown, folds } = foldList(rows, all);
  return (
    <>
      <SubHeading tipLabel="Where the fees go" style={{ margin: '18px 0 6px' }}
        tip={`The holdings that charge a fee, largest yearly cost first. The bar is each one’s share of the ${money(total)} a year.`}>
        Where the fees go
      </SubHeading>
      <div className="inv-held-row" aria-hidden="true" style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, paddingTop: 0 }}>
        <span>Holding</span>
        <span className="inv-rank-bar" style={{ background: 'none' }} />
        <span style={{ textAlign: 'right' }}>Fee</span>
        <span style={{ textAlign: 'right' }}>Cost / yr</span>
      </div>
      <ul id={listId} className="inv-held">
        {shown.map(({ row: r, share: s }) => {
          const label = holdingLabel(r);
          return (
            <li key={r.id} className="inv-held-row" title={`${label} · ${sourceLabel(r)}`}>
              <span className="inv-rank-label">
                <strong style={{ fontWeight: 600 }}>{label}</strong>
                {r.symbol && r.name && r.name !== r.symbol && <small>{r.name}</small>}
              </span>
              <span className="inv-rank-bar" aria-hidden="true"><i style={{ width: `${Math.min(100, s * 100)}%` }} /></span>
              <span className="inv-rank-pct">
                {fmtRatio(r.expenseRatio)}
                {r.source === 'manual' && <span aria-hidden="true" style={{ color: 'var(--accent)' }}> •</span>}
                <span style={SR_ONLY}> a year ({sourceLabel(r)}), </span>
              </span>
              <span className="inv-rank-amt">
                {fine(r.annualCost ?? 0)}<span style={SR_ONLY}> a year, {share(s)} of your fund fees</span>
              </span>
            </li>
          );
        })}
      </ul>
      {folds && (
        <button type="button" className="inv-link" aria-expanded={all} aria-controls={listId} onClick={() => setAll(a => !a)} style={{ marginTop: 4 }}>
          {all ? 'Show fewer' : `Show all ${rows.length}`}
        </button>
      )}
    </>
  );
}
