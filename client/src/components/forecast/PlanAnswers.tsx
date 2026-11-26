import type { SimInput } from '../../lib/forecastSim.ts';
import { normalizeTargets } from '../../lib/forecastSolve.ts';
import { answerTiles, guardrailLines, answersNote, sourceNote, type Words, type AnswerTile } from '../../lib/planAnswersText.ts';
import { usePersistentState } from '../../hooks/usePersistentState.ts';
import { FitTip as Tip } from './FitTip.tsx';
import { CardHead, CardMeta, InlineTip, StatTile, Tiles } from './ui.tsx';
import type { PlanAnswersState } from './usePlanAnswers.ts';

// "What your plan supports": the Forecast's success percentage turned into amounts
// and ages — the most it can spend, the earliest it can retire, the balance at
// which work becomes optional, guardrails for spending. The headline answers sit
// in the row of tiles at the top of the page (HeadlineTiles.tsx); this card keeps
// the rest — its confidence settings, any answer not shown up there, the spending
// guardrails and the footnotes. Plan versus actual and saved scenarios are their
// own cards (PlanVsActual.tsx, Scenarios.tsx); the scenarios card reads the
// confidence settings chosen here. Read-only: nothing here moves money. Estimates
// for planning, not advice.
//
// The solve itself runs in usePlanAnswers.ts (shared with the headline tiles). The
// text is built from the result alone (lib/planAnswersText.ts), so answers still
// on screen while a new solve runs keep the confidence and balance they were
// worked out with.

const TARGET_OPTS = [0.75, 0.8, 0.85, 0.9, 0.95];
const LOWER_OPTS = [0.5, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9];
const UPPER_OPTS = [0.8, 0.85, 0.9, 0.95, 0.97, 0.99];

