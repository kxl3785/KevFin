import { useEffect, useRef } from 'react';
import { PLAN_TABS, PLAN_TAB_META, tabAfterKey, type PlanTab } from './planTabs.ts';

// What the footer says about one tab: a few words, a longer tooltip, and amber
// when it flags something to look at (no savings going in, placeholder ages).
export interface PlanTabNote { short: string; detail?: string; warn?: boolean }

// The "Your plan" tab strip, the open tab's panel, and a footer line that sums up
// the other tabs, each part of it a link to its tab. A real tab list: the open
// tab alone is in the tab order, arrow keys / Home / End move along the strip
// and open the tab they land on.
export default function PlanTabs({ active, onSelect, notes, children }: {
  active: PlanTab; onSelect: (t: PlanTab) => void; notes: Record<PlanTab, PlanTabNote>; children: React.ReactNode;
}) {
  const tabRefs = useRef<Partial<Record<PlanTab, HTMLButtonElement | null>>>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const go = (t: PlanTab) => { onSelect(t); tabRefs.current[t]?.focus(); };
  // From the footer (the bottom of a possibly long tab): open the tab, and bring
  // the strip back into view if it has scrolled off the top.
  const goFromFooter = (t: PlanTab) => {
    onSelect(t);
    tabRefs.current[t]?.focus({ preventScroll: true });
    const strip = rootRef.current;
    if (strip && strip.getBoundingClientRect().top < 72) {
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      (strip.closest('.fc-anchor') ?? strip).scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    }
  };
  // On a phone the strip scrolls sideways: keep the open tab in view when it is
  // opened from elsewhere (a milestone pin, the footer, the arrow keys).
  const stripRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const strip = stripRef.current, tab = tabRefs.current[active];
    if (!strip || !tab || strip.scrollWidth <= strip.clientWidth) return;
    const left = tab.offsetLeft, right = left + tab.offsetWidth; // the strip is the offsetParent (position: relative)
    if (left < strip.scrollLeft) strip.scrollLeft = left - 4;
    else if (right > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = right - strip.clientWidth + 4;
  }, [active]);
  const others = PLAN_TABS.filter(t => t !== active && notes[t].short);
  return (
    <div ref={rootRef} className="fc-plan">
      <div ref={stripRef} role="tablist" aria-label="Your plan" className="fc-plan-tabs"
        onKeyDown={e => {
          const next = tabAfterKey(active, e.key);
          if (!next) return;
          e.preventDefault();
          go(next);
        }}>
        {PLAN_TABS.map(t => {
          const m = PLAN_TAB_META[t], on = t === active;
          return (
            <button key={t} ref={el => { tabRefs.current[t] = el; }} type="button" role="tab" id={`fc-plan-tab-${t}`}
              aria-selected={on} aria-controls={on ? `fc-plan-panel-${t}` : undefined} tabIndex={on ? 0 : -1}
              className="fc-plan-tab" onClick={() => onSelect(t)}>
              <span aria-hidden="true">{m.icon}</span>
              <span>{m.label}{m.more && <span className="fc-plan-tab-more">{m.more}</span>}</span>
            </button>
          );
        })}
      </div>
      <div role="tabpanel" id={`fc-plan-panel-${active}`} aria-labelledby={`fc-plan-tab-${active}`} className="fc-plan-panel">
        {children}
      </div>
      {others.length > 0 && (
        <p className="fc-plan-foot">
          {others.map(t => (
            <span key={t} className="fc-plan-foot-item">
              <button type="button" className={'fc-plan-foot-link' + (notes[t].warn ? ' warn' : '')} title={notes[t].detail}
                onClick={() => goFromFooter(t)}>
                <strong>{PLAN_TAB_META[t].label}{PLAN_TAB_META[t].more}</strong> {notes[t].short}
              </button>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
