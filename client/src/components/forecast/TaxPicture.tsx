import { useEffect, useMemo, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { restateFlow, type SimResult, type SimTaxYear } from '../../lib/forecastSim.ts';
import { CONVERSION_RATES, taxYearDetail, type TaxPlan } from '../../lib/taxPlan.ts';
import { FIRST_TABLE_YEAR, LAST_TABLE_YEAR, IRMAA_TABLES, IRMAA_LOOKBACK_YEARS, type FilingStatus } from '../../lib/taxTables.ts';
import { fmtMoneyCompact } from '../../lib/format.ts';
import { usePersistentState } from '../../hooks/usePersistentState.ts';
import { FitTip } from './FitTip.tsx';
import { CardHead, CardMeta, InlineTip, StatTile, Tiles } from './ui.tsx';

// The Forecast's bracket tax views: the controls that switch the bracket model on
// (rendered inside the page's Advanced → Taxes section) and the "Tax picture" card
// with a year's bracket fill, headline tax tiles, Roth-conversion settings, the
// suggested conversions by year and the plan with vs without conversions.
// Read-only estimates: nothing here moves money. Estimates for planning, not tax advice.

const pct = (r: number) => `${(Math.round((Number.isFinite(r) ? r : 0) * 1000) / 10).toFixed(1)}%`;
const ratePct = (r: number) => `${Math.round(r * 100)}%`;

const srOnly: React.CSSProperties = {
  position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden',
  clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0,
};
const rowStyle: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '5px 0', fontSize: 13, color: 'var(--muted)' };

// "ⓘ" tip, shown on hover AND keyboard focus (it is a real button). The same
// component as the plan-answers card's, so every tip on the page behaves alike and
// stays inside a phone's screen.
export function Tip(props: { text: string; label?: string; width?: number }) {
  return <FitTip {...props} />;
}

// Whole-number age field that commits on blur / Enter (so typing "7" on the way
// to "72" doesn't reshuffle the plan), clamped to a sane range.
function AgeField({ id, value, placeholder, onCommit, label }: {
  id: string; value: number | null; placeholder?: string; onCommit: (n: number | null) => void; label: string;
}) {
  const [text, setText] = useState(value == null ? '' : String(value));
  useEffect(() => { setText(value == null ? '' : String(value)); }, [value]);
  const commit = () => {
    const t = text.trim();
    if (t === '') { onCommit(null); return; }
    const n = Math.round(Number(t));
    if (Number.isFinite(n)) onCommit(Math.min(110, Math.max(18, n)));
    else setText(value == null ? '' : String(value));
  };
  return (
    <input id={id} aria-label={label} inputMode="numeric" value={text} placeholder={placeholder}
      onChange={e => setText(e.target.value)} onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      style={{ width: 56, textAlign: 'right' }} />
  );
}

// --- Controls inside Advanced → Taxes ------------------------------------------

