import { describe, it, expect } from 'vitest';
import {
  validateAssistantAction, parseAssistantAction, ACTION_LIMITS, ACTION_TYPES, ACCOUNT_CATEGORIES,
  type AssistantAction,
} from './assistantAction.js';
import { CATEGORIES } from '../util/categorize.js';

const ok = (input: unknown): AssistantAction => {
  const r = validateAssistantAction(input);
  if (!r.ok) throw new Error(`expected a valid action, got: ${r.error}`);
  return r.action;
};
const bad = (input: unknown, match?: RegExp) => {
  const r = validateAssistantAction(input);
  expect(r.ok).toBe(false);
  if (!r.ok && match) expect(r.error).toMatch(match);
};

// One valid example per whitelisted type.
const VALID: Record<string, Record<string, unknown>> = {
  recategorize_merchant: { type: 'recategorize_merchant', merchant: 'blue bottle coffee', category: 'Dining', scope: 'merchant' },
  set_sign_flip: { type: 'set_sign_flip', merchant: 'venmo cashout', flipped: true },
  set_transaction_amount: { type: 'set_transaction_amount', id: 'TRN-123', amount: 42.5 },
  set_manual_asset_value: { type: 'set_manual_asset_value', id: 3, value: 18500 },
  set_manual_asset_category: { type: 'set_manual_asset_category', id: 3, category: 'other' },
  set_account_category: { type: 'set_account_category', id: 'ACT-9', category: 'brokerage' },
  set_account_hidden: { type: 'set_account_hidden', id: 'ACT-9', hidden: true },
};

describe('validateAssistantAction — the whitelist', () => {
  it('has an example for every action type, and accepts each', () => {
    expect(Object.keys(VALID).sort()).toEqual([...ACTION_TYPES].sort());
    for (const a of Object.values(VALID)) expect(ok(a)).toEqual(a);
  });

  it('rejects anything that is not a known type', () => {
    for (const type of ['delete_transaction', 'delete_account', 'set_key', 'run', 'sql', 'reset', '', undefined, 3, ['set_sign_flip']]) {
      bad({ ...VALID.set_sign_flip, type }, /type must be one of/);
    }
  });

  it('rejects non-objects', () => {
    for (const v of [null, undefined, 'set_sign_flip', 1, [], [VALID.set_sign_flip]]) bad(v, /JSON object/);
  });

  it('keeps the account categories in step with the server list', () => {
    expect([...ACCOUNT_CATEGORIES]).toEqual(CATEGORIES);
  });
});

describe('validateAssistantAction — returns only the known fields', () => {
  it('drops extra keys, including another action smuggled alongside', () => {
    const a = ok({ ...VALID.recategorize_merchant, id: 'TRN-1', amount: 5, hidden: true, sql: 'DROP TABLE accounts', __proto__: { x: 1 } });
    expect(Object.keys(a).sort()).toEqual(['category', 'merchant', 'scope', 'type']);
  });

  it('keeps a short reason and trims it', () => {
    expect(ok({ ...VALID.set_account_hidden, reason: '  Closed in March. ' })).toEqual({ ...VALID.set_account_hidden, reason: 'Closed in March.' });
    bad({ ...VALID.set_account_hidden, reason: 'x'.repeat(ACTION_LIMITS.maxReasonChars + 1) }, /reason/);
    bad({ ...VALID.set_account_hidden, reason: 42 }, /reason/);
  });

  it('defaults a recategorize scope to the one merchant', () => {
    const { scope: _s, ...noScope } = VALID.recategorize_merchant;
    expect(ok(noScope)).toMatchObject({ scope: 'merchant' });
    bad({ ...VALID.recategorize_merchant, scope: 'everything' }, /scope/);
  });

  it('does not trim a merchant key (a stored key can end in a space)', () => {
    const key = 'abcdefghi abcdefghi abcdefghi abcdefghi ';
    expect(ok({ ...VALID.set_sign_flip, merchant: key })).toMatchObject({ merchant: key });
  });
});

