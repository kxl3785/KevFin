import { getDb } from '../db/schema.js';
import { validateAssistantAction, type AssistantAction } from '../shared/assistantAction.js';
import { getCategorizedTransactions, applyCategoryRule, setSignFlip, getSignFlipMatcher, setTxnAmount, type BudgetTxn } from './budget.js';
import { getActiveCategories, getCategoryLabeler } from './categories.js';
import { setManualAssetValue, setManualAssetCategory, setAccountCategory, setAccountHidden } from './assetEdits.js';
import { takeSnapshot } from './netWorth.js';

// Fixes the AI assistant proposes and the user applies with a click.
//
// The assistant can only describe a change (shared/assistantAction.ts); it has no
// tool that writes. This module is where a described change meets the database,
// and it is used twice for every card the user sees:
//   previewAction — "what would this do?": resolves the action against the live
//     data and returns the wording, the before and after values, and whether it
//     would change anything. The card shows THIS, not the model's own account of
//     the change.
//   applyAction — runs when the user clicks Apply. It trusts nothing it was sent:
//     it re-runs the shape check and the same resolution (ids must exist, the
//     category must be one the user already has), then makes the edit through
//     the same service functions the Budget and Dashboard screens call.
// Each action is one small, reversible edit. Nothing here deletes anything.

export class ActionError extends Error {}

export interface ActionPreview {
  title: string;   // what would change, in plain words
  before: string;  // the current value
  after: string;   // the value after applying
  detail?: string; // scope / side effects worth knowing before clicking
  noop: boolean;   // already in place — applying would change nothing
}