export function TaxControls({ plan, onChange, twoEarners }: {
  plan: TaxPlan; onChange: (p: TaxPlan) => void; twoEarners: boolean;
}) {
  const [stateText, setStateText] = useState(String(Math.round(plan.stateRate * 1000) / 10));
  useEffect(() => { setStateText(String(Math.round(plan.stateRate * 1000) / 10)); }, [plan.stateRate]);
  const commitState = () => {
    const n = Number(stateText);
    if (Number.isFinite(n)) onChange({ ...plan, stateRate: Math.min(0.2, Math.max(0, n / 100)) });
    else setStateText(String(Math.round(plan.stateRate * 1000) / 10));
  };
  const brackets = plan.mode === 'brackets';
  return (
    <div>
      {/* The label names the checkbox (htmlFor), as the state-rate row does; the
          tip's button inside it is interactive content, so clicking it doesn't
          toggle the box. */}
      <div style={rowStyle}>
        <label htmlFor="fc-tax-brackets" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
          Work out tax from the IRS brackets
          <Tip label="About the bracket tax model" width={290} text={`Instead of one flat rate, each simulated year’s federal income tax is worked out from the IRS brackets (tax years ${FIRST_TABLE_YEAR}–${LAST_TABLE_YEAR}; later years grow with inflation): wages after pre-tax savings, the taxable part of Social Security, pre-tax withdrawals and required distributions, Roth conversions, and gains on taxable-account withdrawals (half of each withdrawn dollar is assumed to be gain). Payroll tax (HSA payroll contributions are exempt), a flat state rate and Medicare income surcharges (IRMAA) are included. Withdrawals are grossed up so spending is still covered after tax.`} />
        </label>
        <input id="fc-tax-brackets" type="checkbox" checked={brackets} style={{ width: 'auto' }}
          onChange={e => onChange({ ...plan, mode: e.target.checked ? 'brackets' : 'flat' })} />
      </div>
      {brackets && (<>
        <div style={rowStyle}>
          <label htmlFor="fc-tax-filing">Filing as</label>
          <select id="fc-tax-filing" value={plan.filing}
            onChange={e => onChange({ ...plan, filing: e.target.value as TaxPlan['filing'] })}>
            <option value="auto">Automatic ({twoEarners ? 'married, jointly' : 'single'})</option>
            <option value="single">{twoEarners ? 'Single (one combined return)' : 'Single'}</option>
            <option value="joint">Married, filing jointly</option>
          </select>
        </div>
        {/* Two earners on 'Single' are taxed as ONE return with both incomes — more
            tax than two separate single returns. Say so rather than hide the choice. */}
        {twoEarners && plan.filing === 'single' && (
          <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 4px', lineHeight: 1.45 }}>
            Both earners’ income goes on one single return here, which overstates tax for an unmarried couple (each would file their own).
          </p>
        )}
        <div style={rowStyle}>
          <label htmlFor="fc-tax-state" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            State income tax %
            <Tip label="About the state rate" text="One flat rate applied to federal taxable income, leaving out Social Security (most states don’t tax it). Use 0 if your state has no income tax. State brackets are not modelled." />
          </label>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <input id="fc-tax-state" inputMode="decimal" value={stateText} style={{ width: 64, textAlign: 'right' }}
              onChange={e => setStateText(e.target.value)} onBlur={commitState}
              onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
            <span aria-hidden="true">%</span>
          </span>
        </div>
      </>)}
    </div>
  );
}

// --- The Tax picture card -----------------------------------------------------

