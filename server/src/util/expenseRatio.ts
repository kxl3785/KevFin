// Pure helpers for the fee check-up on the Allocation page: reading a fund's
// annual expense ratio out of a Yahoo quoteSummary result, deciding which ratio
// applies to a holding, and summing the portfolio's yearly fund costs. No I/O,
// so every rule here is unit-tested (expenseRatio.test.ts).
//
// Units: an expense ratio is always a FRACTION of the balance per year here —
// 0.0003 means 0.03% a year, i.e. $3 per $10,000.

// Highest ratio we accept, from Yahoo or from the user. Real fund fees sit far
// below this (index funds ~0.03%, active funds ~0.5–1%); anything larger is
// almost certainly a unit mix-up (a percent read as a fraction) or a typo.
export const MAX_EXPENSE_RATIO = 0.05;

export function isValidExpenseRatio(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= MAX_EXPENSE_RATIO;
}

// Yahoo wraps numbers as { raw, fmt }. `fmt` is the display string ("0.03%"),
// which is unambiguous about units but ROUNDED to two decimals of a percent:
// FXAIX's 0.015% shows as "0.01%", SPY's 0.0945% as "0.09%". `raw` carries the
// exact figure, but its units have not always been consistent across fields
// (netExpRatio has been seen carrying percent points, 0.03, where the
// annual-report field carries a fraction, 0.0003). So `raw` is the figure and
// `fmt` only settles its units:
//   f = fmt / 100 (a fraction, off by at most half a display step, 0.00005)
//   |raw − f| within that step       → raw is a fraction: use raw
//   |raw/100 − f| within that step   → raw is in percent points: use raw / 100
// Both can hold only when f is ~0 and raw is tiny; the fraction reading wins.
// When raw matches neither, the display string is used. Without a usable fmt,
// raw is trusted only when the caller says that field is a fraction.
type YahooNum = { raw?: unknown; fmt?: unknown } | null | undefined;

// Half of fmt's 0.01-percent display step, plus a hair of float slack
// (0.00015 − 0.0001 is 5.000000000000001e-5 in floating point).
const FMT_SLACK = 0.00005 + 1e-9;

export function readRatioField(field: YahooNum, rawIsFraction: boolean): number | null {
  if (!field || typeof field !== 'object') return null;
  const raw = typeof field.raw === 'number' && Number.isFinite(field.raw) ? field.raw : null;
  const m = typeof field.fmt === 'string' ? field.fmt.trim().match(/^(-?\d+(?:\.\d+)?)\s*%$/) : null;
  if (m) {
    const f = Number(m[1]) / 100;
    if (raw != null) {
      if (Math.abs(raw - f) <= FMT_SLACK) return raw;
      if (Math.abs(raw / 100 - f) <= FMT_SLACK) return raw / 100;
    }
    return f;
  }
  if (rawIsFraction && raw != null) return raw;
  return null;
}

// The fund's net annual expense ratio from a quoteSummary `result[0]` fetched
// with modules=fundProfile,defaultKeyStatistics. Candidates in order of
// preference: the net ratio (after fee waivers — what holders actually pay),
// then the annual-report ratio from either module. The first POSITIVE in-range
// value wins; an explicit 0 is accepted only when no candidate is positive (a
// few funds really are free, e.g. FZROX, but a stray 0 must not mask a real
// figure from another field). Returns null when Yahoo has no usable figure —
// the caller reports that as "unknown", never as zero.
export function extractExpenseRatio(result: unknown): number | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as {
    fundProfile?: { feesExpensesInvestment?: { netExpRatio?: YahooNum; annualReportExpenseRatio?: YahooNum } };
    defaultKeyStatistics?: { annualReportExpenseRatio?: YahooNum };
  };
  const fees = r.fundProfile?.feesExpensesInvestment;
  const candidates = [
    readRatioField(fees?.netExpRatio, false),
    readRatioField(fees?.annualReportExpenseRatio, true),
    readRatioField(r.defaultKeyStatistics?.annualReportExpenseRatio, true),
  ].filter(isValidExpenseRatio);
  return candidates.find(c => c > 0) ?? (candidates.length ? 0 : null);
}

// Where a holding's ratio came from, shown next to the figure.
//  manual   — entered by the user (always wins)
//  provider — looked up from fund data
//  stock    — a single company's shares: no fund fee
//  not-fund — another non-fund security (a coin, an option, a Treasury bill
//             held by CUSIP): no fund fee
//  cash     — uninvested cash: no fund fee
//  unknown  — a fund with no figure; left out of the weighted ratio
export type ExpenseSource = 'manual' | 'provider' | 'stock' | 'not-fund' | 'cash' | 'unknown';

