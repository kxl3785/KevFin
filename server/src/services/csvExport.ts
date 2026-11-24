import { getCategorizedTransactions, getCategoryLabeler, type BudgetTxn } from './budget.js';
import { getAllocation, type HoldingRow } from './allocation.js';
import { fetchHoldings, type Holding } from './simplefin.js';
import { effectiveChain } from './prices.js';
import { getNetWorthHistory } from './netWorth.js';
import { getDb } from '../db/schema.js';
import type { Snapshot } from '../shared/apiTypes.js';
import { txnRef, REF_HEADER } from '../shared/csvMapping.js';

// Plain CSV downloads of the user's own data (transactions, holdings, daily net
// worth) for use in a spreadsheet. Everything is assembled from what the app
// already shows and stays on this machine: the file goes straight back to the
// browser that asked for it.
//
// File conventions, chosen so the file opens cleanly in Excel / Numbers / Sheets:
//  - RFC 4180: fields holding a comma, a double quote or a line break are quoted,
//    quotes inside are doubled, rows end in CRLF.
//  - A UTF-8 byte-order mark up front, without which Excel guesses a legacy code
//    page and mangles accented merchant names ("Café" → "CafÃ©").
//  - ISO dates (YYYY-MM-DD) and plain numbers: no currency symbols or thousands
//    separators, so every spreadsheet reads them as numbers whatever its locale.
//  - Formula-injection guard: a TEXT cell that starts with = + - @ tab or CR is
//    prefixed with an apostrophe, so a merchant named "=HYPERLINK(...)" is shown
//    as text rather than run as a formula when the file is opened. Numeric cells
//    are written as numbers and never prefixed (a negative amount stays -12.5).

export const CSV_BOM = '﻿';

/** A cell: text (guarded and quoted as needed), a number, or blank. */
export type CsvCell = string | number | null | undefined;

const FORMULA_START = /^[=+\-@\t\r]/;

/** Prefix an apostrophe to text a spreadsheet would treat as a formula. */
export function guardText(s: string): string {
  return FORMULA_START.test(s) ? `'${s}` : s;
}

/**
 * A number as plain text: up to 6 decimals with trailing zeros dropped (so no
 * float noise like 0.30000000000000004 and never exponent notation for money-
 * sized values). Non-finite values become a blank cell rather than "NaN".
 */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '';
  const s = n.toFixed(6).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
}

/** One cell, encoded for a CSV line. */
export function csvField(v: CsvCell): string {
  if (v == null) return '';
  if (typeof v === 'number') return formatNumber(v);
  const s = guardText(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A whole file: byte-order mark, header row, data rows, CRLF line endings. */
export function toCsv(header: string[], rows: CsvCell[][]): string {
  const lines = [header, ...rows].map(r => r.map(csvField).join(','));
  return CSV_BOM + lines.join('\r\n') + '\r\n';
}

/** Round money to whole cents (drops float noise before it reaches the file). */
const cents = (n: number) => Math.round(n * 100) / 100;

/**
 * The dated download name, e.g. kevfin-transactions-2026-11-24.csv. The date is
 * the local calendar day (the server runs on the user's own machine), so an
 * evening download isn't named for tomorrow as the UTC date would be.
 */
export function csvFilename(kind: string, now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `kevfin-${kind}-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.csv`;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A YYYY-MM-DD filter value, or null when absent; throws on a malformed one. */
export function parseDayFilter(v: unknown, name: string): string | null {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || !ISO_DAY.test(v) || isNaN(Date.parse(v + 'T00:00:00Z'))
      || new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) !== v) {
    throw new RangeError(`${name} must be a date like 2025-01-31.`);
  }
  return v;
}

// --- Transactions ---------------------------------------------------------------

export const TRANSACTION_HEADER = ['Date', 'Merchant', 'Amount', 'Category', 'Account', REF_HEADER];

/**
 * Transactions as the Budget page shows them: the merged, de-duplicated ledger
 * (bank feeds + imports), with sign-reversal rules and amount edits applied, the
 * display merchant name and the category's display label. Transfers and card
 * payments are included (the Category column names them) since an export is a
 * record of everything, not the spending view. Oldest first; `from` / `to` are
 * inclusive YYYY-MM-DD bounds.
 *
 * The last column, KevFin ID, is a fingerprint of the transaction's id. Those
 * display values differ from what is stored (the bank's sign, the full
 * merchant text, the category's real name), so importing this file back could
 * not otherwise tell its rows from new ones; the import recognises each row by
 * its KevFin ID instead, and adds nothing (csvImport.ts).
 */
export function transactionsCsv(txns: Pick<BudgetTxn, 'id' | 'date' | 'payee' | 'amount' | 'category' | 'account' | 'postedAt'>[],
  opts: { from?: string | null; to?: string | null; label?: (c: string) => string } = {}): string {
  const label = opts.label ?? ((c: string) => c);
  const rows = txns
    .filter(t => (!opts.from || t.date >= opts.from) && (!opts.to || t.date <= opts.to))
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date) || a.postedAt - b.postedAt)
    .map(t => [t.date, t.payee, cents(t.amount), label(t.category), t.account, txnRef(t.id)] as CsvCell[]);
  return toCsv(TRANSACTION_HEADER, rows);
}

