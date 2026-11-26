import { useEffect, useRef, useState } from 'react';
import { parseNumOrNull } from '../../lib/parseNum.ts';
import { inputDisplayText, inputEditText, type InputKind } from '../../lib/forecastDisplay.ts';

// The Forecast's number box. Keeps a blank field blank while editing (instead of
// snapping to 0) and commits only when the text parses to a number; the model
// keeps its last value while blank. Shows a "required" hint when blank and required.
//
// Away from the cursor the box shows the value written out — "$71,772" for money
// (a "$" prefix), "2%" for a percentage (a "%" suffix), a bare number otherwise
// (ages and years never get a $ or separators) — and while it is being edited it
// holds plain digits. Typing is read by parseNum, so "71,772", "$71,772" and
// "72k" all work. Other units ("/yr", "yrs") stay beside the box. Arrow up/down
// step the value by `step` (default 1), as the old number boxes did.
// The input carries .fc-num, which privacy mode masks (index.css).
export default function NumberInput({ value, onCommit, mul = 1, step, width = 100, required = true, prefix, suffix, title, imported = false, signed = false }: {
  value: number; onCommit: (n: number) => void; mul?: number; step?: number; width?: number;
  required?: boolean; prefix?: string; suffix?: string; title?: string;
  imported?: boolean; // value came from a document import — tint it so it stands out
  signed?: boolean;   // the value may be negative: ask phones for a keyboard with a minus key
}) {
  const kind: InputKind = prefix === '$' ? 'money' : suffix === '%' ? 'percent' : 'plain';
  const outsidePrefix = kind === 'money' ? undefined : prefix;
  const outsideSuffix = kind === 'percent' ? undefined : suffix;
  const [text, setText] = useState(() => inputEditText(value, mul));
  const [focused, setFocused] = useState(false);
  const last = useRef(value);
  useEffect(() => {
    if (Math.abs(value - last.current) > 1e-9) { last.current = value; setText(inputEditText(value, mul)); }
  }, [value, mul]);
  // "Saved" feedback lives on the box itself: the field flashes green with a ✓
  // once you click off it (on blur) after an edit — not on every keystroke, which
  // was distracting. `dirty` tracks whether the value changed during this focus.
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<number | undefined>(undefined);
  const dirty = useRef(false);
  const flashSaved = () => {
    setSaved(true);
    window.clearTimeout(savedTimer.current);
    savedTimer.current = window.setTimeout(() => setSaved(false), 1200);
  };
  useEffect(() => () => window.clearTimeout(savedTimer.current), []);
  const empty = text.trim() === '';
  const commit = (n: number) => { last.current = n / mul; onCommit(n / mul); dirty.current = true; };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      {required && empty && <span style={{ fontSize: 10, color: 'var(--red)' }}>required</span>}
      {imported && !saved && <span title="Imported from a document" style={{ fontSize: 10, color: 'var(--imported)' }}>●</span>}
      {outsidePrefix && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{outsidePrefix}</span>}
      <input className="fc-num" type="text" inputMode={signed ? 'text' : 'decimal'} autoComplete="off" spellCheck={false}
        title={imported ? (title ? title + ' · ' : '') + 'Imported from a document' : title}
        value={focused ? text : inputDisplayText(last.current, mul, kind)}
        onFocus={e => {
          setFocused(true);
          setText(inputEditText(last.current, mul));
          const el = e.currentTarget;
          requestAnimationFrame(() => { try { el.select(); } catch { /* ignore */ } });
        }}
        onChange={e => {
          const raw = e.target.value;
          setText(raw);
          if (raw.trim() === '') return; // leave blank — don't insert 0
          const n = parseNumOrNull(raw);
          if (n != null) commit(n);
        }}
        onKeyDown={e => {
          if (e.key === 'Enter') { (e.target as HTMLInputElement).blur(); return; }
          if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
          e.preventDefault();
          const cur = parseNumOrNull(text) ?? Math.round(last.current * mul * 100) / 100;
          const d = (step ?? 1) * (e.key === 'ArrowUp' ? 1 : -1);
          const n = Math.round((cur + d) * 1e6) / 1e6;
          setText(String(n));
          commit(n);
        }}
        onBlur={() => {
          setFocused(false);
          // Don't leave the box blank on the way out. An emptied optional field
          // means zero — autofill and commit it. A required field instead snaps
          // back to its last value (0 would be nonsensical for an age or rate).
          if (text.trim() === '') {
            if (required) { setText(inputEditText(last.current, mul)); }
            else { setText(inputEditText(0, mul)); last.current = 0; onCommit(0); dirty.current = true; }
          } else if (parseNumOrNull(text) == null) {
            setText(inputEditText(last.current, mul)); // unreadable text: show the value it kept
          }
          if (dirty.current) { dirty.current = false; flashSaved(); }
        }}
        style={{
          fontSize: 13, padding: '3px 6px', width, textAlign: 'right', fontVariantNumeric: 'tabular-nums',
          borderColor: saved ? 'var(--green)' : imported ? 'var(--imported)' : required && empty ? 'var(--red)' : undefined,
          background: saved ? 'rgba(74,222,128,0.12)' : imported ? 'var(--imported-dim)' : undefined,
          transition: 'border-color 0.3s ease, background-color 0.3s ease',
        }} />
      {outsideSuffix && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{outsideSuffix}</span>}
      {/* Reserved slot so the ✓ never shifts layout when it appears. */}
      <span title="Saved" style={{ width: 12, fontSize: 12, fontWeight: 700, color: 'var(--green)', opacity: saved ? 1 : 0, transition: 'opacity 0.3s ease', pointerEvents: 'none' }}>✓</span>
    </span>
  );
}