// For a 'provider' row, which provider answered: Yahoo's fund data, or the
// fund's own SEC shareholder report (N-CSR/N-CSRS) when Yahoo had none.
export type FeeProvider = 'yahoo' | 'sec';

// Untickered rows that are plain cash (a sweep or "Cash" line). A money-market
// FUND with a ticker (SPAXX, VMFXX) is a fund and is looked up like one — those
// do charge a fee.
export function looksLikeCash(symbol: string, name: string): boolean {
  const s = symbol.trim().toUpperCase();
  if (s === 'CASH' || s === 'USD' || s === '$CASH' || s === 'CUR:USD') return true;
  if (s) return false;
  return /^\s*(cash|usd|us dollar|cash balance|cash & cash investments|cash and sweep|sweep|core position|pending activity)\b/i.test(name)
    || /\bcash sweep\b|\bsweep (account|program|deposit)\b|\bbank sweep\b/i.test(name);
}

// Security types (Yahoo quoteType) that are not funds and so charge no fund fee.
const NON_FUND_TYPES = new Set(['EQUITY', 'CRYPTOCURRENCY', 'OPTION', 'FUTURE', 'CURRENCY', 'INDEX']);

export interface RatioInput {
  symbol: string;
  name: string;
  quoteType: string | null;          // from yahooMeta; null when unknown
  override: number | null | undefined; // the user's figure for this holding, if any
  assetClass?: string;               // the allocation's class for the holding, when known
}

// Securities with a ticker-like identifier that are not funds and that Yahoo
// usually doesn't know (so their quoteType comes back null): options, and
// individual Treasuries, bonds and CDs reported by CUSIP. Sending them for a
// fund-fee lookup only ends in "Unknown", and asks the user for a fund's fact
// sheet for something that has none. Ticker-shaped money-market funds (SPAXX,
// VMFXX) do charge a fee and are NOT caught here.
//  - the allocation already classed it as Options;
//  - a broker-style option symbol: optional '-', root, YYMMDD, C/P, strike
//    ("-AAPL250117C150", "AAPL  250117C00150000");
//  - a 9-character CUSIP (3 digits, 5 digits/letters, a check digit) whose
//    name reads like a bill, note, bond or CD (or a coupon and maturity date),
//    or that the allocation put in Bonds or Short Term — but never when the
//    name reads like a fund: workplace plans report some funds and collective
//    trusts by CUSIP too, and those do charge a fee.
const OPTION_SYMBOL = /^-?[A-Z]{1,6}\s*\d{6}[CP]\d+(\.\d+)?$/;
const CUSIP = /^[0-9]{3}[0-9A-Z]{5}[0-9]$/;
const DEBT_NAME = /\b(treas(ury)?|t-?bills?|bills?|notes?|bonds?|strips?|cds?|certificates? of deposit|debentures?)\b/i;
const COUPON_MATURITY = /\d(\.\d+)?\s*%.*\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/;
const FUND_NAME = /\b(fund|funds|trust|index|portfolio|etf|collective|cit|stable value|target|class|shares)\b/i;

export function looksLikeNonFundSecurity(symbol: string, name: string, assetClass?: string): boolean {
  if (assetClass === 'Options') return true;
  const s = symbol.trim().toUpperCase();
  if (!s) return false;
  if (OPTION_SYMBOL.test(s)) return true;
  if (!CUSIP.test(s) || FUND_NAME.test(name)) return false;
  return DEBT_NAME.test(name) || COUPON_MATURITY.test(name) || assetClass === 'Bonds' || assetClass === 'Short Term';
}

// Decide a holding's ratio WITHOUT a network lookup. Returns `lookup: true` when
// the holding is (or might be) a fund with a ticker, so the caller should ask
// for its published ratio; otherwise the answer is final.
export function classifyRatio(h: RatioInput): { ratio: number | null; source: ExpenseSource; lookup: boolean } {
  if (isValidExpenseRatio(h.override)) return { ratio: h.override, source: 'manual', lookup: false };
  if (looksLikeCash(h.symbol, h.name)) return { ratio: 0, source: 'cash', lookup: false };
  if (looksLikeNonFundSecurity(h.symbol, h.name, h.assetClass)) return { ratio: 0, source: 'not-fund', lookup: false };
  const qt = (h.quoteType ?? '').toUpperCase();
  if (qt === 'EQUITY') return { ratio: 0, source: 'stock', lookup: false };
  if (NON_FUND_TYPES.has(qt)) return { ratio: 0, source: 'not-fund', lookup: false };
  // A fund (ETF / MUTUALFUND / MONEYMARKET) or a ticker whose type we couldn't
  // learn: look it up. Untickered funds (e.g. 529 portfolios) can't be looked up
  // — a proxy ETF's fee is not the plan's fee — so they stay unknown until the
  // user enters a figure.
  if (h.symbol.trim()) return { ratio: null, source: 'unknown', lookup: true };
  return { ratio: null, source: 'unknown', lookup: false };
}

