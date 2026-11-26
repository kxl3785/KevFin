// Which stock sightings are the same company. The stock look-through
// (services/allocation.ts) sees one company through many sources, each naming
// it its own way: Vanguard lists TSMC as "2330", a feeder's master N-PORT as
// "TSM" (a ticker the SEC name map supplied), a direct holding as whatever the
// brokerage feed says. Keyed by the symbol string alone, one company became
// several rows — and two companies that share a local exchange code ("BN" is
// Brookfield in Toronto and Danone in Paris) became one.
//
// So sightings are joined by identifiers, never by a guess from the name across
// different symbols. Links (union-find, so they chain):
//  R1  same ISIN, or same 9-character CUSIP. A US or CA ISIN holds the CUSIP
//      (characters 3–11), so a 13F row with only a CUSIP meets a fund row with
//      only the ISIN.
//  R2  same CUSIP issuer (its first 6 characters) — share classes of one
//      company: GOOGL/GOOG, BRK-A/BRK-B, FOXA/FOX. Only for sightings that are
//      not funds (every ETF of one trust shares an issuer number) and only for
//      equity issue numbers (two digits).
//  R3  same symbol, unless either side may be a local exchange code — then only
//      when their names agree. A sighting "may be local" when it carries an
//      ISIN from outside the US: its symbol may be an exchange code ("BN",
//      "1211") or a US ticker of a foreign-domiciled company (ACN, IE ISIN),
//      which the name check lets through.
// Pure and dependency-free so every rule can be unit-tested.

export interface Sighting {
  symbol: string;
  name: string;
  isin?: string;
  cusip?: string;
  named?: boolean;   // `symbol` is a normalized company name, not a ticker
  fund?: boolean;    // the row is itself a registered fund (opaque)
  weight: number;    // dollars behind this sighting
}

export interface Company {
  symbol: string;
  name: string;
  aliases: string[]; // the group's other real tickers, heaviest first
}

export interface Resolved {
  groupOf: number[];    // per sighting: index into `companies`
  companies: Company[]; // in order of each group's first sighting
}