describe('validateAssistantAction — field checks', () => {
  it('requires non-empty, bounded text', () => {
    for (const merchant of ['', '   ', undefined, 7, null, 'x'.repeat(ACTION_LIMITS.maxTextChars + 1)]) {
      bad({ ...VALID.recategorize_merchant, merchant }, /merchant/);
      bad({ ...VALID.set_sign_flip, merchant }, /merchant/);
    }
    for (const category of ['', undefined, 7, 'x'.repeat(ACTION_LIMITS.maxTextChars + 1)]) {
      bad({ ...VALID.recategorize_merchant, category }, /category/);
    }
    for (const id of ['', undefined, 12, 'x'.repeat(ACTION_LIMITS.maxIdChars + 1)]) {
      bad({ ...VALID.set_transaction_amount, id }, /id/);
      bad({ ...VALID.set_account_category, id }, /id/);
      bad({ ...VALID.set_account_hidden, id }, /id/);
    }
  });

  it('requires real booleans', () => {
    for (const v of ['true', 1, 0, null, undefined]) {
      bad({ ...VALID.set_sign_flip, flipped: v }, /flipped/);
      bad({ ...VALID.set_account_hidden, hidden: v }, /hidden/);
    }
  });

  it('keeps a transaction amount finite, positive and in a sane range', () => {
    for (const amount of [0, -5, NaN, Infinity, '42', null, undefined, ACTION_LIMITS.maxTxnAmount + 1]) {
      bad({ ...VALID.set_transaction_amount, amount }, /amount/);
    }
    ok({ ...VALID.set_transaction_amount, amount: 0.01 });
    ok({ ...VALID.set_transaction_amount, amount: ACTION_LIMITS.maxTxnAmount });
  });

  it('keeps a manual asset value finite and in range, allowing liabilities', () => {
    for (const value of [NaN, Infinity, -Infinity, '100', null, undefined, ACTION_LIMITS.maxAssetValue + 1, -ACTION_LIMITS.maxAssetValue - 1]) {
      bad({ ...VALID.set_manual_asset_value, value }, /value/);
    }
    ok({ ...VALID.set_manual_asset_value, value: 0 });
    ok({ ...VALID.set_manual_asset_value, value: -24000 }); // a loan entered as a negative asset
  });

  it('requires a positive whole-number manual asset id', () => {
    for (const id of [0, -1, 1.5, '3', NaN, null, undefined, 2 ** 60]) {
      bad({ ...VALID.set_manual_asset_value, id }, /id/);
      bad({ ...VALID.set_manual_asset_category, id }, /id/);
    }
  });

  it('only accepts the four account categories', () => {
    for (const category of ['Groceries', 'retirement', 'BANKING', '', undefined, 1]) {
      bad({ ...VALID.set_account_category, category }, /category must be one of/);
      bad({ ...VALID.set_manual_asset_category, category }, /category must be one of/);
    }
    for (const category of ACCOUNT_CATEGORIES) ok({ ...VALID.set_account_category, category });
  });
});

describe('parseAssistantAction', () => {
  it('parses valid JSON text', () => {
    expect(parseAssistantAction(JSON.stringify(VALID.set_transaction_amount))).toEqual({ ok: true, action: VALID.set_transaction_amount });
  });

  it('rejects text that is not JSON, and non-strings', () => {
    for (const raw of ['', 'hide my old account', '{"type":"set_sign_flip",', "{'type':'set_sign_flip'}"]) {
      expect(parseAssistantAction(raw)).toEqual({ ok: false, error: 'action is not valid JSON' });
    }
    expect(parseAssistantAction(undefined as unknown as string).ok).toBe(false);
  });

  it('rejects a number JSON parses to Infinity', () => {
    const r = parseAssistantAction('{"type":"set_transaction_amount","id":"TRN-1","amount":1e999}');
    expect(r.ok).toBe(false);
  });

  it('rejects an oversized payload before parsing it', () => {
    const r = parseAssistantAction(JSON.stringify({ ...VALID.set_sign_flip, pad: 'x'.repeat(ACTION_LIMITS.maxSpecChars) }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/too large/);
  });

  it('rejects an array of actions — one action per block', () => {
    expect(parseAssistantAction(JSON.stringify([VALID.set_sign_flip, VALID.set_account_hidden])).ok).toBe(false);
  });
});
