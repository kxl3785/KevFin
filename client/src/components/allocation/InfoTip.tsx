import { useId, useState } from 'react';
import { useIsMobile } from '../../hooks/useIsMobile.ts';

// The small "i" button used across the Investments page (allocation and returns
// cards). It opens on hover, keyboard focus or tap; Escape or moving away
// closes it. The text is always in the DOM and tied to the button through
// aria-describedby, so screen readers get it without opening anything. On
// phones the text docks to the bottom of the screen so a tip near the right
// edge can't run off it.
//
// Either pass `text` (a plain string) or children. `label` names what the tip
// explains ("More about …"); without it the button is simply "More info".
export default function InfoTip({ label, text, children, width = 260 }: {
  label?: string;
  text?: string;
  children?: React.ReactNode;
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const isMobile = useIsMobile();

  const pop: React.CSSProperties = isMobile
    ? { position: 'fixed', left: 16, right: 16, bottom: 16 }
    : { position: 'absolute', top: '100%', left: '50%', transform: 'translateX(-50%)', marginTop: 6, width, maxWidth: '80vw' };

  return (
    <span
      style={{ position: 'relative', display: 'inline-flex', verticalAlign: 'middle', flex: 'none' }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-label={label ? `More about ${label}` : 'More info'}
        aria-expanded={open}
        aria-describedby={id}
        onClick={() => setOpen(true)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={e => { if (e.key === 'Escape') setOpen(false); }}
        style={{
          fontSize: 10, lineHeight: 1, color: 'var(--muted)', background: 'transparent', cursor: 'help',
          border: '1px solid var(--border)', borderRadius: '50%', width: 16, height: 16, padding: 0,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600,
          textTransform: 'none', letterSpacing: 0,
        }}
      >i</button>
      <span id={id} role="tooltip" style={{
        ...pop, zIndex: 50, display: open ? 'block' : 'none',
        background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px',
        boxShadow: '0 8px 24px rgba(0,0,0,0.35)', fontSize: 12, lineHeight: 1.5, color: 'var(--muted)',
        fontWeight: 400, textTransform: 'none', letterSpacing: 0, whiteSpace: 'normal', textAlign: 'left',
      }}>
        {text ?? children}
      </span>
    </span>
  );
}
