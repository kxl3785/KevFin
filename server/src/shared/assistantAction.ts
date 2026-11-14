// A change the AI assistant may PROPOSE in a chat answer, and its shape validator.
//
// The assistant has no way to change anything: its sandbox is read-only and stays
// that way. When the user asks it to fix something, it describes the fix as text
// (a fenced ```action block holding one JSON object, the same mechanism as
// ```chart blocks — see chartSpec.ts). The client shows that as a card; nothing
// happens until the user clicks Apply on it, and Apply sends this one action to
// the server, which validates it again against the database before doing it
// (services/assistantActions.ts).
//
// This module is only the first gate: is it one of the few known action types,
// with fields of the right type and size? Whether the ids exist, the category is
// a real one, and what the change would actually do is the server's job — the
// model's own description of an action is never shown as fact or trusted.
//
// Shared by both sides via the client's `@shared` alias, so it must stay
// dependency-free — no imports.

// The whitelist. Each is a single, reversible edit that an existing screen
// already offers; there is deliberately nothing here that deletes data, touches
// connections, keys or settings, or creates anything new.
export const ACTION_TYPES = [
  'recategorize_merchant',     // Budget: set a merchant's category (a merchant rule)
  'set_sign_flip',             // Budget: count a merchant's transactions with the opposite sign
  'set_transaction_amount',    // Budget: correct one transaction's amount
  'set_manual_asset_value',    // Dashboard: a manual asset's value
  'set_manual_asset_category', // Dashboard: a manual asset's category
  'set_account_category',      // Dashboard: a linked account's category
  'set_account_hidden',        // Dashboard: hide / show a linked account in net worth
] as const;
export type ActionType = typeof ACTION_TYPES[number];

// Account / manual-asset categories. Mirrors CATEGORIES in util/categorize.ts
// (a test keeps the two in step); restated here because this module cannot import.
export const ACCOUNT_CATEGORIES = ['banking', 'brokerage', 'credit', 'other'] as const;
export type AccountCategory = typeof ACCOUNT_CATEGORIES[number];

interface Base { reason?: string } // the model's one-line why; shown as a quote, never as fact

export type AssistantAction =
  | (Base & { type: 'recategorize_merchant'; merchant: string; category: string; scope: 'merchant' | 'similar' })
  | (Base & { type: 'set_sign_flip'; merchant: string; flipped: boolean })
  | (Base & { type: 'set_transaction_amount'; id: string; amount: number })
  | (Base & { type: 'set_manual_asset_value'; id: number; value: number })
  | (Base & { type: 'set_manual_asset_category'; id: number; category: AccountCategory })
  | (Base & { type: 'set_account_category'; id: string; category: AccountCategory })
  | (Base & { type: 'set_account_hidden'; id: string; hidden: boolean });

// The info string of the fenced block the model writes an action in.
export const ACTION_FENCE = 'action';

export const ACTION_LIMITS = {
  maxSpecChars: 2_000,           // raw JSON text of one action
  maxTextChars: 120,             // merchant, category
  maxIdChars: 200,               // transaction / account ids
  maxReasonChars: 240,
  maxTxnAmount: 10_000_000,      // a single transaction, in dollars
  maxAssetValue: 1_000_000_000,  // a manual asset (or liability, negative), in dollars
} as const;

export type ActionResult =
  | { ok: true; action: AssistantAction }
  | { ok: false; error: string };

const fail = (error: string): ActionResult => ({ ok: false, error });

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// A non-blank string within `max`. Returned untrimmed: a stored merchant key can
// legitimately end in a space (it is cut at 40 characters), and the server
// matches it against the database as written.
function str(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max ? v : null;
}
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isAccountCategory = (v: unknown): v is AccountCategory =>
  typeof v === 'string' && (ACCOUNT_CATEGORIES as readonly string[]).includes(v);

/**
 * Validate an already-parsed value as an action. Returns a freshly built object
 * holding only that action type's known fields — never the parsed input itself,
 * so an extra key (or a second action's fields smuggled alongside) cannot ride
 * through to the server.
 */