export default function PlanAnswers({ input, money, answers, shownAbove = [] }: {
  input: SimInput | null;               // the shown forecast's input (with any what-if levers); null until data loads
  money: (n: number) => string;         // the page's formatter (masks in privacy mode)
  answers: PlanAnswersState;            // the shared solve (usePlanAnswers)
  shownAbove?: AnswerTile['key'][];     // answers already in the page's headline tiles
}) {
  const [open, setOpen] = usePersistentState('mon.fcAnswersOpen', true);
  const { targets, setTargets, progress, failed } = answers;

  const pct = (v: number) => `${Math.round(v * 100)}%`;
  // Amounts inside a guardrail callout are emphasised.
  const words = (w: Words) => w.map((x, i) => (typeof x === 'string' ? x : <strong key={i}>{x.strong}</strong>));

  const header = <CardHead title="What your plan supports" note="today’s dollars" open={open} onToggle={() => setOpen(o => !o)} />;
  if (!open) return <div className="fc-card fc-closed">{header}</div>;

  const r = answers.result;
  const stale = answers.stale;
  const working = progress != null;

  // --- Tiles and guardrails, from the result (see lib/planAnswersText.ts) ---
  const allTiles = r ? answerTiles(r, {
    money, endAge: input?.A.endAge ?? 0,
    earnerLabel: i => (input?.earners[i] as { label?: string } | undefined)?.label,
  }) : [];
  const tiles = allTiles.filter(t => !shownAbove.includes(t.key));
  const aboveCount = allTiles.length - tiles.length;
  const guardLines = r ? guardrailLines(r, money) : [];
  const S = r && r.safeSpending.status === 'ok' ? r.safeSpending.amount : null;
  const note = r ? answersNote(r) : null;

  // A labelled dropdown for the settings row. The label wraps the select, so the
  // select's accessible name is the label text.
  const select = (label: string, value: number, opts: number[], onPick: (v: number) => void, tip: string) => {
    const list = opts.includes(value) ? opts : [...opts, value].sort((a, b) => a - b);
    return (
      <span className="fc-field">
        <label className="fc-field">
          {label}
          <select value={value} onChange={e => onPick(Number(e.target.value))}>
            {list.map(v => <option key={v} value={v}>{Math.round(v * 1000) / 10}%</option>)}
          </select>
        </label>
        <Tip label={`About ${label.toLowerCase()}`} text={tip} />
      </span>
    );
  };

  return (
    <div className="fc-card">
      {header}
      <CardMeta tipLabel="About these answers"
        tip="Everything here is worked out from your current forecast, including any what-if levers and your tax, market and spending-rule settings."
        controls={<>
          {select('Confidence', targets.target, TARGET_OPTS, v => setTargets(normalizeTargets({ ...targets, target: v })),
            'The share of simulated futures that must last for an answer to count. Higher is more cautious and gives smaller amounts.')}
          {select('Cut below', targets.lower, LOWER_OPTS.filter(v => v < targets.target), v => setTargets(normalizeTargets({ ...targets, lower: v })),
            'The chance at which the lower guardrail says to spend less.')}
          {select('Raise above', targets.upper, UPPER_OPTS.filter(v => v > targets.target), v => setTargets(normalizeTargets({ ...targets, upper: v })),
            'The chance at which the upper guardrail says spending could rise.')}
        </>}>
        Your chance of success as amounts and ages you can plan around.{aboveCount > 0 && ' The main answers are in the tiles at the top of the page; this card holds their settings and the rest.'}
      </CardMeta>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 20, marginTop: 8 }} role="status" aria-live="polite">
        {!input ? <span style={{ fontSize: 12, color: 'var(--muted)' }}>Waiting for your balances to load…</span>
          : working ? (<>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>{r ? 'Updating' : 'Working it out'}… {Math.round((progress ?? 0) * 100)}%</span>
            <div role="progressbar" aria-label="Working out the answers" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((progress ?? 0) * 100)}
              style={{ flex: '0 1 180px', height: 6, borderRadius: 3, background: 'var(--border)', overflow: 'hidden' }}>
              <div style={{ width: `${(progress ?? 0) * 100}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.2s' }} />
            </div>
          </>)
          : failed ? <span style={{ fontSize: 12, color: 'var(--red)' }}>These answers couldn’t be worked out for the current inputs.</span>
          : null}
      </div>

      {r && (<>
        {note && (
          <p className="fc-text" style={{ color: 'var(--text)', maxWidth: 'none', padding: '8px 12px', borderRadius: 8, background: 'var(--bg)', border: '1px solid var(--border)', opacity: stale ? 0.55 : 1 }}>
            {note}
          </p>
        )}
        {tiles.length > 0 && (
          <div style={{ marginTop: -8 }}>
            <Tiles cols={4} dim={stale}>
              {tiles.map(t => (
                <StatTile key={t.key} label={t.label} value={t.value} sub={t.sub} tip={t.tip}>
                  {t.bar != null && (
                    <div role="progressbar" aria-label={`${t.label}: progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(t.bar * 100)}
                      style={{ height: 5, borderRadius: 3, background: 'var(--border)', overflow: 'hidden', marginTop: 8 }}>
                      <div style={{ width: `${t.bar * 100}%`, height: '100%', background: 'var(--accent)' }} />
                    </div>
                  )}
                </StatTile>
              ))}
            </Tiles>
          </div>
        )}

        {guardLines.length > 0 && (
          <div style={{ opacity: stale ? 0.55 : 1 }}>
            <h3 className="fc-subhead">
              Spending guardrails at {money(S as number)} a year
              <Tip label="About spending guardrails" width={300} text={`Balances at which your safe spending would change. They are what your investable savings would be TODAY: if they dropped below the lower mark, the chance of lasting at this spending falls under ${pct(r.targets.lower)}; if they rose past the upper mark, it climbs over ${pct(r.targets.upper)}. The amount beside each mark is the spending that returns the plan to ${pct(r.targets.target)}. Re-check as your balance changes.`} />
            </h3>
            <ul className="fc-guards" style={{ listStyle: 'none', padding: 0 }}>
              {guardLines.map(l => {
                const tone = l.glyph === '▼' ? 'var(--amber)' : 'var(--green)';
                return (
                  <li key={l.glyph} className="fc-guard" style={{ borderLeftColor: tone }}>
                    {l.act ? (<>
                      <p className="fc-guard-act"><span aria-hidden="true" style={{ color: tone, marginRight: 6 }}>{l.glyph}</span>{words(l.act)}</p>
                      <p className="fc-guard-when">{words(l.when)}</p>
                    </>) : (
                      <p className="fc-guard-act"><span aria-hidden="true" style={{ color: tone, marginRight: 6 }}>{l.glyph}</span>{words(l.when)}</p>
                    )}
                    <p className="fc-guard-detail">{l.detail}</p>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </>)}

      {/* One footnote line: the balance the guardrails start from and where the
          chances come from (the full note behind its "i"), then the disclaimer. */}
      {r && (guardLines.length > 0 || allTiles.length > 0) && (
        <p className="fc-foot">
          {guardLines.length > 0 && <>Investable savings today: {money(r.current.investable)}</>}
          {guardLines.length > 0 && allTiles.length > 0 && ' · '}
          {allTiles.length > 0 && (<>
            {`${guardLines.length > 0 ? 'w' : 'W'}orked out from ${r.historical ? 'past starting years' : `${r.runs.toLocaleString('en-US')} simulated futures`}`}
            <InlineTip label="Where these chances come from" text={sourceNote(r)} />
          </>)}
        </p>
      )}
      <p className="fc-foot" style={{ marginTop: 6 }}>
        Estimates for planning, not advice. They assume the plan’s returns, inflation and tax settings hold; real markets and rules will differ.
      </p>
    </div>
  );
}
