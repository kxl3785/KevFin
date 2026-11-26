import type { ReactNode } from 'react';
import type { SimBand } from '../../lib/forecastSim.ts';
import { fmtMoneyShort, tableRowIndices } from '../../lib/forecastDisplay.ts';
import { usePersistentState } from '../../hooks/usePersistentState.ts';
import { CardHead, CardMeta } from './ui.tsx';

// "Year by year": the forecast's raw numbers. A row every 5 years by default
// (a saved choice wins), always with the retirement year; figures compact
// ($228k, $1.08M) unless "Show exact dollars" is on. Red marks only a year whose
// spending is more than its income. Display only: values arrive from the sim, and
// `bal` / `flow` put them in the chart's dollar basis (balances end-of-year,
// flows start-of-year).

export default function YearTable({ bands, bal, flow, retireAge, money, privacy, spendLabel, unitLabel, footnote }: {
  bands: SimBand[];
  bal: (v: number, b: SimBand) => number;
  flow: (v: number, b: SimBand) => number;
  retireAge: number;
  money: (n: number) => string;   // the page's exact formatter (masks in privacy mode)
  privacy: boolean;
  spendLabel: string;
  unitLabel: string;
  footnote: ReactNode;
}) {
  const [open, setOpen] = usePersistentState('mon.fcShowTable', false);
  const [interval, setStep] = usePersistentState('mon.fcTableInterval', 5);
  const [exact, setExact] = usePersistentState('mon.fcTableExact', false);
  const short = (n: number) => (privacy ? '•••' : fmtMoneyShort(n));
  const fig = exact ? money : short;

  const rows = tableRowIndices(bands.map(b => b.age), interval, retireAge).map(i => bands[i]);
  const cols: { key: string; label: string; fmt: (b: SimBand) => string; red?: (b: SimBand) => boolean }[] = [
    { key: 'year', label: 'Year', fmt: b => String(b.year) },
    { key: 'age', label: 'Age', fmt: b => String(b.age) },
    { key: 'income', label: 'Income', fmt: b => fig(flow(b.income, b)) },
    { key: 'spending', label: spendLabel, fmt: b => fig(flow(b.spending, b)), red: b => b.spending > b.income },
    { key: 'invP50', label: 'Investable (median)', fmt: b => fig(bal(b.invP50, b)) },
    { key: 're', label: 'Real estate', fmt: b => fig(bal(b.re, b)) },
    { key: 'p50', label: 'Net worth (median)', fmt: b => fig(bal(b.p50, b)) },
    { key: 'range', label: 'Net worth 10th–90th pct', fmt: b => `${short(bal(b.p10, b))} – ${short(bal(b.p10 + b.band, b))}` },
  ];

  return (
    <div className="fc-card">
      <CardHead title="Year by year" note={unitLabel} open={open} onToggle={() => setOpen(o => !o)} />
      {open && (<>
        <CardMeta controls={<>
          <div className="seg" role="group" aria-label="Show a row every">
            {[1, 5, 10].map(n => (
              <button key={n} type="button" aria-pressed={interval === n} onClick={() => setStep(n)}
                className={'seg-btn' + (interval === n ? ' active' : '')}>{n === 1 ? 'Every year' : `Every ${n}y`}</button>
            ))}
          </div>
          <label className="fc-field" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={exact} onChange={e => setExact(e.target.checked)} style={{ width: 'auto' }} />
            Show exact dollars
          </label>
        </>}>
          The forecast’s raw numbers, one row per {interval === 1 ? 'year' : `${interval} years`} plus retirement ({retireAge}, highlighted). Red marks a year where spending is more than income.
        </CardMeta>
        {/* Scrolls within the card (both ways) with the header pinned. */}
        <div className="fc-table-wrap" tabIndex={0} role="region" aria-label={`Forecast by year, ${unitLabel}`}>
          <table className="fc-table">
            <thead>
              <tr>
                {cols.map((c, i) => <th key={c.key} scope="col" className={i === 0 ? 'fc-left' : undefined}>{c.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map(b => {
                const retire = b.age === retireAge;
                return (
                  <tr key={b.year} className={retire ? 'fc-row-retire' : undefined}>
                    {cols.map((c, ci) => {
                      const body = <>{c.fmt(b)}{c.key === 'age' && retire ? <span aria-hidden="true"> 🏖️</span> : ''}</>;
                      const over = !!c.red?.(b);
                      return ci === 0
                        ? <th key={c.key} scope="row" className="fc-left" style={{ fontWeight: retire ? 700 : 500 }}>{body}</th>
                        : <td key={c.key} title={c.key === 'age' && retire ? 'Retirement age' : over ? 'Spending is more than income this year' : undefined}
                            style={{ color: over ? 'var(--red)' : undefined, fontWeight: retire ? 600 : undefined, filter: privacy && ci >= 2 ? 'blur(5px)' : 'none' }}>{body}</td>;
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="fc-foot" style={{ marginTop: 10 }}>{footnote}</p>
      </>)}
    </div>
  );
}
