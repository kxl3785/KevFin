// Data minimisation for what the AI assistant is shown. The assistant answers
// questions about balances, spending and plans; it has no use for where the user
// lives, a full account or reference number, or someone's email or phone number
// in a transfer note. Those are trimmed here, before anything is written to the
// model's prompt or its data files. Pure string functions, no dependencies.
//
// What this does NOT do: remove people's names from transactions (there is no
// reliable way to tell a person from a shop), or touch amounts, dates, account
// names and merchant names, which the answers are made of.

const ZIP = /^\d{5}(-\d{4})?$/;
const COUNTRY = /^(usa|u\.s\.a\.?|us|united states( of america)?)$/i;

// "742 Evergreen Terrace, Springfield, OR 97477" -> "Springfield, OR".
// The first comma-separated part is taken to be the street line and dropped, as
// are a ZIP code and the country. With nothing recognisable left, null.
export function placeLabel(address: string): string | null {
  const parts = address.split(',').map(p => p.trim()).filter(Boolean);
  if (parts.length < 2) return null; // no commas: can't tell the street from the town
  const rest = parts.slice(1)
    .filter(p => !COUNTRY.test(p))
    .map(p => p.split(/\s+/).filter(w => !ZIP.test(w)).join(' '))
    .filter(Boolean);
  // A unit line ("Apt 4", "#12") straight after the street is still the street.
  while (rest.length > 1 && /^(apt|apartment|unit|suite|ste|#)\b|^#?\d+[a-z]?$/i.test(rest[0])) rest.shift();
  return rest.length ? rest.join(', ') : null;
}

// One label per property, in order, safe to show the model: the town and state,
// or "Property N" when the address gives none. Labels that would collide (two
// homes in one town) get the property's position so they stay distinguishable.
export function propertyLabels(addresses: string[]): string[] {
  const base = addresses.map((a, i) => placeLabel(a ?? '') ?? `Property ${i + 1}`);
  return base.map((b, i) => (base.filter(x => x === b).length > 1 ? `${b} (property ${i + 1})` : b));
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Needs separators or brackets, so a plain amount or date is never mistaken for one.
const PHONE = /(?:\+?1[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}\b/g;
// Nine or more digits in a row is an account, card, routing or reference number.
const LONG_NUMBER = /\d{9,}/g;

// Mask contact details and long numbers inside free text (a transaction's
// description, payee, memo or merchant key; an account name). A long number keeps
// its last four digits so two accounts can still be told apart.
export function scrubText(text: string): string {
  if (!text) return text;
  return text.replace(EMAIL, '[email]').replace(PHONE, '[phone]').replace(LONG_NUMBER, m => `…${m.slice(-4)}`);
}

// scrubText applied to every string inside a JSON-like value, so a field nobody
// thought about (an account name nested in a tax-bucket list, say) is covered
// too. Ids are left alone: suggested changes refer to records by id, and an id
// that happens to be a long number must still match.
const ID_KEYS = new Set(['id', 'ruleId', 'account_id', 'accountId']);
export function scrubDeep<T>(value: T): T {
  if (typeof value === 'string') return scrubText(value) as unknown as T;
  if (Array.isArray(value)) return value.map(v => scrubDeep(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = ID_KEYS.has(k) ? v : scrubDeep(v);
    return out as T;
  }
  return value;
}

// Replaces each property's address (and its street line on its own) with the
// property's label, anywhere in a block of text or serialised JSON.
export function addressRedactor(addresses: string[]): (text: string) => string {
  const labels = propertyLabels(addresses);
  const pairs: [string, string][] = [];
  addresses.forEach((a, i) => {
    const full = (a ?? '').trim();
    if (full.length < 6) return;
    pairs.push([full, labels[i]]);
    const street = full.split(',')[0].trim();
    if (street.length >= 6 && street !== full) pairs.push([street, labels[i]]);
  });
  // JSON escapes quotes and backslashes, so match the escaped spelling as well.
  const needles = pairs.flatMap(([a, l]) => { const esc = JSON.stringify(a).slice(1, -1); return esc === a ? [[a, l]] : [[a, l], [esc, l]]; }) as [string, string][];
  return text => needles.reduce((t, [a, l]) => t.split(a).join(l), text);
}