export default function TaxPicture({
  plan, onChange, sim, simNoConv, infl, realDollars, currentAge0, endAge, retireAge, filing, twoEarners = false, money, privacy,
}: {
  plan: TaxPlan; onChange: (p: TaxPlan) => void;
  sim: SimResult; simNoConv: SimResult | null;
  infl: number; realDollars: boolean; currentAge0: number; endAge: number;
  retireAge: number; // earner 0's retirement age in the SHOWN forecast (follows the Retire lever)
  filing: FilingStatus;
  twoEarners?: boolean;
  money: (n: number) => string; // the page's money formatter (masks in privacy mode)
  privacy: boolean;
}) {
  const [open, setOpen] = usePersistentState('mon.fcTaxOpen', true);
  const [pickedYear, setPickedYear] = useState<number | null>(null);
  const path = sim.tax?.medianPath ?? [];
  const brackets = plan.mode === 'brackets' && path.length > 0;
  const unit = realDollars ? "today's dollars" : 'future dollars';
  // Flows (tax, income) sit at the START of their year: (age − currentAge0) years
  // out, at the record's price level (restateFlow). The sim hands back records
  // in plan dollars — a replayed historical path is restated to the plan's
  // inflation there — so every nominal amount of one year, the tables' included,
  // shares the year's deflator and the parts still add up in today's dollars.
  const defl = (v: number, y: SimTaxYear) => restateFlow(v, y.priceLevel, Math.max(0, y.age - currentAge0), infl, realDollars);
  const convStart = plan.convStartAge ?? retireAge;
  const convEnd = Math.max(convStart, plan.convEndAge);

  // Default year: the first conversion year when converting, else the first
  // retirement year, else this year.
  const defaultYear = useMemo(() => {
    if (!path.length) return null;
    const conv = plan.convOn ? path.find(y => y.age >= convStart && y.age <= convEnd) : undefined;
    return (conv ?? path.find(y => y.age === retireAge) ?? path[0]).year;
  }, [path, plan.convOn, convStart, convEnd, retireAge]);
  const year = pickedYear != null && path.some(y => y.year === pickedYear) ? pickedYear : defaultYear;
  const rec = path.find(y => y.year === year) ?? null;
  const detail = useMemo(() => (rec ? taxYearDetail(rec, infl) : null), [rec, infl]);

  const header = <CardHead title="Tax picture" note={brackets ? unit : undefined} open={open} onToggle={() => setOpen(o => !o)} />;

  if (!open) return <div className="fc-card fc-closed">{header}</div>;

  if (plan.mode !== 'brackets') {
    return (
      <div className="fc-card">
        {header}
        <CardMeta tipLabel="About the tax picture"
          tip="Work out tax from the IRS brackets instead to see each year’s tax, how much room is left in your bracket and before Medicare’s income surcharge, and what converting pre-tax savings to Roth would do."
          controls={<button type="button" className="btn-ghost btn-sm" onClick={() => onChange({ ...plan, mode: 'brackets' })}>Use tax brackets</button>}>
          The forecast currently uses your flat tax rates.
        </CardMeta>
      </div>
    );
  }

  if (!rec || !detail) return <div className="fc-card">{header}</div>;

  const r = detail.result;
  // Bracket bar: brackets up to one past the one income ends in (at least through
  // 24%), each sized by its width. The open-ended top bracket is drawn as wide as
  // what it holds, or the bracket below it.
  const shownCount = Math.min(detail.fill.length, Math.max(r.bracketIndex + 2, 4));
  const shown = detail.fill.slice(0, shownCount).map((s, i, arr) => {
    const size = s.to != null ? s.to - s.from : Math.max(s.filled, i > 0 ? (arr[i - 1].to ?? 0) - arr[i - 1].from : 1);
    return { ...s, size: Math.max(1, size) };
  });
  // Bar geometry: each bracket's share of the drawn width, where it starts, and how
  // much of the bar is filled (brackets fill from the bottom, so the used part is
  // one run from the left).
  const barTotal = shown.reduce((t, s) => t + s.size, 0) || 1;
  // Rate labels sit under their bracket; a narrow bracket's label moves above the
  // bar, alternating with a narrow neighbour's, so no two labels collide.
  const segs = shown.reduce<{ rate: number; start: number; share: number; pos: 'above' | 'below' }[]>((acc, s) => {
    const prev = acc[acc.length - 1];
    const start = prev ? prev.start + prev.share : 0;
    const share = s.size / barTotal;
    acc.push({ rate: s.rate, start, share, pos: share >= 0.1 ? 'below' : prev?.pos === 'above' ? 'below' : 'above' });
    return acc;
  }, []);
  const anyAbove = segs.some(s => s.pos === 'above');
  const fillShare = Math.min(1, shown.reduce((t, s) => t + Math.min(s.filled, s.size), 0) / barTotal);
  const usedBrackets = shown.filter(s => s.filled > 0);
  // What makes up "received" (r.grossIncome): every non-zero part, so they add up.
  const incomeParts = [
    rec.wages > 0 && `wages ${money(defl(rec.wages, rec))}`,
    rec.socialSecurity > 0 && `Social Security ${money(defl(rec.socialSecurity, rec))} (${money(defl(r.taxableSocialSecurity, rec))} taxable)`,
    rec.rmd + rec.pretaxDraw > 0 && `pre-tax withdrawals ${money(defl(rec.rmd + rec.pretaxDraw, rec))}${rec.rmd > 0 ? ` (required ${money(defl(rec.rmd, rec))})` : ''}`,
    rec.conversion > 0 && `converted to Roth ${money(defl(rec.conversion, rec))}`,
    rec.gains > 0 && `gains on taxable-account withdrawals ${money(defl(rec.gains, rec))}`,
  ].filter((x): x is string => typeof x === 'string');
  const barLabel = shown.map(s => `${ratePct(s.rate)} bracket: ${money(defl(s.filled, rec))} used${s.open != null ? `, ${money(defl(s.open, rec))} open` : ''}`).join('; ');
  const gainsTotal = r.qualifiedTaxable;
  // Where this year's income lands, in one sentence.
  const untaxed = money(defl(Math.min(r.deduction, r.agi), rec));
  const dedText = money(defl(r.deduction, rec));
  const lands = r.taxableIncome <= 0
    ? <>All of {rec.year}’s income falls inside the {dedText} deduction{rec.socialSecurity > 0 ? ' (counting only the taxable part of Social Security)' : ''}, so none of it is taxed.</>
    : r.ordinaryTaxable <= 0
      ? <>The first {untaxed} is untaxed (deduction of {dedText}); only gains sit above it.</>
      : <>The first {untaxed} is untaxed (deduction of {dedText}). Income then reaches the {detail.roomAtRate == null ? 'top ' : ''}<strong style={{ color: 'var(--text)' }}>{ratePct(r.bracketRate)}</strong> bracket{detail.roomAtRate != null && <>, with <strong style={{ color: 'var(--text)' }}>{money(defl(detail.roomAtRate, rec))}</strong> of room left in it</>}.</>;

  const irmaaText = (() => {
    if (!rec.irmaaWatch) return { value: 'Not yet', sub: 'counts from age 63' };
    if (detail.irmaa.roomToNext == null) return { value: 'Top tier', sub: `${detail.premiumYear} premiums` };
    return {
      value: money(defl(detail.irmaa.roomToNext, rec)),
      // The surcharge is priced in the PREMIUM year, two years after this income
      // year, so today's dollars take two more years of (plan) inflation off it.
      sub: detail.irmaa.tier === 0 ? `${detail.premiumYear} premiums · no surcharge yet` : `${detail.premiumYear} premiums · now +${money(defl(detail.irmaa.annualPerPerson, rec) / (realDollars ? Math.pow(1 + infl, IRMAA_LOOKBACK_YEARS) : 1))}/yr each`,
    };
  })();

  const tiles: { label: string; value: string; sub?: string; tip: string }[] = [
    {
      label: 'Federal income tax', value: money(defl(r.total, rec)),
      sub: r.niit > 0 ? `incl. ${money(defl(r.niit, rec))} investment surtax` : filing === 'joint' ? 'married, jointly' : twoEarners ? 'single, one combined return' : 'single',
      tip: 'Federal income tax for this year on the median path, including the 3.8% net investment income tax when it applies. Payroll tax, state tax and Medicare surcharges are charged in the forecast but not counted here.',
    },
    {
      label: 'Share of income', value: pct(r.effectiveRate),
      sub: `of ${money(defl(r.grossIncome, rec))} received`,
      tip: 'Effective rate: federal income tax divided by everything received this year (wages, withdrawals, conversions, gains and all Social Security).',
    },
    {
      label: detail.roomAtRate == null ? 'Top bracket' : `Room left at ${ratePct(r.bracketRate)}`,
      value: detail.roomAtRate == null ? ratePct(r.bracketRate) : money(defl(detail.roomAtRate, rec)),
      sub: `next dollar taxed ~${pct(detail.marginal)}`,
      tip: `Extra income (a withdrawal or Roth conversion) that still fits before taxable income passes the top of the ${ratePct(r.bracketRate)} bracket. It counts any unused deduction and the Social Security that extra income would make taxable. “Next dollar” is the marginal rate including side effects — more Social Security becoming taxable, gains leaving the 0% zone — so it can be higher than the bracket rate.`,
    },
    {
      label: 'Before Medicare surcharge', value: irmaaText.value, sub: irmaaText.sub,
      tip: 'Medicare’s income-related surcharge (IRMAA) on Part B and D premiums is set from your income two years earlier, so income from age 63 counts. This is how much more income (MAGI) fits before the next tier.',
    },
  ];

  const convRows = path
    .filter(y => y.age >= convStart && y.age <= convEnd)
    .map(y => ({ label: String(y.age), year: y.year, amount: defl(y.conversion, y) }));
  const convTotal = convRows.reduce((t, x) => t + x.amount, 0);

  // With vs without conversions. Ending balances are end-of-year, one year further
  // out than flows (same convention as the page's headline figures).
  const endNW = (s: SimResult) => {
    const b = s.bands[s.bands.length - 1];
    if (!b) return 0;
    return realDollars ? b.p50 / Math.pow(1 + infl, Math.max(0, b.age - currentAge0 + 1)) : b.p50;
  };
  const lifeTax = (s: SimResult) => (s.tax ? (realDollars ? s.tax.lifetimeFedTaxReal : s.tax.lifetimeFedTax) : 0);

  const irmaaYears = IRMAA_TABLES.map(t => t.year);
  const tablesText = `Uses IRS tables for tax years ${FIRST_TABLE_YEAR}–${LAST_TABLE_YEAR} and Medicare surcharge tables for ${irmaaYears[0]}–${irmaaYears[irmaaYears.length - 1]}; later years grow with your inflation setting (the investment-income surtax and Social Security thresholds stay fixed, as the law sets them). ${rec.year}’s figures use the ${Math.min(Math.max(rec.year, FIRST_TABLE_YEAR), LAST_TABLE_YEAR)} tables${rec.year > LAST_TABLE_YEAR ? ', grown with inflation' : ''}.`;

  return (
    <div className="fc-card">
      {header}
      <CardMeta controls={
        <label className="fc-field">
          Year
          <select value={rec.year} onChange={e => setPickedYear(Number(e.target.value))}>
            {path.map(y => <option key={y.year} value={y.year}>{y.year} · age {y.age}</option>)}
          </select>
        </label>
      }>
        {sim.tax?.medianStartYear != null
          ? `The year shown replays history from ${sim.tax.medianStartYear}, the starting year that ends nearest the median.`
          : 'The year shown is from the simulated future that ends nearest the median.'}
      </CardMeta>

      {/* Headline tiles */}
      <Tiles cols={4}>
        {tiles.map(t => <StatTile key={t.label} label={t.label} value={t.value} sub={t.sub} tip={t.tip} />)}
      </Tiles>

      {/* Bracket fill: one bar, used part solid, bracket edges as ticks. */}
      <h3 className="fc-subhead">
        How {rec.year}’s income fills the brackets
        <Tip label="About the bracket bar" text="Ordinary taxable income (after the deduction) fills the brackets from the bottom. The solid part is used, the pale part is still open. Long-term gains and qualified dividends sit on top of it and are taxed at 0%, 15% or 20% depending on where they land." />
      </h3>
      <p className="fc-text" style={{ marginTop: 0 }}>{lands}</p>
      <div role="img" aria-label={`Bracket fill for ${rec.year}: ${barLabel}`} className="fc-bar-wrap" style={{ filter: privacy ? 'blur(5px)' : 'none', paddingTop: anyAbove ? 22 : 6 }}>
        <div className="fc-bar" aria-hidden="true">
          <div className="fc-bar-fill" style={{ width: `${fillShare * 100}%` }} />
          {segs.slice(1).map(s => <div key={s.rate} className="fc-bar-tick" style={{ left: `${s.start * 100}%` }} />)}
        </div>
        {/* Rates centred in their bracket (kept inside the bar's ends). */}
        {segs.map(s => (
          <span key={s.rate} aria-hidden="true" className={'fc-bar-rate ' + s.pos}
            style={{ left: `clamp(16px, ${(s.start + s.share / 2) * 100}%, calc(100% - 16px))`, color: shown.find(x => x.rate === s.rate)!.filled > 0 ? 'var(--text)' : undefined }}>
            {ratePct(s.rate)}
          </span>
        ))}
      </div>
      {usedBrackets.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, margin: '4px 0 0', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '4px 16px', fontSize: 13, color: 'var(--muted)' }}>
          {usedBrackets.map(s => (
            <li key={s.rate} style={{ fontVariantNumeric: 'tabular-nums' }}>
              <strong style={{ color: 'var(--text)' }}>{ratePct(s.rate)}</strong>{' '}
              {money(defl(s.filled, rec))} used
              {s.open != null && (s.open > 0 ? ` · ${money(defl(s.open, rec))} open` : ' · full')}
            </li>
          ))}
        </ul>
      )}
      {gainsTotal > 0 && (
        <p className="fc-text">
          Plus {money(defl(gainsTotal, rec))} of gains on top: {money(defl(r.gainsAt0, rec))} at 0%
          {r.gainsAt15 > 0 && <>, {money(defl(r.gainsAt15, rec))} at 15%</>}
          {r.gainsAt20 > 0 && <>, {money(defl(r.gainsAt20, rec))} at 20%</>}.
        </p>
      )}
      <p className="fc-text">
        Income this year: {incomeParts.length ? incomeParts.join(' · ') : 'none'}
      </p>

      {/* Roth conversions */}
      <h3 className="fc-subhead">
        Roth conversions
        <Tip label="About Roth conversions" width={300} text="Moving money from pre-tax accounts (traditional 401(k)/IRA) to Roth. The amount moved is taxed as income that year; later Roth withdrawals are tax-free and have no required distributions. Here each year in the window moves enough to fill the chosen bracket, with the tax paid from the taxable account — the amount shrinks when that account can’t cover it." />
      </h3>
      {/* Settings rows stay narrow so a label sits near its control on a wide card. */}
      <div style={{ maxWidth: 520 }}>
        <label style={{ ...rowStyle, cursor: 'pointer' }}>
          <span>Model converting pre-tax savings to Roth</span>
          <input type="checkbox" checked={plan.convOn} style={{ width: 'auto' }} onChange={e => onChange({ ...plan, convOn: e.target.checked })} />
        </label>
        {plan.convOn && (<>
          <div style={{ ...rowStyle, flexWrap: 'wrap' }}>
            <span>Ages</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <AgeField id="fc-conv-start" label="First conversion age" value={plan.convStartAge} placeholder={String(retireAge)}
                onCommit={n => onChange({ ...plan, convStartAge: n })} />
              <span aria-hidden="true">to</span>
              <AgeField id="fc-conv-end" label="Last conversion age" value={plan.convEndAge}
                onCommit={n => onChange({ ...plan, convEndAge: n ?? 72 })} />
            </span>
          </div>
          <div style={rowStyle}>
            <label htmlFor="fc-conv-rate">Fill up to the top of the</label>
            <select id="fc-conv-rate" value={plan.convRate}
              onChange={e => onChange({ ...plan, convRate: Number(e.target.value) })}>
              {CONVERSION_RATES.map(x => <option key={x} value={x}>{ratePct(x)} bracket</option>)}
            </select>
          </div>
          <label style={{ ...rowStyle, cursor: 'pointer' }}>
            <span>Stop before the next Medicare surcharge tier</span>
            <input type="checkbox" checked={plan.convIrmaaCap} style={{ width: 'auto' }} onChange={e => onChange({ ...plan, convIrmaaCap: e.target.checked })} />
          </label>
        </>)}
      </div>
      {plan.convOn && (<>
        {convRows.length > 0 ? (<>
          <p className="fc-text" style={{ marginTop: 12 }}>
            Converted by age on the median path: <strong style={{ color: 'var(--text)' }}>{money(convTotal)}</strong> in all.
          </p>
          <div aria-hidden="true" style={{ filter: privacy ? 'blur(5px)' : 'none', marginTop: 8 }}>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={convRows} margin={{ top: 4, right: 4, left: privacy ? -40 : -8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="label" tick={{ fill: 'var(--muted)', fontSize: 12 }} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={4} />
                <YAxis tick={{ fill: 'var(--muted)', fontSize: 12 }} tickLine={false} axisLine={false} width={privacy ? 20 : 52}
                  tickFormatter={(v: number) => (privacy ? '' : fmtMoneyCompact(v))} />
                <Tooltip
                  cursor={{ fill: 'var(--muted)', fillOpacity: 0.12 }}
                  contentStyle={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12, padding: '8px 12px' }}
                  labelStyle={{ color: 'var(--text)' }}
                  labelFormatter={(l: string) => `Age ${l}`}
                  formatter={(value: number) => [money(value), 'Converted']}
                />
                <Bar dataKey="amount" fill="var(--accent)" isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <table style={srOnly}>
            <caption>Roth conversions by age, {unit}</caption>
            <thead><tr><th scope="col">Age</th><th scope="col">Year</th><th scope="col">Converted</th></tr></thead>
            <tbody>{convRows.map(x => <tr key={x.year}><th scope="row">{x.label}</th><td>{x.year}</td><td>{money(x.amount)}</td></tr>)}</tbody>
          </table>
        </>) : (
          <p className="fc-text">The conversion ages fall outside the plan ({currentAge0}–{endAge}).</p>
        )}

        {simNoConv && (
          <div style={{ overflowX: 'auto', marginTop: 14 }}>
            <table className="fc-table" style={{ maxWidth: 640 }}>
              <caption style={{ ...srOnly }}>The plan with and without Roth conversions</caption>
              <thead>
                <tr>
                  {['', 'With conversions', 'Without'].map((h, i) => (
                    <th key={h || 'k'} scope="col" className={i ? undefined : 'fc-left'} style={{ position: 'static', background: 'none' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[
                  { k: `Chance your money lasts to ${endAge}`, a: `${sim.successPct}%`, b: `${simNoConv.successPct}%` },
                  { k: `Median net worth at ${endAge}`, a: money(endNW(sim)), b: money(endNW(simNoConv)) },
                  { k: 'Lifetime federal income tax (median)', a: money(lifeTax(sim)), b: money(lifeTax(simNoConv)) },
                ].map(row => (
                  <tr key={row.k}>
                    <th scope="row" className="fc-left" style={{ fontWeight: 400, color: 'var(--muted)', whiteSpace: 'normal' }}>{row.k}</th>
                    <td>{row.a}</td>
                    <td>{row.b}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="fc-text" style={{ fontSize: 12 }}>
              Net worth counts pre-tax balances at full value, though tax is still owed on them when withdrawn — so converting can look
              smaller here even when it lowers the tax paid over your lifetime.
            </p>
          </div>
        )}
      </>)}

      <p className="fc-foot">
        Estimates for planning, not tax advice.
        <InlineTip label="About the tax tables" text={tablesText} />
        {sim.tax?.medianStartYear != null && ' When history is replayed, the tables still grow with your inflation setting, not the replayed inflation, so high-inflation years push income into higher brackets.'}
        {' '}Not modelled: state brackets, the alternative minimum tax, credits,
        itemised deductions, health-insurance subsidies and estate tax.
      </p>
    </div>
  );
}
