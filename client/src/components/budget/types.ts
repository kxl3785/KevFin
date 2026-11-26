import type { PickerGroup } from '../CategoryPicker.tsx';
import type { TxnDetail } from '../TransactionDetail.tsx';
import { fmtTxnDate } from '../../lib/budgetUi.ts';

// Shapes of the /api/budget payload and the handlers the Budget page passes to
// its pieces (components/budget/*).

export interface BudgetTxn { id: string; date: string; amount: number; payee: string; account: string; merchant: string; category: string; suggested: string; description: string; memo: string; postedAt: number; transactedAt: number | null; flipped?: boolean; amountEdited?: boolean; ruleId?: number | null; ruleSource?: 'merchant' | 'smart' | 'base' | 'import' | 'manual' | 'auto' }
export interface CatRow { category: string; spent: number; count: number; target: number; period?: 'monthly' | 'annual'; ytdSpent?: number; excluded?: boolean }
// A category the server counts as a bill (server/src/util/bills.ts).
export interface BillCategory {
  category: string; recurringMonthly: number; typicalMonthly: number; share: number | null;
  items: { payee: string; monthlyAvg: number; annual: boolean }[];
}
export interface BudgetData {
  months: string[]; month: string; transactions: BudgetTxn[]; byCategory: CatRow[];
  needsReview: BudgetTxn[]; recent: BudgetTxn[]; income: number; spending: number; mortgage: number; totalBudget: number; categories: string[]; groups: PickerGroup[];
  // For the in-progress month the comparisons are measured through the same day (asOfDay).
  comparison: { priorMonth: number | null; priorYearAvg: number | null; priorYears: number[] };
  asOfDay: number | null; daysInMonth: number;
  dailyCumulative: { day: number; current: number | null; prior: number | null }[];
  importedCount: number;
  importedPending: number;
  bills?: { rule: string; categories: BillCategory[] };
}

export type Money = (n: number) => string;
export type RecatCtx = { payee: string; description: string; amount: number };
export type Recategorize = (merchant: string, category: string, ctx?: RecatCtx) => void;
// ctx is optional so pickers that only know the merchant (the cash-flow views)
// still fit; without it the toast and rule modal fall back to the merchant key.
export type CreateCategory = (merchant: string, name: string, ctx?: RecatCtx) => void;

// Map a transaction row to the shared detail-popup shape.
export const txnToDetail = (t: BudgetTxn): TxnDetail => ({
  id: t.id, amountEdited: t.amountEdited,
  payee: t.payee, merchant: t.merchant, amount: t.amount, category: t.category, account: t.account,
  date: t.date, postedAt: t.postedAt, transactedAt: t.transactedAt, description: t.description, memo: t.memo,
  suggested: t.suggested,
});

// The accessible name of a clickable transaction row: payee, amount (masked by
// `money` in privacy mode) and date, rather than just "Click for details".
export const txnRowLabel = (t: { payee: string; amount: number; date: string }, money: (n: number) => string) =>
  `${t.payee}, ${money(t.amount)}, ${fmtTxnDate(t.date)}. Open details`;

// Stop a click on an inner control (the category picker, a remove button) from
// also opening the row's detail popup.
export const stop = (e: React.MouseEvent) => e.stopPropagation();
