import { useEffect, type KeyboardEvent } from 'react';
import { fmtDate } from './format.ts';

// Small UI helpers shared by the Budget page and its popups.

// A transaction date the way every Budget list shows it: "Jun 18" within the
// current year, "Jun 18, 2025" otherwise. Never ISO ("2026-06-18") or "6/18/26".
export function fmtTxnDate(d: string | Date): string {
  const y = typeof d === 'string' ? Number(d.slice(0, 4)) : d.getFullYear();
  return fmtDate(d, { year: y !== new Date().getFullYear() });
}

// Props that make a non-<button> element (a table row with controls inside it)
// act as one: focusable, announced as a button, and activated with Enter/Space.
// The key handler ignores keys that bubbled up from a control INSIDE the row
// (its category picker, a remove button), so those keep working on their own.
export function rowProps(onActivate: () => void, opts: { role?: 'button' | 'checkbox'; checked?: boolean } = {}) {
  return {
    role: opts.role ?? 'button',
    tabIndex: 0,
    ...(opts.checked !== undefined ? { 'aria-checked': opts.checked } : {}),
    onClick: onActivate,
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.target !== e.currentTarget) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onActivate(); }
    },
  };
}

// Run `onEscape` when Esc is pressed, unless something already claimed the key
// (an open category picker, an inline editor) by calling preventDefault().
export function useEscapeKey(onEscape: () => void, active = true) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) onEscape(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onEscape, active]);
}
