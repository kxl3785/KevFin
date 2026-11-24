import { useId, useLayoutEffect, useRef, useState } from 'react';

// "ⓘ" tip for the plan-answers card, plan versus actual and scenarios: the same
// look and behaviour as TaxPicture's Tip (hover, keyboard focus, Escape to close,
// role="tooltip" wired with aria-describedby), but the tooltip is kept inside the
// screen. It is centred under the button when there is room and slid sideways
// when there isn't (a button near the right edge of a phone screen would
// otherwise push a centred tooltip off it), and never wider than the screen
// less an 8 px margin each side.

const EDGE = 8;

// Where the tooltip goes, relative to the button's left edge: centred on the
// button, then clamped into [EDGE, viewport − EDGE]. Pure, for tests.
export function fitTipPlacement(btnLeft: number, btnWidth: number, want: number, viewport: number): { left: number; width: number } {
  const width = Math.max(0, Math.min(want, viewport - 2 * EDGE));
  const centred = btnLeft + btnWidth / 2 - width / 2;
  const left = Math.min(Math.max(EDGE, centred), viewport - EDGE - width);
  return { left: left - btnLeft, width };
}

export function FitTip({ text, label = 'More info', width = 260 }: { text: string; label?: string; width?: number }) {
  const [show, setShow] = useState(false);
  const [place, setPlace] = useState<{ left: number; width: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    if (!show || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const vw = document.documentElement.clientWidth || window.innerWidth;
    setPlace(fitTipPlacement(r.left, r.width, width, vw));
  }, [show, width]);
  return (
    <span style={{ position: 'relative', display: 'inline-flex', flex: 'none' }}
      onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      <button ref={btn} type="button" className="fc-tip" aria-label={label} aria-describedby={show ? id : undefined}
        onFocus={() => setShow(true)} onBlur={() => setShow(false)}
        onKeyDown={e => { if (e.key === 'Escape') setShow(false); }}
        style={{ fontSize: 11, color: 'var(--muted)', cursor: 'help', border: '1px solid var(--border)', borderRadius: '50%', width: 15, height: 15, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1, background: 'none', padding: 0, textTransform: 'none' }}>i</button>
      {show && (
        <span id={id} role="tooltip" style={{
          position: 'absolute', top: '100%', marginTop: 6, zIndex: 50,
          // Until measured (the first layout pass), centre it as the plain Tip does.
          ...(place ? { left: place.left, width: place.width } : { left: '50%', transform: 'translateX(-50%)', width, maxWidth: `calc(100vw - ${2 * EDGE}px)` }),
          background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px',
          boxShadow: '0 8px 24px rgba(0,0,0,0.5)', fontSize: 11, lineHeight: 1.5, color: 'var(--muted)', boxSizing: 'border-box',
          textTransform: 'none', letterSpacing: 0, fontWeight: 400, whiteSpace: 'normal', textAlign: 'left',
        }}>{text}</span>
      )}
    </span>
  );
}
