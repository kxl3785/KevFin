import { useEffect, useRef } from 'react';

// What Tab can land on inside a dialog.
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal behaviour for the app's overlay dialogs (Welcome, Setup, help, Import).
 * Attach the returned ref to the element with role="dialog" (give it
 * tabIndex={-1}) and pass whether it's showing. While open:
 *  - focus moves into the dialog, so a screen reader announces it and Tab
 *    starts inside it instead of on the page behind;
 *  - Tab and Shift+Tab cycle within the dialog;
 *  - the page behind doesn't scroll (wheel and touch reach only the overlay);
 * and on close, focus returns to whatever opened it.
 */
export function useModalDialog<T extends HTMLElement = HTMLDivElement>(open: boolean) {
  const ref = useRef<T>(null);

  useEffect(() => {
    if (!open) return;
    const el = ref.current;
    if (!el) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    el.focus({ preventScroll: true });

    const focusables = () => [...el.querySelectorAll<HTMLElement>(FOCUSABLE)]
      .filter(f => f.offsetParent !== null || f === document.activeElement);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) { e.preventDefault(); el.focus(); return; }
      const first = items[0], last = items[items.length - 1];
      const active = document.activeElement;
      if (!el.contains(active) || active === el) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault(); first.focus();
      }
    };
    document.addEventListener('keydown', onKey);

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      // Only hand focus back if it's still inside the (now closing) dialog or
      // lost to <body>; never steal it from something the user moved to.
      const now = document.activeElement;
      if (opener && opener.isConnected && (!now || now === document.body || el.contains(now))) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [open]);

  return ref;
}
