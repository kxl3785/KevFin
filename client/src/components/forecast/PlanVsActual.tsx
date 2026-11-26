import { useMemo } from 'react';
import { ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { monthTicks, type PlanVsActual as PlanVsActualData, type TrackStatus } from '../../lib/planTrack.ts';
import { fmtDate } from '../../lib/format.ts';
import { axisScale, fmtAxisMoney } from '../../lib/axis.ts';

// Plan versus actual: recorded net worth since the forecast was pinned (📌),
// drawn over the median and likely range that pin projected, with the sentence
// that says where today stands. The detail behind the Forecast's "Today against
// your plan" tile (TodayTile.tsx), which works out `data` and `status`.
// Read-only. Amounts are in the dollars of each day (not adjusted for
// inflation), because that is how net worth is recorded.

type Row = PlanVsActualData['rows'][number];

const SR_ONLY: React.CSSProperties = { position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0 };

export const trackTone = (s: TrackStatus) => (s.kind !== 'tracking' ? 'var(--muted)'
  : s.position === 'behind' ? 'var(--amber)' : s.position === 'ahead' ? 'var(--green)' : 'var(--text)');

export default function PlanVsActual({ data, status, money, privacy }: {
  data: PlanVsActualData | null;
  status: TrackStatus;
  money: (n: number) => string;   // the page's formatter (masks in privacy mode)
  privacy: boolean;
}) {
  // One tick per month at most (time-scale ticks can land twice in one month).
  const ticks = useMemo(() => (data?.rows.length ? monthTicks(data.rows[0].t, data.rows[data.rows.length - 1].t, 5) : []), [data]);
  // The y-axis fits the data (actual, plan and its range) with a little room,
  // rather than starting at $0, where the two lines sat flat near the top.
  const yScale = useMemo(() => {
    if (!data?.rows.length) return null;
    let lo = Infinity, hi = -Infinity;
    for (const r of data.rows) {
      for (const v of [r.lo, r.lo + r.band, r.med, r.actual]) {
        if (typeof v === 'number' && Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
      }
    }
    return Number.isFinite(lo) ? axisScale(lo, hi) : null;
  }, [data]);

  const text = (t: React.ReactNode) => <p className="fc-text" style={{ marginTop: 0 }}>{t}</p>;
  if (status.kind === 'none') {
    return text('Pin the forecast to save it as your plan (here, or with 📌 Baseline above the chart). Your recorded net worth is then tracked against it.');
  }
  if (status.kind === 'untracked' || !data) {
    return text('Your pinned forecast was saved before plan tracking existed. Pin it again to start tracking your actual net worth against it.');
  }
  const pinned = fmtDate(new Date(data.pinnedAt));
  if (status.kind === 'waiting') {
    return text(`Plan pinned ${pinned}. No net worth has been recorded since then yet — check back after the next daily update.`);
  }
  const asOf = fmtDate(new Date(status.asOf));
  const dateTick = (t: number) => new Date(t).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });

  return (<>
    <p className="fc-track-head" style={{ color: trackTone(status) }}>
      <span aria-hidden="true" className="fc-track-glyph">{status.glyph}</span>{status.headline}
    </p>
    <p className="fc-text" style={{ marginTop: 2 }}>
      {status.pct && `${status.pct} · `}{status.range} the likely range · as of {asOf}
    </p>
    <p className="fc-text">
      Recorded net worth against the plan you pinned on {pinned}. The plan line is that forecast’s median, read between its yearly points; the shaded band is its 10th–90th percentile range. Accounts or properties the forecast leaves out are taken out of the recorded figure too.
    </p>

    <p style={SR_ONLY}>{status.summary}</p>
    <div aria-hidden="true" style={{ height: 190, marginTop: 12, filter: privacy ? 'blur(5px)' : 'none' }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data.rows} margin={{ top: 4, right: 8, left: privacy ? -40 : -4, bottom: 0 }}>
          <defs>
            <linearGradient id="gPlanBand" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.22} />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.08} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={dateTick} ticks={ticks.length ? ticks : undefined}
            tick={{ fill: 'var(--muted)', fontSize: 12 }} tickLine={false} axisLine={false} minTickGap={24} />
          <YAxis tick={{ fill: 'var(--muted)', fontSize: 12 }} tickLine={false} axisLine={false} width={privacy ? 20 : 56}
            domain={yScale ? yScale.domain : ['auto', 'auto']} ticks={yScale?.ticks} allowDataOverflow={!!yScale}
            tickFormatter={(v: number) => (privacy ? '' : fmtAxisMoney(v, yScale?.step))} />
          <Tooltip content={(p: { active?: boolean; payload?: { payload?: Row }[] }) => {
            const r = p.active ? p.payload?.[0]?.payload : undefined;
            if (!r) return null;
            return (
              <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12, padding: '8px 12px', color: 'var(--text)' }}>
                <div style={{ color: 'var(--muted)', marginBottom: 4 }}>{fmtDate(new Date(r.t))}</div>
                {r.actual != null && <div>Actual: {money(r.actual)}</div>}
                <div>Plan median: {money(r.med)}</div>
                <div style={{ color: 'var(--muted)' }}>Likely range: {money(r.lo)} – {money(r.lo + r.band)}</div>
              </div>
            );
          }} />
          <Area dataKey="lo" stackId="pl" stroke="none" fill="transparent" name=" " isAnimationActive={false} />
          <Area dataKey="band" stackId="pl" stroke="none" fill="url(#gPlanBand)" name="Plan’s likely range" isAnimationActive={false} />
          <Line dataKey="med" name="Plan median" stroke="var(--muted)" strokeWidth={1.6} strokeDasharray="5 4" dot={false} isAnimationActive={false} />
          <Line dataKey="actual" name="Actual net worth" stroke="var(--accent)" strokeWidth={2.4} dot={false} connectNulls isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
    <p className="fc-legend" aria-hidden="true">
      <span><span className="fc-legend-line" />Actual</span>
      <span><span className="fc-legend-line dashed" />Plan median</span>
      <span><span className="fc-swatch" style={{ background: 'color-mix(in srgb, var(--accent) 18%, transparent)' }} />Plan’s likely range</span>
    </p>
    <p className="fc-foot" style={{ marginTop: 8 }}>Dollars as recorded, not adjusted for inflation. Re-pin after a big change to your plan to start a fresh comparison.</p>
  </>);
}