export async function exportTransactionsCsv(opts: { from?: string | null; to?: string | null }): Promise<string> {
  const lab = getCategoryLabeler();
  const txns = await getCategorizedTransactions();
  return transactionsCsv(txns, { ...opts, label: c => lab.label(c) });
}

// --- Holdings --------------------------------------------------------------------

export const HOLDINGS_HEADER = ['Symbol', 'Name', 'Account', 'Shares', 'Value', 'Cost basis', 'Asset class', 'Note'];

// Written beside a blank cost basis that is known for only part of a position.
export const PARTIAL_BASIS_NOTE = 'Cost basis known for only part of this position';

// The key allocation.ts aggregates a position under (display symbol, else the
// description), so raw lots can be matched back to their HoldingRow.
export function lotKey(h: Pick<Holding, 'symbol' | 'description'>): string {
  const displaySymbol = h.symbol || effectiveChain(h.symbol, h.description)[0] || '';
  return displaySymbol || h.description || 'Unknown';
}
const rowKey = (h: Pick<HoldingRow, 'symbol' | 'name'>) => h.symbol || h.name;
const sharesKey = (key: string, account: string) => `${key}\u0000${account}`;

/**
 * One line per position per account, as the Allocation page lists them. Shares
 * are summed from the account's lots (blank when the institution doesn't report
 * them). Cost basis is what the app resolved for the position (your entry, an
 * imported statement, the feed, or an estimate); when a position spans several
 * accounts, each account shows its own reported basis, or — for a basis entered
 * for the position as a whole — that basis split in proportion to value. Homes
 * and manually added assets have no account or share count.
 *
 * A basis the feed reports for only some lots (costBasisComplete false) is left
 * blank, with a note: next to the whole position's value it would overstate the
 * gain (Value − Cost basis), which the app works out on the covered part only.
 * Blank always means "not known", never 0.
 */
export function holdingsCsv(holdings: HoldingRow[], shares: Map<string, number>): string {
  const rows: CsvCell[][] = [];
  for (const h of holdings) {
    const partial = h.costBasis != null && !h.costBasisComplete;
    const note = partial ? PARTIAL_BASIS_NOTE : null;
    if (!h.accounts.length) {
      rows.push([h.symbol || null, h.name, null, null, cents(h.value), h.costBasis == null || partial ? null : cents(h.costBasis), h.assetClass, note]);
      continue;
    }
    const positionWide = h.costBasisSource === 'manual' || h.costBasisSource === 'imported' || h.costBasisSource === 'estimated';
    for (const a of h.accounts) {
      let basis: number | null;
      // Which account holds the uncovered lots isn't recorded, so a partial
      // basis is left out of every account's row.
      if (partial) basis = null;
      else if (h.accounts.length === 1) basis = h.costBasis;
      else if (positionWide && h.costBasis != null) basis = h.value > 0 ? h.costBasis * (a.value / h.value) : null;
      else basis = a.costBasis ?? null;
      const sh = shares.get(sharesKey(rowKey(h), a.name));
      rows.push([h.symbol || null, h.name, a.name, sh ?? null, cents(a.value), basis == null ? null : cents(basis), h.assetClass, note]);
    }
  }
  return toCsv(HOLDINGS_HEADER, rows);
}

/** Share counts per (position, account name), from the raw per-account lots. */
export function sharesByPosition(byAccount: Map<string, Holding[]>, accountName: Map<string, string>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [accId, lots] of byAccount) {
    const name = accountName.get(accId);
    if (name == null) continue;
    for (const lot of lots) {
      if (lot.shares == null) continue;
      const k = sharesKey(lotKey(lot), name);
      out.set(k, (out.get(k) ?? 0) + lot.shares);
    }
  }
  return out;
}

export async function exportHoldingsCsv(): Promise<string> {
  // Same account naming as getAllocation (the provider's name, brokerage only).
  const accts = getDb().prepare("SELECT id, name FROM accounts WHERE category = 'brokerage' AND hidden = 0").all() as { id: string; name: string }[];
  const [allocation, lots] = await Promise.all([getAllocation(), fetchHoldings()]);
  return holdingsCsv(allocation.holdings, sharesByPosition(lots, new Map(accts.map(a => [a.id, a.name]))));
}

// --- Net worth history ---------------------------------------------------------------

export const NET_WORTH_HEADER = ['Date', 'Accounts and other assets', 'Real estate equity', 'Net worth'];

/**
 * The daily net-worth history behind the Dashboard chart, oldest first. KevFin
 * stores each day as two parts — accounts plus manually added assets (credit-card
 * and loan balances already subtracted) and home equity (value minus mortgage) —
 * so those are the columns; a per-day split into total assets and total debts
 * isn't recorded and isn't invented here.
 */
export function netWorthCsv(history: Snapshot[]): string {
  const rows = history
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(s => [s.date, cents(s.accounts_total), cents(s.real_estate_total), cents(s.net_worth)] as CsvCell[]);
  return toCsv(NET_WORTH_HEADER, rows);
}

export function exportNetWorthCsv(): string {
  // getNetWorthHistory applies the same edge clean-up the chart does.
  return netWorthCsv(getNetWorthHistory(1_000_000));
}
