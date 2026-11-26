import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { runForecastSim, completeHistoricalStarts, type SimInput, type SimResult, type SimHistoricalStart } from '../../lib/forecastSim.ts';
import { HISTORY_FIRST_YEAR, HISTORY_LAST_YEAR, HISTORY_SOURCE_NOTE } from '../../lib/historicalReturns.ts';
import { summarizeBacktest, chunk, MIN_HISTORICAL_STARTS, STOCK_SHARES, type BacktestSettings } from '../../lib/backtest.ts';
import { useIsMobile } from '../../hooks/useIsMobile.ts';
import { Tip } from './TaxPicture.tsx';
import { CardHead, CardMeta, InlineTip, StatTile, Tiles } from './ui.tsx';

// "How would this plan have done?" — the Forecast's historical backtest. Replays
// the plan through every complete stretch of past US markets (1928 on): one path
// per starting year, using that year's and the following years' actual stock and
// bond returns and inflation. Read-only: nothing here moves money. Estimates for
// planning, not advice.
//
// When the whole forecast is set to replay history, the page's own simulation
// already holds the per-year results and they are shown straight away. Otherwise
// the backtest runs on demand, a few starting years per frame, so the page never
// freezes and nothing re-runs while the plan is being typed into.

const START_CHUNK = 6; // starting years per slice of work

type RunState =
  | { status: 'idle' }
  | { status: 'running'; input: SimInput; done: number; total: number }
  // endAge / span: what the run measured, so a stale result keeps its own labels.
  | { status: 'done'; input: SimInput; starts: SimHistoricalStart[]; endAge: number; span: string };

const spanOf = (years: number[]) => (years.length ? `${years[0]}–${years[years.length - 1]}` : '');