const fmtMoney = (n: number) =>
  (n < 0 ? '−' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const CATEGORY_LABEL: Record<string, string> = { banking: 'Banking', brokerage: 'Investments', credit: 'Credit', other: 'Other' };

// The stored merchant key for what the model wrote, or null if no transaction
// has it. Tried as written first (a stored key is cut at 40 characters and can
// end in a space), then normalised the way the categorizer builds keys.
function findMerchantKey(txns: BudgetTxn[], merchant: string): string | null {
  const keys = new Set(txns.map(t => t.merchant));
  const lower = merchant.toLowerCase();
  for (const candidate of [merchant, lower, lower.trim().slice(0, 40)]) if (keys.has(candidate)) return candidate;
  return null;
}

interface Resolved { preview: ActionPreview; run: () => Promise<string> | string }

// Check one shape-valid action against the database. Throws ActionError (with a
// message fit to show the user) when it does not match the data.
async function resolve(action: AssistantAction): Promise<Resolved> {
  switch (action.type) {
    case 'recategorize_merchant': {
      const txns = await getCategorizedTransactions();
      const key = findMerchantKey(txns, action.merchant);
      if (key === null) throw new ActionError(`There are no transactions from a merchant called “${action.merchant}”.`);
      const lab = getCategoryLabeler();
      const canon = lab.canon(action.category);
      // applyCategoryRule would quietly file an unknown category under
      // Miscellaneous; a proposal must name a category that already exists.
      if (!new Set(getActiveCategories()).has(canon)) throw new ActionError(`“${action.category}” is not one of your budget categories.`);
      const label = lab.label(canon);
      const mine = txns.filter(t => t.merchant === key);
      const current = [...new Set(mine.map(t => lab.label(t.category)))];
      const similar = action.scope === 'similar';
      return {
        preview: {
          title: `Move ${plural(mine.length, 'transaction')} from “${key.trim()}” to ${label}`,
          before: current.join(', '),
          after: label,
          detail: similar
            ? 'Also applies to similarly named merchants, and to future transactions from them.'
            : 'Sets a rule for this merchant, so future transactions from it follow too.',
          noop: !similar && current.length === 1 && current[0] === label,
        },
        run: async () => {
          const r = await applyCategoryRule(key, canon, similar ? 'all' : 'one');
          return `Moved ${plural(r.merchantTxns, 'transaction')} from “${key.trim()}” to ${label}` +
            (similar && r.similarTxns ? `, plus ${r.similarTxns} from ${plural(r.similarMerchants, 'similar merchant')}.` : '.');
        },
      };
    }

    case 'set_sign_flip': {
      const txns = await getCategorizedTransactions();
      const key = findMerchantKey(txns, action.merchant);
      if (key === null) throw new ActionError(`There are no transactions from a merchant called “${action.merchant}”.`);
      const count = txns.filter(t => t.merchant === key).length;
      const current = getSignFlipMatcher()(key);
      const words = (flipped: boolean) => (flipped ? 'Sign reversed (money in ↔ money out)' : 'Sign as the bank reports it');
      return {
        preview: {
          title: action.flipped
            ? `Reverse income/expense for ${plural(count, 'transaction')} from “${key.trim()}”`
            : `Stop reversing income/expense for ${plural(count, 'transaction')} from “${key.trim()}”`,
          before: words(current),
          after: words(action.flipped),
          detail: 'Applies to this merchant’s name variants and to future transactions.',
          noop: current === action.flipped,
        },
        run: () => {
          setSignFlip(key, action.flipped);
          return action.flipped
            ? `Reversed income/expense for transactions from “${key.trim()}”.`
            : `Transactions from “${key.trim()}” use the bank’s sign again.`;
        },
      };
    }

    case 'set_transaction_amount': {
      const txn = (await getCategorizedTransactions()).find(t => t.id === action.id);
      if (!txn) throw new ActionError('That transaction is not in your data.');
      const who = (txn.payee || txn.description || txn.merchant).trim();
      const currentAbs = Math.abs(txn.amount);
      return {
        preview: {
          title: `Change the amount of “${who}” on ${txn.date}`,
          before: fmtMoney(currentAbs),
          after: fmtMoney(action.amount),
          detail: `Stays ${txn.amount < 0 ? 'money out' : 'money in'}; only the size changes. The original amount can be restored from the transaction’s detail view.`,
          noop: Math.abs(currentAbs - action.amount) < 0.005,
        },
        run: () => {
          setTxnAmount(txn.id, action.amount);
          return `Changed “${who}” on ${txn.date} from ${fmtMoney(currentAbs)} to ${fmtMoney(action.amount)}.`;
        },
      };
    }

    case 'set_manual_asset_value':
    case 'set_manual_asset_category': {
      const row = getDb().prepare('SELECT id, name, category, value FROM manual_assets WHERE id = ?')
        .get(action.id) as { id: number; name: string; category: string; value: number } | undefined;
      if (!row) throw new ActionError('That manual asset is not in your data.');
      if (action.type === 'set_manual_asset_value') {
        return {
          preview: {
            title: `Change the value of “${row.name}”`,
            before: fmtMoney(row.value),
            after: fmtMoney(action.value),
            detail: 'Changes your net worth from today; earlier history is not rewritten.',
            noop: Math.abs(row.value - action.value) < 0.005,
          },
          run: () => {
            setManualAssetValue(row.id, action.value);
            takeSnapshot();
            return `Changed “${row.name}” from ${fmtMoney(row.value)} to ${fmtMoney(action.value)}.`;
          },
        };
      }
      return {
        preview: {
          title: `Change the category of “${row.name}”`,
          before: CATEGORY_LABEL[row.category] ?? row.category,
          after: CATEGORY_LABEL[action.category],
          noop: row.category === action.category,
        },
        run: () => {
          setManualAssetCategory(row.id, action.category);
          takeSnapshot();
          return `“${row.name}” is now under ${CATEGORY_LABEL[action.category]}.`;
        },
      };
    }

    case 'set_account_category':
    case 'set_account_hidden': {
      const row = getDb().prepare('SELECT id, COALESCE(custom_name, name) AS name, org_name, category, hidden, balance FROM accounts WHERE id = ?')
        .get(action.id) as { id: string; name: string; org_name: string; category: string; hidden: number; balance: number } | undefined;
      if (!row) throw new ActionError('That account is not in your data.');
      const who = `${row.name} (${row.org_name})`;
      if (action.type === 'set_account_category') {
        return {
          preview: {
            title: `Change the category of ${who}`,
            before: CATEGORY_LABEL[row.category] ?? row.category,
            after: CATEGORY_LABEL[action.category],
            noop: row.category === action.category,
          },
          run: () => {
            setAccountCategory(row.id, action.category);
            takeSnapshot();
            return `${who} is now under ${CATEGORY_LABEL[action.category]}.`;
          },
        };
      }
      const words = (hidden: boolean) => (hidden ? 'Hidden — left out of net worth' : 'Shown — counted in net worth');
      return {
        preview: {
          title: action.hidden ? `Hide ${who}` : `Show ${who} again`,
          before: words(!!row.hidden),
          after: words(action.hidden),
          detail: `Its balance is ${fmtMoney(row.balance)}. ${action.hidden ? 'Hiding' : 'Showing'} it changes your net worth from today; you can undo this under Financial Accounts.`,
          noop: !!row.hidden === action.hidden,
        },
        run: () => {
          setAccountHidden(row.id, action.hidden);
          takeSnapshot();
          return action.hidden ? `Hid ${who}; it no longer counts toward net worth.` : `${who} is shown again and counts toward net worth.`;
        },
      };
    }
  }
}

// Shape check first (never trust what was posted), then the database.
function parse(input: unknown): AssistantAction {
  const r = validateAssistantAction(input);
  if (!r.ok) throw new ActionError(`That change can’t be applied: ${r.error}.`);
  return r.action;
}

/** What one proposed action would do, checked against the live data. Changes nothing. */
export async function previewAction(input: unknown): Promise<ActionPreview> {
  return (await resolve(parse(input))).preview;
}

/** Apply one action the user approved. Returns a sentence saying what was done. */
export async function applyAction(input: unknown): Promise<{ done: string; changed: boolean }> {
  const { preview, run } = await resolve(parse(input));
  // Nothing to do (already applied, or the data moved on) — say so rather than
  // writing a redundant rule or snapshot.
  if (preview.noop) return { done: 'Already in place — nothing needed changing.', changed: false };
  return { done: await run(), changed: true };
}
