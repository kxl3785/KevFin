import { useMemo } from 'react';
import { useApi } from '../../hooks/useApi.ts';
import { fmtRatio } from '../../lib/feeDrag.ts';
import { rangeBounds, windowSeries, fmtReturn, gapWords, type PerfRange } from '../../lib/perfWindow.ts';
import { periodLabel } from '../../lib/periodLabel.ts';
import { driftWords, type GainSummary, type OffTarget } from '../../lib/investments.ts';
import { PERF_URL, type PerformanceData } from '../PerformanceChart.tsx';
import { feeDragOver, useForecastRates, type FeeCheckupData } from './FeeCheckup.tsx';
import InfoTip from './InfoTip.tsx';
import { classLabel } from './AllocationCard.tsx';

// The five headline figures at the top of the Investments page. Each one is
// computed where it always was and only formatted here: the return comes from
// the same windowing as the performance chart (same request, same range), the
// gain from the Positions table's rule, "off target" from the allocation card's
// rebalance result, and the fees from the fee check-up. Privacy mode masks
// every amount and return.

type Money = (n: number) => string;

// Short range names for the tile's label ("Return, YTD", "Return, 3Y").
const RANGE_SHORT: Record<string, string> = { YTD: 'YTD', '1Y': '1Y', '3Y': '3Y', '5Y': '5Y', ALL: 'max', custom: 'custom range' };

function Tile({ label, tip, value, unit, sub, color, onClick, title }: {
  label: string; tip?: string; value: React.ReactNode; unit?: string; sub?: React.ReactNode; color?: string;
  onClick?: () => void; title?: string;
}) {
  const body = (
    <>
      <span className="inv-kpi-label">{label}{tip && !onClick && <InfoTip label={label} text={tip} />}</span>
      <span className="inv-kpi-value" style={color ? { color } : undefined}>
        {value}{unit && <span className="inv-kpi-unit">{unit}</span>}
      </span>
      {sub && <span className="inv-kpi-sub">{sub}</span>}
    </>
  );
  return onClick
    ? <button type="button" className="inv-kpi" onClick={onClick} title={title ?? tip}>{body}</button>
    : <div className="inv-kpi" title={title}>{body}</div>;
}

export default function HeadlineTiles({ invested, accounts, gain, off, band, hasTargets, fees, feesLoading, money, privacy, perfRange, onJump }: {
  invested: number;
  accounts: number;
  gain: GainSummary;
  off: OffTarget | null;
  band: number;
  hasTargets: boolean;
  fees: FeeCheckupData | null;
  feesLoading: boolean;
  money: Money;
  privacy: boolean;
  perfRange: PerfRange;
  /** Scroll to a section of the page (the allocation card, positions). */
  onJump: (id: string) => void;
}) {
  const { data: perf } = useApi<PerformanceData>(PERF_URL);
  const rates = useForecastRates();

  // Return over the chart's selected window, with the S&P 500 beside it.
  const ret = useMemo(() => {
    if (!perf) return null;
    const [from, to] = rangeBounds(perfRange, perf.startDate, perf.endDate);
    const total = perf.series.find(s => s.id === 'total');
    const spy = perf.series.find(s => s.id === 'SPY');
    const mine = total ? windowSeries(total.points, from, to) : null;
    if (!mine) return null;
    const bench = spy ? windowSeries(spy.points, from, to) : null;
    return { mine: mine.totalReturn, bench: bench?.totalReturn ?? null, period: periodLabel(perfRange.range, from, to, mine.points[0].date) };
  }, [perf, perfRange]);

  const mask = (s: string) => (privacy ? '••••' : s);
  const tone = (n: number | null | undefined) => (privacy || n == null ? undefined : n >= 0 ? 'var(--green)' : 'var(--red)');
  const drag = feeDragOver(fees, rates);

  return (
    <div className="inv-kpis" role="group" aria-label="Headline figures">
      <Tile label="Invested" value={money(invested)}
        sub={`${accounts} account${accounts === 1 ? '' : 's'} · excludes real estate`}
        tip="Everything in your brokerage and retirement accounts. Homes and manually tracked assets are listed under Positions → Other assets." />

      <Tile label={`Return, ${RANGE_SHORT[perfRange.range] ?? perfRange.range}`} title={ret ? `Return ${ret.period}` : undefined}
        value={ret ? mask(fmtReturn(ret.mine)) : '—'} color={tone(ret?.mine)}
        sub={ret
          ? ret.bench != null ? <>S&amp;P 500 {mask(fmtReturn(ret.bench))}{!privacy && <> · {gapWords(ret.mine, ret.bench)}</>}</> : 'Range set on the chart below'
          : perf ? 'No history in this range' : 'Fetching price history…'}
        tip="What today's holdings would have returned over the range picked on the Performance chart, ignoring contributions and trades. Brokerage accounts only." />

      <Tile label="Unrealized gain"
        value={gain.gain == null ? '—' : privacy ? money(gain.gain) : `${gain.gain >= 0 ? '+' : '−'}${money(Math.abs(gain.gain))}`} color={tone(gain.gain)}
        sub={gain.gain == null
          ? 'No cost basis yet · add one in Positions'
          : <>{gain.pct != null ? mask(`${gain.pct >= 0 ? '+' : '−'}${(Math.abs(gain.pct) * 100).toFixed(1)}%`) + ' · ' : ''}{gain.withCost} of {gain.count} have a cost</>}
        onClick={() => onJump('inv-positions')}
        title="Gain on the investments that have a cost basis, measured on the covered value. Click to see Positions." />

      {hasTargets && off ? (
        <Tile label="Off target"
          value={`${off.out} of ${off.total}`} color={off.out > 0 ? 'var(--amber)' : undefined}
          sub={off.worst ? `${classLabel(off.worst.key)} ${driftWords(off.worst.driftPts)}` : `All within ±${band} pts`}
          onClick={() => onJump('inv-allocation')}
          title={`Kinds of investment outside the ±${band}-point band around their targets. Click to see the allocation.`} />
      ) : (
        <Tile label="Off target" value="—"
          sub={hasTargets ? 'Nothing invested in the targeted kinds yet' : 'No targets yet · set a risk profile or your own'}
          onClick={() => onJump('inv-allocation')}
          title="Set a risk profile or your own targets on the allocation card to see how far your mix sits from them." />
      )}

      <Tile label="Fund fees"
        value={fees ? (fees.weightedRatio == null ? '—' : money(fees.totalAnnualCost)) : '—'} unit={fees?.weightedRatio != null ? '/ yr' : undefined}
        sub={!fees
          ? (feesLoading ? 'Looking up fund fees…' : 'Fees unavailable')
          : fees.weightedRatio == null ? 'No fee figures yet'
          : <>{fmtRatio(fees.weightedRatio)} average{drag != null && <> · {money(drag)} over {rates.years} yrs</>}</>}
        tip={`The value-weighted expense ratio across your holdings with a known fee, and what it costs a year at today's balances. Single stocks and cash count as 0%. "Over ${rates.years} yrs" is how much smaller these holdings would be after the Forecast's horizon because of fees: each fund grown at ${Math.round(rates.expectedReturn * 1000) / 10}% and at that less its own fee, in today's dollars${rates.fromSavedPlan ? ' (from your Forecast)' : ' (Forecast defaults)'}. Each holding's fee is in Positions.`} />
    </div>
  );
}