export function validateAssistantAction(input: unknown): ActionResult {
  if (!isPlainObject(input)) return fail('action must be a JSON object');
  const type = input.type;
  if (typeof type !== 'string' || !(ACTION_TYPES as readonly string[]).includes(type)) {
    return fail(`type must be one of ${ACTION_TYPES.join(', ')}`);
  }

  // Optional, but if present it must be a short string.
  let reason: string | undefined;
  if (input.reason !== undefined) {
    const r = str(input.reason, ACTION_LIMITS.maxReasonChars);
    if (r === null) return fail(`reason must be a string of at most ${ACTION_LIMITS.maxReasonChars} characters`);
    reason = r.trim();
  }
  const withReason = <T extends AssistantAction>(a: T): ActionResult =>
    ({ ok: true, action: reason === undefined ? a : { ...a, reason } });

  switch (type as ActionType) {
    case 'recategorize_merchant': {
      const merchant = str(input.merchant, ACTION_LIMITS.maxTextChars);
      if (merchant === null) return fail('merchant must be a non-empty string');
      const category = str(input.category, ACTION_LIMITS.maxTextChars);
      if (category === null) return fail('category must be a non-empty string');
      const scope = input.scope === undefined ? 'merchant' : input.scope;
      if (scope !== 'merchant' && scope !== 'similar') return fail('scope must be "merchant" or "similar"');
      return withReason({ type: 'recategorize_merchant', merchant, category: category.trim(), scope });
    }
    case 'set_sign_flip': {
      const merchant = str(input.merchant, ACTION_LIMITS.maxTextChars);
      if (merchant === null) return fail('merchant must be a non-empty string');
      if (typeof input.flipped !== 'boolean') return fail('flipped must be true or false');
      return withReason({ type: 'set_sign_flip', merchant, flipped: input.flipped });
    }
    case 'set_transaction_amount': {
      const id = str(input.id, ACTION_LIMITS.maxIdChars);
      if (id === null) return fail('id must be a transaction id');
      if (!finite(input.amount) || input.amount <= 0 || input.amount > ACTION_LIMITS.maxTxnAmount) {
        return fail(`amount must be a number above 0 and at most ${ACTION_LIMITS.maxTxnAmount}`);
      }
      return withReason({ type: 'set_transaction_amount', id, amount: input.amount });
    }
    case 'set_manual_asset_value': {
      if (!Number.isSafeInteger(input.id) || (input.id as number) <= 0) return fail('id must be a manual asset id');
      if (!finite(input.value) || Math.abs(input.value) > ACTION_LIMITS.maxAssetValue) {
        return fail(`value must be a number between ±${ACTION_LIMITS.maxAssetValue}`);
      }
      return withReason({ type: 'set_manual_asset_value', id: input.id as number, value: input.value });
    }
    case 'set_manual_asset_category': {
      if (!Number.isSafeInteger(input.id) || (input.id as number) <= 0) return fail('id must be a manual asset id');
      if (!isAccountCategory(input.category)) return fail(`category must be one of ${ACCOUNT_CATEGORIES.join(', ')}`);
      return withReason({ type: 'set_manual_asset_category', id: input.id as number, category: input.category });
    }
    case 'set_account_category': {
      const id = str(input.id, ACTION_LIMITS.maxIdChars);
      if (id === null) return fail('id must be an account id');
      if (!isAccountCategory(input.category)) return fail(`category must be one of ${ACCOUNT_CATEGORIES.join(', ')}`);
      return withReason({ type: 'set_account_category', id, category: input.category });
    }
    case 'set_account_hidden': {
      const id = str(input.id, ACTION_LIMITS.maxIdChars);
      if (id === null) return fail('id must be an account id');
      if (typeof input.hidden !== 'boolean') return fail('hidden must be true or false');
      return withReason({ type: 'set_account_hidden', id, hidden: input.hidden });
    }
  }
}

/** Parse and validate the raw text of one action (the body of an ```action block). */
export function parseAssistantAction(raw: string): ActionResult {
  if (typeof raw !== 'string') return fail('action must be text');
  if (raw.length > ACTION_LIMITS.maxSpecChars) return fail(`action is too large (max ${ACTION_LIMITS.maxSpecChars} characters)`);
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return fail('action is not valid JSON'); }
  return validateAssistantAction(parsed);
}
