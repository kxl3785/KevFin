import { useState, useEffect } from 'react';

// Phone-width breakpoint. Kept in sync with the `@media (max-width: 680px)` rules
// in index.css so JS-level layout decisions match the CSS ones. An iPhone 15 is
// ~393 CSS px wide, well inside this; a narrow/split desktop window matches too.
export const MOBILE_BREAKPOINT = 680;

const query = `(max-width: ${MOBILE_BREAKPOINT}px)`;

// True when the viewport is phone-sized. Responsive by width (not user-agent), so
// the same logic gives a real phone the mobile layout and a shrunk desktop window
// the same — and updates live on rotate/resize. Use this only where CSS media
// queries can't express the change (e.g. rendering a different component or
// collapsing a wide table into stacked rows); prefer plain CSS for styling.
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  );

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setIsMobile(mql.matches);
    onChange(); // sync in case the width changed between first render and mount
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return isMobile;
}
