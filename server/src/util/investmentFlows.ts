// Reading an investment account's own transactions: which ones are the owner
// moving money in or out (deposits / withdrawals — the "external flows" the
// contribution-aware returns remove), and which are the investments earning
// (dividends, interest, capital-gain distributions) or shuffling internally
// (buys, sells, reinvestment, sweeps, fees). Pure and dependency-free.
//
// Classification rules, checked IN THIS ORDER against payee + description +
// memo (case-insensitive); the first rule that matches wins. Security names
// carry income words too ("…HIGH DIVIDEND YIELD ETF", "PINTEREST INC"), so what
// the line DOES (sold, rolled over, transferred) is read before what it names:
//
//  1. Fee       — fee, margin interest, interest charged, foreign tax, ADR
//                 charge; also "advisory"/"commission" unless the line is a
//                 transfer ("TRANSFER FROM ADVISORY ACCOUNT" is money moving).
//                 Part of the investment result (a cost), never a flow. A
//                 positive fee line is a rebate.
//  2. Strong flow — contribution, employer match, rollover, ACATS / in-kind
//                 "transfer of assets": owner money even when shares, a dividend
//                 fund or the word "distribution" are named.
//  3. Trade action — bought/sold/buy/sell/purchase/redemption/exchange: a sale
//                 of a dividend fund is a trade, not income.
//  4. Income    — dividend, interest, capital gain, distribution, return of
//                 capital (whole words), with a POSITIVE amount — except a
//                 bare "distribution" from an IRA / 401(k) / plan / HSA / 529 /
//                 owner, which is money paid out to someone (→ flow rules).
//                 A NEGATIVE line with these words is the reinvestment buying
//                 shares with that income (→ trade) unless it says the payout
//                 went to a bank (→ flow rules), or for bare "interest", a
//                 charge (→ fee).
//  5. Trade     — reinvest/split/merger/spin-off/exercise/expired, share counts
//                 or "@ price", and cash sweeps (sweep, core position). Money
//                 changing shape inside the account, not a flow.
//  6. Flow      — contribution, deposit, transfer, ACH/EFT/wire, journal,
//                 rollover, Roth conversion, withdrawal, disbursement,
//                 distribution, check, employer match, payroll, loan
//                 repayment, tax withholding, required minimum distribution.
//                 Direction comes from the sign: + deposit, − withdrawal.
//  7. Anything else is ALSO counted as a deposit/withdrawal, flagged "guessed".
//     Erring this way keeps an unrecognised deposit from ever being reported as
//     investment gain; the user can switch any guessed line off.
//
// Bank accounts (savings, checking) only contribute INCOME, under a stricter
// rule of their own (classifyBankIncome below): a checking account is where
// salaries and IRA withdrawals land, so only interest / credit-union dividend
// wording counts there.
//
// Zero-amount lines are ignored entirely.

export type IncomeKind = 'dividend' | 'interest' | 'capitalGain';

export type TxnClass =
  | { kind: 'income'; income: IncomeKind }
  | { kind: 'trade' }
  | { kind: 'fee' }
  | { kind: 'flow'; basis: 'matched' | 'guessed' }
  | { kind: 'ignore' };

// Fee wording that means a cost wherever it appears.
const FEE_RE = /\bfees?\b|management charge|advisory charge|margin interest|interest charged?|foreign tax|adr charge/;
// Words that also turn up in account and program names ("…ADVISORY ACCOUNT"):
// a fee only when the line isn't moving money between accounts.
const SOFT_FEE_RE = /commission|advisory/;
const MOVE_RE = /transfer|\bxfer\b|\bach\b|\beft\b|\bwire\b|journal|\bjnl\b|moneylink|rollover|\bacats?\b/;
const STRONG_FLOW_RE = /contribution|\bcontrib|\bcontr\b|employer match|rollover|roll over|\bacats?\b|transfer of assets|\bin[- ]?kind\b/;
// What the line does, checked before income words that may only be part of a
// security's name. Verbs only — a share count ("DIVIDEND RECEIVED 100 SHARES")
// doesn't make an income line a trade.
const TRADE_ACTION_RE = /\b(bought|buys?|sold|sells?|purchased?|redemption|redeemed|exchanged?|exchanges)\b/;
const DIVIDEND_RE = /\bdividend|\bdivs?\b/;
const INTEREST_RE = /\binterests?\b/;
const CAP_GAIN_RE = /capital gain|cap\.? ?gain|\bcap gn\b|\b[ls]t ?cg\b/;
const DISTRIBUTION_RE = /\bdistributions?\b|return of capital/;
// A positive "distribution" that names a retirement / savings plan or an owner
// is that plan paying someone out — money arriving, not a fund's income.
const OWNER_DIST_RE = /\bira\b|\broth\b|\b401\s?\(?k\)?|\b403\s?\(?b\)?|\b457\b|\brmd\b|required minimum|retirement|pension|\b529\b|\bhsa\b|\bplan\b|\bowner\b|annuity/;
// A negative dividend line that says where the cash went: paid out, not reinvested.
const PAYOUT_RE = /\bto (your |my )?(bank|checking|savings)\b|transferred|\bach\b|\beft\b|\bwire\b|moneylink|\bcheck\b|withdraw/;
const TRADE_RE = /\b(bought|buy|sold|sell|purchased?|redemption|redeemed|reinvest\w*|exchanged?|exchanges|split|merger|spin-?off|exercised?|expired|assigned)\b|\bshares?\b|\bshs\b|@ ?\$?\d|\bsweep\b|core position|core account/;
const FLOW_RE = /contribution|\bcontrib|\bcontr\b|deposit|transfer|\bxfer\b|\bach\b|\beft\b|\bwire\b|journal|\bjnl\b|rollover|roll over|conversion|withdraw|disbursement|distribution|\bcheck\b|\bchk\b|moneylink|funds received|employer match|\bmatch\b|payroll|loan repayment|\bloan\b|tax withh|withholding|\bfed(eral)? tax|\bstate tax|\brmd\b|required minimum/;