export default function Backtest({ input, sim, settings, onSettings, glidePath, endAge, money, privacy }: {
  input: SimInput | null;     // the shown forecast's input (with any what-if levers); null until data loads
  sim: SimResult;             // the shown forecast's result
  settings: BacktestSettings;
  onSettings: (s: BacktestSettings) => void;
  glidePath: boolean;
  endAge: number;
  money: (n: number) => string;
  privacy: boolean;
}) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(true);
  const [run, setRun] = useState<RunState>({ status: 'idle' });
  const [picked, setPicked] = useState<number | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const aboutId = useId();
  const cancelRef = useRef<() => void>(() => {});
  useEffect(() => () => cancelRef.current(), []);

  const historicalMode = settings.returnModel === 'historical';
  const years = input ? Math.max(1, input.A.endAge - input.currentAge0 + 1) : 0;
  const complete = useMemo(() => (years ? completeHistoricalStarts(years) : []), [years]);

  // Results: straight from the page's sim in historical mode, else the last on-demand run.
  const fromSim = historicalMode && sim.historical && !sim.historical.fallback ? sim.historical.starts : null;
  const starts = fromSim ?? (run.status === 'done' ? run.starts : null);
  const stale = !fromSim && run.status === 'done' && run.input !== input;
  const summary = useMemo(() => (starts ? summarizeBacktest(starts) : null), [starts]);

  const startRun = () => {
    if (!input || !complete.length) return;
    cancelRef.current();
    const base: SimInput = { ...input, returnModel: 'historical', historicalStockShare: settings.stockShare };
    const slices = chunk(complete, START_CHUNK);
    const acc: SimHistoricalStart[] = [];
    let cancelled = false, timer: ReturnType<typeof setTimeout> | null = null;
    cancelRef.current = () => { cancelled = true; if (timer) clearTimeout(timer); };
    setRun({ status: 'running', input, done: 0, total: complete.length });
    const step = (k: number) => {
      if (cancelled) return;
      if (k >= slices.length) { setRun({ status: 'done', input, starts: acc, endAge: input.A.endAge, span: spanOf(complete) }); return; }
      const r = runForecastSim({ ...base, historicalStarts: slices[k] });
      acc.push(...(r.historical?.starts ?? []));
      setRun({ status: 'running', input, done: acc.length, total: complete.length });
      timer = setTimeout(() => step(k + 1), 0); // yield to the page between slices
    };
    timer = setTimeout(() => step(0), 0);
  };
  // A setting this card owns changed (stock share): the old run no longer matches.
  useEffect(() => { cancelRef.current(); setRun({ status: 'idle' }); }, [settings.stockShare]);

  const muted: React.CSSProperties = { fontSize: 13, color: 'var(--muted)', margin: '8px 0 0', lineHeight: 1.5, maxWidth: '72ch' };

  const header = <CardHead title="How would this plan have done?" open={open} onToggle={() => setOpen(o => !o)} />;
  if (!open) return <div className="fc-card fc-closed">{header}</div>;

  const mixText = glidePath ? 'your glide path’s mix of stocks and bonds' : `${Math.round(settings.stockShare * 100)}% stocks${settings.stockShare < 1 ? `, ${Math.round((1 - settings.stockShare) * 100)}% bonds` : ''}`;
  const span = spanOf(complete);
  // Tiles describe the run they show: the on-demand run's own horizon and span (they
  // stay put, dimmed, when the plan has since changed), else the current plan's.
  const ranFor = !fromSim && run.status === 'done' ? run : null;
  const shownEndAge = ranFor ? ranFor.endAge : endAge;
  const shownSpan = ranFor ? ranFor.span : span;

  // --- Tiles ---
  const worst = summary?.worst ?? null;
  const worstText = (() => {
    if (!worst) return { value: '—', sub: '' };
    if (worst.ranOutAge != null) return { value: String(worst.startYear), sub: `ran out at ${worst.ranOutAge}${worst.deepestCut > 0.005 ? ` · spending cut ${Math.round(worst.deepestCut * 100)}%` : ''}` };
    if (worst.deepestCut > 0.005) return { value: String(worst.startYear), sub: `lasted · spending cut ${Math.round(worst.deepestCut * 100)}% at most` };
    return { value: String(worst.startYear), sub: `lasted · smallest balance, ${money(worst.endInvReal)}` };
  })();
  const tiles = summary ? [
    {
      label: 'Starting years that lasted', value: `${summary.lasted} of ${summary.total}`,
      sub: `${Math.round((summary.lasted / Math.max(1, summary.total)) * 100)}% · starts ${shownSpan}`,
      tip: `Each starting year replays the plan from today through age ${shownEndAge} using that year’s and the following years’ actual returns and inflation. “Lasted” means savings never ran short.`,
    },
    {
      label: 'Toughest starting year', value: worstText.value, sub: worstText.sub,
      tip: 'The starting year that ran out earliest. If none ran out, the one with the deepest spending cut, then the smallest balance left.',
    },
    {
      label: `Median savings left at ${shownEndAge}`, value: money(summary.medianEndReal), sub: 'in today’s dollars',
      tip: 'The middle result across starting years for investable savings at the end of the plan (home equity not included), converted to today’s dollars using the inflation those years actually had.',
    },
  ] : [];

  // --- Grid: one square per starting year, rows by decade ---
  const byYear = new Map((starts ?? []).map(s => [s.startYear, s]));
  const decades = starts && starts.length ? Array.from(new Set(starts.map(s => Math.floor(s.startYear / 10) * 10))).sort((a, b) => a - b) : [];
  const ordered = [...(starts ?? [])].sort((a, b) => a.startYear - b.startYear);
  const pickedStat = picked != null ? byYear.get(picked) ?? null : null;
  const labelFor = (s: SimHistoricalStart) =>
    `${s.startYear}: ${s.ranOutAge != null ? `ran out at age ${s.ranOutAge}` : 'lasted'}${s.deepestCut > 0.005 ? `, spending cut ${Math.round(s.deepestCut * 100)}% at most` : ''}`;
  const square = 24;
  // Squares shrink (never grow) so a decade row fits the narrowest phones.
  const cell: React.CSSProperties = { flex: '1 1 0', minWidth: 0, maxWidth: square, aspectRatio: '1', minHeight: 0 };
  const onGridKey = (e: React.KeyboardEvent, year: number) => {
    const idx = ordered.findIndex(s => s.startYear === year);
    let next = idx;
    if (e.key === 'ArrowRight') next = idx + 1;
    else if (e.key === 'ArrowLeft') next = idx - 1;
    else if (e.key === 'ArrowDown') next = ordered.findIndex(s => s.startYear === year + 10);
    else if (e.key === 'ArrowUp') next = ordered.findIndex(s => s.startYear === year - 10);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = ordered.length - 1;
    else return;
    e.preventDefault();
    const target = ordered[Math.min(ordered.length - 1, Math.max(0, next < 0 ? idx : next))];
    if (target) {
      setPicked(target.startYear);
      (document.getElementById(`fc-bt-${target.startYear}`) as HTMLButtonElement | null)?.focus();
    }
  };
  const focusYear = picked != null && byYear.has(picked) ? picked : ordered[0]?.startYear;

  // Until there are results the card stays short (one line and the button)
  // instead of stretching beside its neighbour around an empty box.
  const short = !(summary && summary.total > 0);
  return (
    <div className={'fc-card' + (short ? ' fc-short' : '')}>
      {header}
      <CardMeta tipLabel="About the backtest"
        tip={`One run for each starting year from ${HISTORY_FIRST_YEAR}, using that year’s and the following years’ actual stock and bond returns and inflation, with ${mixText}.`}>
        Replays your plan through past US markets, one run per starting year.
      </CardMeta>

      {/* Settings */}
      <div style={{ display: 'flex', gap: '8px 20px', flexWrap: 'wrap', alignItems: 'center', marginTop: 12 }}>
        {/* The "i" sits outside the label (a tap on it must never flip the checkbox) and
            opens its text inline below, so nothing overflows a phone's right edge. */}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 32 }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text)', cursor: 'pointer' }}>
            <input type="checkbox" checked={historicalMode} style={{ width: 'auto' }}
              onChange={e => onSettings({ ...settings, returnModel: e.target.checked ? 'historical' : 'montecarlo' })} />
            Use past markets for the whole forecast
          </label>
          <button type="button" className="fc-tip" aria-label="About using past markets for the forecast" aria-expanded={aboutOpen} aria-controls={aboutId}
            onClick={() => setAboutOpen(o => !o)}
            style={{ fontSize: 11, color: 'var(--muted)', cursor: 'help', border: '1px solid var(--border)', borderRadius: '50%', width: 15, height: 15, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1, background: aboutOpen ? 'var(--accent-dim)' : 'none', padding: 0, textTransform: 'none', flex: 'none' }}>i</button>
        </span>
        {!glidePath && (
          <label className="fc-field">
            In stocks
            <select value={settings.stockShare}
              onChange={e => onSettings({ ...settings, stockShare: Number(e.target.value) })}>
              {STOCK_SHARES.map(s => <option key={s} value={s}>{Math.round(s * 100)}%{s < 1 ? ` (${Math.round((1 - s) * 100)}% bonds)` : ''}</option>)}
            </select>
          </label>
        )}
      </div>
      <p id={aboutId} hidden={!aboutOpen} style={muted}>
        Off: the chart and success rate come from random futures (a Monte Carlo simulation) around your return and volatility.
        On: they come from these past starting years instead, so the success rate is the share of starting years that lasted, and
        your return and volatility settings are not used. Past sequences overlap and repeat each other, so this is a stress test, not a probability.
      </p>

      {/* Not enough history */}
      {complete.length === 0 && (
        <p style={{ ...muted, color: 'var(--amber)' }} role="status">
          Your plan runs {years} years, longer than the {HISTORY_LAST_YEAR - HISTORY_FIRST_YEAR + 1} years of history available, so there is no complete past stretch to replay
          {historicalMode ? '. The forecast is using random futures instead.' : '.'}
        </p>
      )}
      {complete.length > 0 && complete.length < MIN_HISTORICAL_STARTS && (
        <p style={{ ...muted, color: 'var(--amber)' }} role="status">
          Only {complete.length} starting year{complete.length === 1 ? '' : 's'} ({span}) {complete.length === 1 ? 'has' : 'have'} a full {years}-year run of history, so treat this as a rough check.
          Shorter plans have more past stretches to compare against.
        </p>
      )}

      {/* On-demand run (when the forecast itself isn't replaying history) */}
      {!fromSim && complete.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 14 }}>
          <button type="button" className="btn-primary btn-sm" disabled={!input || run.status === 'running'} onClick={startRun}>
            {run.status === 'done' ? 'Run again' : 'Run the backtest'}
          </button>
          <span style={{ fontSize: 12, color: 'var(--muted)' }} role="status" aria-live="polite">
            {run.status === 'running' ? `Checking starting years… ${run.done} of ${run.total}`
              : stale ? 'Your plan has changed since this ran.'
              : run.status === 'idle' ? `${complete.length} starting years (${span}) · results appear here` : ''}
          </span>
        </div>
      )}

      {summary && summary.total > 0 && (<>
        <Tiles cols={3} dim={stale}>
          {tiles.map(t => <StatTile key={t.label} label={t.label} value={t.value} sub={t.sub} tip={t.tip} />)}
        </Tiles>

        {/* One square per starting year, its legend and the picked year beside it */}
        <div className="fc-bt" style={{ opacity: stale ? 0.55 : 1 }}>
          <div className="fc-bt-grid" role="group" aria-label="Result for each starting year. Use the arrow keys to move between years.">
            {decades.map(dec => (
              <div key={dec} style={{ display: 'flex', alignItems: 'center', gap: isMobile ? 3 : 4, marginBottom: 4 }}>
                <span style={{ width: isMobile ? 40 : 46, flex: 'none', fontSize: 12, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>{dec}s</span>
                {Array.from({ length: 10 }, (_, k) => dec + k).map(y => {
                  const s = byYear.get(y);
                  if (!s) return <span key={y} aria-hidden="true" style={cell} />;
                  const failed = s.ranOutAge != null;
                  const cut = !failed && s.deepestCut >= 0.1;
                  return (
                    <button key={y} id={`fc-bt-${y}`} type="button" aria-label={labelFor(s)} aria-pressed={picked === y}
                      title={labelFor(s)} tabIndex={y === focusYear ? 0 : -1}
                      onClick={() => setPicked(p => (p === y ? null : y))} onKeyDown={e => onGridKey(e, y)}
                      style={{
                        ...cell, padding: 0, borderRadius: 4, lineHeight: 1,
                        fontSize: 12, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        border: picked === y ? '2px solid var(--text)' : '1px solid var(--border)',
                        background: failed ? 'var(--red)' : cut ? 'color-mix(in srgb, var(--amber) 70%, transparent)' : 'color-mix(in srgb, var(--green) 65%, transparent)',
                        color: failed ? 'var(--surface)' : 'var(--text)',
                      }}>
                      <span aria-hidden="true">{failed ? '✕' : cut ? '↓' : ''}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="fc-bt-side">
            <p className="fc-legend" style={{ flexDirection: isMobile ? 'row' : 'column', marginTop: 0 }} aria-hidden="true">
              <span><span className="fc-swatch" style={{ background: 'color-mix(in srgb, var(--green) 65%, transparent)' }} />Lasted</span>
              <span><span className="fc-swatch" style={{ background: 'color-mix(in srgb, var(--amber) 70%, transparent)' }} />↓ Lasted, spending cut 10% or more</span>
              <span><span className="fc-swatch" style={{ background: 'var(--red)' }} />✕ Ran out</span>
            </p>
            <p style={{ ...muted, color: 'var(--text)', marginTop: 12 }}>
              {summary.ranOut.length === 0
                ? 'No starting year ran out of money.'
                : <>Ran out: {summary.ranOut.map(s => `${s.startYear} (age ${s.ranOutAge})`).join(', ')}.</>}
            </p>
            <p style={{ ...muted, minHeight: 20 }} aria-live="polite">
              {pickedStat
                ? <>{labelFor(pickedStat)}. Savings left at {shownEndAge}: <span style={{ filter: privacy ? 'blur(5px)' : 'none' }}>{money(pickedStat.endInvReal)}</span>
                  {pickedStat.lowestSpendReal != null && <> · lowest yearly everyday spending: {money(pickedStat.lowestSpendReal)}</>} (today’s dollars).</>
                : 'Select a square to see that starting year.'}
            </p>
          </div>
        </div>
      </>)}

      <p className="fc-foot">
        Estimates for planning, not advice — the past won’t repeat exactly.
        <InlineTip label="About the historical data" text={HISTORY_SOURCE_NOTE} />{' '}
        Income, spending and tax brackets keep their planned buying power through each past stretch’s inflation; home values and fixed-rate assets follow your plan’s own rates.
      </p>
    </div>
  );
}