// Canonical form of an issuer name so "Apple Inc." (SEC ticker file) matches
// "APPLE INC" (N-PORT): uppercase, punctuation stripped, legal-form suffixes
// and share-class markers dropped. Applied to BOTH sides of a comparison, so
// over-stripping is harmless as long as it's consistent.
export function normalizeIssuerName(name: string): string {
  return name
    .toUpperCase()
    .replace(/['’.]/g, '')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\b(THE|INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|PLC|LP|LLC|NV|SA|SE|AG|AB|ASA|SPA|OYJ|CLASS|CL|SHS|SHARES|ADR|ADS|COM|NEW|[ABC])\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Two names for the same company: equal once normalized, or the shorter (4+
// characters) starts the longer — Vanguard cuts names at 16 characters
// ("FIDELITY NATIONA", "SAMSUNG ELECTRON"), and one source may add a domicile
// ("ACCENTURE PLC IRELAND" against "ACCENTURE PLC-A").
export function namesAgree(a: string, b: string): boolean {
  const x = normalizeIssuerName(a), y = normalizeIssuerName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 4 && long.startsWith(short);
}

const cleanIsin = (s?: string) => {
  const v = (s ?? '').trim().toUpperCase();
  return /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(v) ? v : null;
};
const cleanCusip = (s?: string) => {
  const v = (s ?? '').trim().toUpperCase();
  return /^[A-Z0-9]{9}$/.test(v) ? v : null;
};

// The 9-character CUSIP a sighting carries, read from a US/CA ISIN when it
// has no CUSIP of its own.
export function cusipOf(s: { isin?: string; cusip?: string }): string | null {
  const c = cleanCusip(s.cusip);
  if (c) return c;
  const isin = cleanIsin(s.isin);
  return isin && /^(US|CA)/.test(isin) ? isin.slice(2, 11) : null;
}

// The symbol may be a foreign exchange code (see R3 above). A sighting with no
// ISIN (a direct holding, a 13F row, a Yahoo top holding) or a US one is taken
// at its word.
export function possiblyLocal(s: { isin?: string }): boolean {
  const isin = cleanIsin(s.isin);
  return !!isin && !isin.startsWith('US');
}

export function resolveCompanies(sightings: Sighting[]): Resolved {
  const n = sightings.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  // Join every sighting that carries `key` with the first one that did.
  const firstWith = new Map<string, number>();
  const link = (key: string, i: number) => {
    const j = firstWith.get(key);
    if (j === undefined) firstWith.set(key, i); else union(i, j);
  };

  const bySymbol = new Map<string, number[]>();
  sightings.forEach((s, i) => {
    // R1
    const isin = cleanIsin(s.isin);
    const cusip = cusipOf(s);
    if (isin) link(`isin:${isin}`, i);
    if (cusip) link(`cusip:${cusip}`, i);
    // R2: an equity issue number is two digits (letters mark debt and other
    // issues). FIS 31620M and FNF 31620R stay apart: the issuer is all six.
    if (cusip && !s.fund && /^\d\d$/.test(cusip.slice(6, 8))) link(`issuer:${cusip.slice(0, 6)}`, i);
    // R3 candidates. Tickers and name keys are kept apart, so a normalized
    // name can't meet a ticker that happens to be spelled the same.
    const sym = s.symbol.trim().toUpperCase();
    const key = `${s.named ? 'name' : 'tk'}:${sym}`;
    const list = bySymbol.get(key);
    if (list) list.push(i); else bySymbol.set(key, [i]);
  });

  // R3: within one symbol, the sightings taken at their word are one company;
  // one that may be a local code joins another only when their names agree.
  for (const list of bySymbol.values()) {
    if (list.length < 2) continue;
    const plain = list.filter(i => !possiblyLocal(sightings[i]));
    for (const i of plain.slice(1)) union(i, plain[0]);
    const local = list.filter(i => possiblyLocal(sightings[i]));
    for (const i of local) {
      for (const j of list) {
        if (j === i) continue;
        if (namesAgree(sightings[i].name, sightings[j].name)) union(i, j);
      }
    }
  }

  // Groups in order of first sighting.
  const groupOf = new Array<number>(n);
  const members: number[][] = [];
  const rootGroup = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let g = rootGroup.get(r);
    if (g === undefined) { g = members.length; rootGroup.set(r, g); members.push([]); }
    groupOf[i] = g;
    members[g].push(i);
  }
  return { groupOf, companies: members.map(m => display(m.map(i => sightings[i]))) };
}

// The row a group is shown as. Symbol: a real ticker over a name key; among
// tickers, one seen on a sighting taken at its word (a direct holding, a 13F
// row, a US ISIN) over a possible local code; then one starting with a letter
// over a numeric exchange code (TSM over 2330); then the heaviest; then
// alphabetical, so the answer never depends on the order sources arrive in.
// Name: from the heaviest sighting with that symbol.
function display(group: Sighting[]): Company {
  const real = group.filter(s => !s.named);
  const pool = real.length ? real : group;
  const stats = new Map<string, { weight: number; plain: boolean }>();
  for (const s of pool) {
    const sym = s.symbol.trim();
    const e = stats.get(sym) ?? { weight: 0, plain: false };
    e.weight += s.weight;
    if (!possiblyLocal(s)) e.plain = true;
    stats.set(sym, e);
  }
  const letter = (sym: string) => /^[A-Za-z]/.test(sym);
  const ranked = [...stats.entries()].sort(([a, x], [b, y]) =>
    (real.length ? Number(y.plain) - Number(x.plain) || Number(letter(b)) - Number(letter(a)) : 0)
    || y.weight - x.weight || (a < b ? -1 : a > b ? 1 : 0));
  const symbol = ranked[0][0];
  const named = pool.filter(s => s.symbol.trim() === symbol).sort((a, b) => b.weight - a.weight)[0];
  const aliases = real.length
    ? [...stats.entries()].filter(([sym]) => sym !== symbol)
      .sort(([a, x], [b, y]) => y.weight - x.weight || (a < b ? -1 : a > b ? 1 : 0)).map(([sym]) => sym)
    : [];
  return { symbol, name: named.name, aliases };
}