const lineText = (t: { payee?: string; description?: string; memo?: string }) =>
  `${t.payee ?? ''} ${t.description ?? ''} ${t.memo ?? ''}`.toLowerCase();

export function classifyInvestmentTxn(t: { payee?: string; description?: string; memo?: string; amount: number }): TxnClass {
  if (!Number.isFinite(t.amount) || t.amount === 0) return { kind: 'ignore' };
  const text = lineText(t);

  if (FEE_RE.test(text) || (SOFT_FEE_RE.test(text) && !MOVE_RE.test(text))) return { kind: 'fee' };
  if (STRONG_FLOW_RE.test(text)) return { kind: 'flow', basis: 'matched' };
  if (TRADE_ACTION_RE.test(text)) return { kind: 'trade' };

  const dividend = DIVIDEND_RE.test(text);
  const interest = INTEREST_RE.test(text);
  const capGain = CAP_GAIN_RE.test(text);
  const distribution = DISTRIBUTION_RE.test(text);
  if (dividend || interest || capGain || distribution) {
    if (t.amount > 0) {
      // A positive "distribution" in an investment account is a fund paying
      // out — unless it names an IRA / plan / owner, which is someone being
      // paid from that plan (money arriving → the flow rules below).
      const ownerPayout = distribution && !dividend && !interest && !capGain && OWNER_DIST_RE.test(text);
      if (!ownerPayout) {
        const income: IncomeKind = capGain ? 'capitalGain' : interest && !dividend ? 'interest' : 'dividend';
        return { kind: 'income', income };
      }
    } else {
      // Negative: reinvesting a dividend/gain buys shares (internal), unless
      // the line says the cash went to a bank; a bare negative "interest" is
      // a charge; a negative "distribution" with no reinvest wording is the
      // owner taking money out — fall through to the flow rules.
      if (/reinvest/.test(text)) return { kind: 'trade' };
      if (dividend || capGain) { if (!PAYOUT_RE.test(text)) return { kind: 'trade' }; }
      else if (interest) return { kind: 'fee' };
    }
  }

  if (TRADE_RE.test(text)) return { kind: 'trade' };
  if (FLOW_RE.test(text)) return { kind: 'flow', basis: 'matched' };
  return { kind: 'flow', basis: 'guessed' };
}

// Bank-account income: interest, or a credit union's "dividend" on savings,
// with a positive amount. Never a "distribution" (an IRA / trust / owner
// payout landing in checking), and never a transfer or payroll line that
// merely names one ("PINTEREST INC PAYROLL", "INTEREST TRANSFER FROM CD" —
// the CD's own interest line already counts it).
const BANK_INCOME_RE = /\binterests?\b|\bint (paid|earned|credit|pymt|payment)\b|\bdividends?\b/;
const BANK_NOT_INCOME_RE = /distribution|payroll|direct dep|salary|\btransfer\b|\bxfer\b|zelle|venmo|\bfees?\b|interest charged?|refund/;

export function classifyBankIncome(t: { payee?: string; description?: string; memo?: string; amount: number }): IncomeKind | null {
  if (!Number.isFinite(t.amount) || t.amount <= 0) return null;
  const text = lineText(t);
  if (!BANK_INCOME_RE.test(text) || BANK_NOT_INCOME_RE.test(text)) return null;
  return /\bdividends?\b/.test(text) && !/\binterests?\b|\bint\b/.test(text) ? 'dividend' : 'interest';
}

