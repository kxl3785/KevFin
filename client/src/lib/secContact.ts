// Client-side sanity check for the SEC contact email — same shape the server
// enforces (one @, no whitespace/quotes/brackets, dotted domain), so obvious
// typos fail instantly instead of after a round trip. The server stays the
// authority.
const EMAIL_RE = /^[^\s@<>"(),;:\\]+@[^\s@<>"(),;:\\]+\.[^\s@<>"(),;:\\]+$/;

export function isPlausibleEmail(value: string): boolean {
  const v = value.trim();
  return v.length <= 254 && EMAIL_RE.test(v);
}
