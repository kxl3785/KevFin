import { useRef, useState, type ReactNode } from 'react';
import { answerTiles, type AnswerTile } from '../../lib/planAnswersText.ts';
import { InlineTip } from './ui.tsx';
import type { PlanAnswersState } from './usePlanAnswers.ts';

// The row of headline tiles at the top of the Forecast page: the chance the money
// lasts, the value at retirement, today's net worth, and the plan's main answers
// (safe yearly spending, earliest workable retirement, enough to stop working) —
// the figures people come to the page for, before any chart or input. Styles are
// the .fc-kpi* rules in index.css. Presentational: the numbers arrive worked out.

// One tile: label (with an optional status tag and "i"), value, one sub-line.
// `detail` is a richer popover shown on hover or keyboard focus (the "today"
// breakdown); `tip` is a plain-text "i".
export function HeadTile({ label, value, sub, color, tag, detail, tip, tipLabel, hero = false, dim = false, children }: {
  label: string; value: ReactNode; sub?: ReactNode; color?: string; tag?: ReactNode;
  detail?: ReactNode; tip?: string; tipLabel?: string; hero?: boolean; dim?: boolean; children?: ReactNode;
}) {
  const [show, setShow] = useState(false);
  // A tile in the right half of the screen opens its popover leftwards, so it
  // never runs off the edge (and never makes a phone scroll sideways).
  const [alignRight, setAlignRight] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const open = () => {
    if (!detail) return;
    const r = ref.current?.getBoundingClientRect();
    const vw = document.documentElement.clientWidth || window.innerWidth;
    setAlignRight(!!r && r.left + r.width / 2 > vw / 2);
    setShow(true);
  };
  return (
    <div ref={ref} className={'fc-kpi' + (hero ? ' hero' : '')} style={{ opacity: dim ? 0.55 : 1 }}
      onMouseEnter={open} onMouseLeave={() => setShow(false)}
      tabIndex={detail ? 0 : undefined} onFocus={open} onBlur={() => setShow(false)}
      onKeyDown={e => { if (e.key === 'Escape') setShow(false); }}>
      <p className="fc-kpi-label" style={{ cursor: detail ? 'help' : undefined }}>
        <span>
          {label}
          {detail && <span aria-hidden="true" style={{ fontSize: 10, opacity: 0.55, marginLeft: 5 }}>ⓘ</span>}
          {tip && <InlineTip label={tipLabel ?? `About ${label.toLowerCase()}`} text={tip} width={280} />}
        </span>
      </p>
      <p className="fc-kpi-value" style={color ? { color } : undefined}>{value}{tag && <span className="fc-kpi-tag">{tag}</span>}</p>
      {children}
      {sub ? <p className="fc-kpi-sub">{sub}</p> : null}
      {detail && show && <div className={'fc-kpi-pop' + (alignRight ? ' right' : '')} role="tooltip">{detail}</div>}
    </div>
  );
}

// The answers shown up top, in this order; the rest stay on the "What your plan
// supports" card.
export const HEADLINE_ANSWERS: AnswerTile['key'][] = ['spend', 'retire', 'independence'];
// Shorter labels than the card's, to fit six tiles across; the "i" on each says
// exactly what the figure is.
const SHORT_LABELS: Record<AnswerTile['key'], string> = {
  spend: 'Safe yearly spending', retire: 'Earliest retirement', independence: 'Enough to stop working', coast: 'Enough to stop saving',
};

// The answer tiles, with a loading state while the first solve runs (and the
// previous answers dimmed while a newer one does).
export function AnswerHeadTiles({ answers, money, endAge, earnerLabel }: {
  answers: PlanAnswersState;
  money: (n: number) => string;
  endAge: number;
  earnerLabel: (i: number) => string | undefined;
}) {
  const r = answers.result;
  const working = answers.progress != null;
  const pctDone = Math.round((answers.progress ?? 0) * 100);
  if (!r) {
    const sub = answers.failed ? 'couldn’t be worked out' : !answers.ready ? 'waiting for your balances' : `working it out… ${pctDone}%`;
    return (<>
      {HEADLINE_ANSWERS.map(k => (
        <HeadTile key={k} label={SHORT_LABELS[k]} value={<span className="fc-kpi-wait" aria-hidden="true" />} sub={sub} />
      ))}
    </>);
  }
  const tiles = answerTiles(r, { money, endAge, earnerLabel });
  // A share-of-savings spending rule never runs out, so these answers don't apply.
  if (!tiles.length) {
    return (<>
      {HEADLINE_ANSWERS.map(k => (
        <HeadTile key={k} label={SHORT_LABELS[k]} value="—" sub="not used with a share-of-savings rule" />
      ))}
    </>);
  }
  return (<>
    {HEADLINE_ANSWERS.map(k => {
      const t = tiles.find(x => x.key === k);
      if (!t) return null;
      return (
        <HeadTile key={k} label={k === 'spend' ? t.label : SHORT_LABELS[k]} value={t.value}
          tip={t.tip} tipLabel={`About ${t.label.toLowerCase()}`} dim={answers.stale}
          sub={answers.stale && working ? `${t.sub} · updating…` : t.sub}>
          {t.bar != null && (
            <div role="progressbar" aria-label={`${t.label}: progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(t.bar * 100)}
              className="fc-kpi-bar">
              <div style={{ width: `${t.bar * 100}%` }} />
            </div>
          )}
        </HeadTile>
      );
    })}
  </>);
}