export interface InvestmentTxn {
  id: string;
  accountId: string;
  date: string;      // 'YYYY-MM-DD'
  amount: number;    // + = money into the account
  payee: string;
  description: string;
  memo: string;
}

// The user's per-transaction choice, keyed by transaction id. Absent = default.
export type FlowOverride = 'include' | 'exclude';
export type FlowOverrides = Record<string, FlowOverride>;

/** Parse the stored overrides pref defensively (it's client-written JSON). */
export function parseFlowOverrides(raw: string | undefined | null): FlowOverrides {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: FlowOverrides = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val === 'include' || val === 'exclude') out[k] = val;
    }
    return out;
  } catch {
    return {};
  }
}

export interface DetectedFlow {
  id: string;
  accountId: string;
  date: string;
  amount: number;
  description: string;
  basis: 'matched' | 'guessed';
  included: boolean;     // after the user's override
  overridden: boolean;   // the user changed it from the default (included)
}

/** Every deposit/withdrawal among `txns`, with the user's include/exclude applied. */
export function detectFlows(txns: InvestmentTxn[], overrides: FlowOverrides): DetectedFlow[] {
  const out: DetectedFlow[] = [];
  for (const t of txns) {
    const c = classifyInvestmentTxn(t);
    if (c.kind !== 'flow') continue;
    const o = overrides[t.id];
    out.push({
      id: t.id,
      accountId: t.accountId,
      date: t.date,
      amount: t.amount,
      description: (t.description || t.payee || '').trim(),
      basis: c.basis,
      included: o !== 'exclude',
      overridden: o === 'exclude',
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

export interface IncomeMonth { month: string; dividends: number; interest: number; capitalGains: number; total: number }
export interface IncomeSummary {
  months: IncomeMonth[];                       // 12 complete months, oldest first
  from: string;                                // first day of the first month
  to: string;                                  // last day of the last month
  total: number;
  byAccount: { accountId: string; total: number }[];  // largest first, zero totals dropped
  nextTwelveMonths: number;                    // = total: the past year repeated, not a forecast
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function monthKey(year: number, month0: number): string {
  const d = new Date(Date.UTC(year, month0, 1));
  return d.toISOString().slice(0, 7);
}

/**
 * Dividend, interest and capital-gain income over the 12 COMPLETE calendar
 * months before `today`'s month (today = 2026-11-24 → Nov 2025 … Oct 2026), so
 * a half-finished month never drags the chart down. Income is every positive
 * line classified as income (see the rules above); lines from the accounts in
 * `bankAccountIds` use the stricter bank rule (classifyBankIncome).
 */
export function incomeSummary(
  txns: InvestmentTxn[],
  today: string,
  opts: { bankAccountIds?: ReadonlySet<string> } = {},
): IncomeSummary {
  const y = Number(today.slice(0, 4));
  const m0 = Number(today.slice(5, 7)) - 1;
  const keys: string[] = [];
  for (let k = 12; k >= 1; k--) keys.push(monthKey(y, m0 - k));
  const byMonth = new Map<string, IncomeMonth>(
    keys.map(k => [k, { month: k, dividends: 0, interest: 0, capitalGains: 0, total: 0 }]),
  );
  const byAcct = new Map<string, number>();

  for (const t of txns) {
    const row = byMonth.get(t.date.slice(0, 7));
    if (!row) continue;
    let kind: IncomeKind | null;
    if (opts.bankAccountIds?.has(t.accountId)) kind = classifyBankIncome(t);
    else {
      const c = classifyInvestmentTxn(t);
      kind = c.kind === 'income' ? c.income : null;
    }
    if (!kind) continue;
    if (kind === 'interest') row.interest += t.amount;
    else if (kind === 'capitalGain') row.capitalGains += t.amount;
    else row.dividends += t.amount;
    row.total += t.amount;
    byAcct.set(t.accountId, (byAcct.get(t.accountId) ?? 0) + t.amount);
  }

  const months = keys.map(k => {
    const r = byMonth.get(k)!;
    return { month: k, dividends: round2(r.dividends), interest: round2(r.interest), capitalGains: round2(r.capitalGains), total: round2(r.total) };
  });
  const total = round2(months.reduce((s, r) => s + r.total, 0));
  const lastMonthEnd = new Date(Date.UTC(y, m0, 0)).toISOString().slice(0, 10); // day 0 = last day of previous month
  return {
    months,
    from: `${keys[0]}-01`,
    to: lastMonthEnd,
    total,
    byAccount: [...byAcct.entries()]
      .map(([accountId, v]) => ({ accountId, total: round2(v) }))
      .filter(a => a.total !== 0)
      .sort((a, b) => b.total - a.total),
    nextTwelveMonths: total,
  };
}
