import { useMemo, useState } from 'react';
import { ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { planVsActual, canTrack, monthTicks, type PinnedBaseline, type PlanVsActual as PlanVsActualData } from '../../lib/planTrack.ts';
import { fmtDate } from '../../lib/format.ts';
import { axisScale, fmtAxisMoney } from '../../lib/axis.ts';
import { CardHead, CardMeta, StatTile } from './ui.tsx';

// "Are you on track?" (plan versus actual): recorded net worth since the forecast
// was pinned (📌), drawn over the median and likely range that pin projected. Its
// own card on the Forecast page. Read-only. Amounts are in
// the dollars of each day (not adjusted for inflation), because that is how net
// worth is recorded.

type Row = PlanVsActualData['rows'][number];

const SR_ONLY: React.CSSProperties = { position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0 };

export default function PlanVsActual({ baseline, history, money, privacy }: {
  baseline: PinnedBaseline | null;
  history: { date: string; net_worth: number }[] | null;
  money: (n: number) => string;   // the page's formatter (masks in privacy mode)
  privacy: boolean;
}) {
  const [open, setOpen] = useState(true);
  const data = useMemo(() => planVsActual(baseline, history), [baseline, history]);
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

  const header = <CardHead title="Are you on track?" open={open} onToggle={() => setOpen(o => !o)} />;
  const shell = (body: React.ReactNode) => <div className={open ? "fc-card" : "fc-card fc-closed"}>{header}{open && body}</div>;

  if (!baseline) {
    return shell(<CardMeta>Pin the forecast with 📌 Baseline (above the chart) to save it as your plan. Your recorded net worth is then tracked against it here.</CardMeta>);
  }
  if (!canTrack(baseline) || !data) {
    return shell(<CardMeta>Your pinned forecast was saved before plan tracking existed. Clear the pin and pin again to start tracking your actual net worth against it.</CardMeta>);
  }
  const pinned = fmtDate(new Date(data.pinnedAt));
  const L = data.latest;
  if (!L) {
    return shell(<CardMeta>Plan pinned {pinned}. No net worth has been recorded since then yet — check back after the next daily update.</CardMeta>);
  }

  const pct = Math.abs(L.diffPct * 100);
  const pctTxt = pct >= 10 ? Math.round(pct).toString() : pct.toFixed(1);
  const headline = L.position === 'onPlan' ? 'Right on plan'
    : L.position === 'ahead' ? `Ahead of plan by ${money(Math.abs(L.diff))}` : `Behind plan by ${money(Math.abs(L.diff))}`;
  const glyph = L.position === 'onPlan' ? '●' : L.position === 'ahead' ? '▲' : '▼';
  const tone = L.position === 'behind' ? 'var(--amber)' : L.position === 'ahead' ? 'var(--green)' : 'var(--text)';
  const asOf = fmtDate(new Date(L.t));
  const summary = `${headline}${L.position === 'onPlan' ? '' : ` (${L.diff >= 0 ? '+' : '−'}${pctTxt}%)`} as of ${asOf}: net worth ${money(L.actual)} against a plan median of ${money(L.med)}. `
    + `${L.inRange ? 'That is inside' : 'That is outside'} the plan’s likely range of ${money(L.lo)} to ${money(L.hi)}.`;
  const dateTick = (t: number) => new Date(t).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });

  return shell(<>
    <CardMeta tipLabel="About plan versus actual"
      tip={`Compares your recorded net worth with the forecast you pinned on ${pinned}. The plan line is that forecast’s median, read between its yearly points; the shaded band is its 10th–90th percentile range. Accounts or properties the forecast leaves out are taken out of the recorded figure too. Re-pin after a big change to your plan to start a fresh comparison.`}>
      Recorded net worth against the plan you pinned on {pinned}.
    </CardMeta>

    <div style={{ marginTop: 16, maxWidth: 420 }}>
      <StatTile label="Today against your pinned plan" color={tone}
        value={<><span aria-hidden="true" style={{ fontSize: 15, marginRight: 8, verticalAlign: 2 }}>{glyph}</span>{headline}</>}
        sub={<>{L.position !== 'onPlan' && `${L.diff >= 0 ? '+' : '−'}${pctTxt}% · `}{L.inRange ? 'inside' : 'outside'} the likely range · as of {asOf}</>} />
    </div>

    <p style={SR_ONLY}>{summary}</p>
    <div aria-hidden="true" style={{ height: 200, marginTop: 16, filter: privacy ? 'blur(5px)' : 'none' }}>
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
      <span><span style={{ display: 'inline-block', width: 16, borderTop: '2.5px solid var(--accent)', verticalAlign: 'middle', marginRight: 6 }} />Actual</span>
      <span><span style={{ display: 'inline-block', width: 16, borderTop: '2px dashed var(--muted)', verticalAlign: 'middle', marginRight: 6 }} />Plan median</span>
      <span><span className="fc-swatch" style={{ background: 'color-mix(in srgb, var(--accent) 18%, transparent)' }} />Plan’s likely range</span>
    </p>
    <p className="fc-foot">Dollars as recorded, not adjusted for inflation.</p>
  </>);
}