export interface FeeRow {
  id: string;            // holdingId: the symbol, or the name when untickered (override key)
  symbol: string;
  name: string;
  value: number;
  expenseRatio: number | null;
  source: ExpenseSource;
  provider?: FeeProvider;    // set only when source is 'provider'
  asOf?: string;             // SEC figures: the report's period end (YYYY-MM-DD)
  annualCost: number | null; // value × ratio, null when the ratio is unknown
}

export interface FeeSummary {
  rows: FeeRow[];               // sorted by annual cost, largest first; unknowns last (by value)
  totalValue: number;           // all listed holdings
  coveredValue: number;         // holdings with a known ratio (stocks and cash count, at 0)
  coverage: number;             // coveredValue / totalValue, 0..1 (0 when there's nothing)
  weightedRatio: number | null; // value-weighted ratio over covered holdings; null when none
  totalAnnualCost: number;      // Σ value × ratio over covered holdings
  unknownCount: number;
  largestId: string | null;     // the row costing the most per year, when any costs > 0
}

// Value-weighted expense ratio and the yearly cost it implies.
//   weightedRatio = Σ(value × ratio) / Σ value, over holdings with a known ratio
// so a $90k fund at 0.03% and a $10k fund at 1% weigh in at
//   (90,000×0.0003 + 10,000×0.01) / 100,000 = (27 + 100) / 100,000 = 0.127%.
// Holdings worth ≤ 0 (a short position, a negative cash line) are dropped: they
// carry no fund fee and would only distort the weights.
export function summarizeFees(input: Omit<FeeRow, 'annualCost'>[]): FeeSummary {
  const rows: FeeRow[] = input
    .filter(r => Number.isFinite(r.value) && r.value > 0)
    .map(r => {
      const ratio = isValidExpenseRatio(r.expenseRatio) ? r.expenseRatio : null;
      if (ratio == null) {
        const { provider: _p, asOf: _a, ...rest } = r; // no figure: nothing to attribute
        return { ...rest, expenseRatio: null, source: 'unknown' as const, annualCost: null };
      }
      return { ...r, expenseRatio: ratio, annualCost: r.value * ratio };
    });
  const totalValue = rows.reduce((s, r) => s + r.value, 0);
  const known = rows.filter(r => r.expenseRatio != null);
  const coveredValue = known.reduce((s, r) => s + r.value, 0);
  const totalAnnualCost = known.reduce((s, r) => s + (r.annualCost ?? 0), 0);
  rows.sort((a, b) => {
    if (a.annualCost == null && b.annualCost == null) return b.value - a.value;
    if (a.annualCost == null) return 1;
    if (b.annualCost == null) return -1;
    return b.annualCost - a.annualCost || b.value - a.value;
  });
  const top = rows[0];
  return {
    rows,
    totalValue,
    coveredValue,
    coverage: totalValue > 0 ? coveredValue / totalValue : 0,
    weightedRatio: coveredValue > 0 ? totalAnnualCost / coveredValue : null,
    totalAnnualCost,
    unknownCount: rows.length - known.length,
    largestId: top && top.annualCost != null && top.annualCost > 0 ? top.id : null,
  };
}

// Parse the stored overrides map ({ holdingId: ratio }) defensively: the pref is
// a JSON string that could be hand-edited or written by an older version.
export function parseOverrides(raw: string | null | undefined): Record<string, number> {
  if (!raw) return {};
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return {}; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, number> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (k.trim() && isValidExpenseRatio(x)) out[k] = x;
  return out;
}

// Validate the PUT /api/allocation/expense-ratio body: { symbol, expenseRatio }.
// The ratio is a FRACTION (0.0003 = 0.03%/yr) from 0 to 5%; null, undefined or
// a blank string clears the user's figure. Numbers or numeric strings only —
// Number(true) is 1 and Number([]) is 0, so other types are refused outright.
export function parseExpenseRatioBody(body: unknown):
  { id: string; ratio: number | null } | { error: string } {
  const b = (body && typeof body === 'object' ? body : {}) as { symbol?: unknown; expenseRatio?: unknown };
  const id = typeof b.symbol === 'string' ? b.symbol.trim() : '';
  if (!id || id.length > 200) return { error: 'symbol required' };
  const raw = b.expenseRatio;
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) return { id, ratio: null };
  const ratio = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN;
  if (!isValidExpenseRatio(ratio)) return { error: 'expense ratio must be between 0% and 5%' };
  return { id, ratio };
}
