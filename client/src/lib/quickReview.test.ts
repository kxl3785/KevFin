import { describe, it, expect } from 'vitest';
import { isTypingTarget, reviewApplyBody, reviewShortcut, typicalAmount } from './quickReview.ts';

const group = { merchant: 'blue bottle coffee', txns: [{ id: 'a' }, { id: 'b' }] };

describe('reviewApplyBody (one tap = one request)', () => {
  it('sends exactly the ticked conditions once they have loaded', () => {
    expect(reviewApplyBody(group, 'Coffee Shops', { status: 'ready', spec: { base: 'blue bottle', amount: 5.5 } }))
      .toEqual({ ids: ['a', 'b'], category: 'Coffee Shops', merchant: 'blue bottle coffee', rule: { base: 'blue bottle', amount: 5.5 } });
  });
  it('sends no rule when nothing is ticked, so only the listed charges change', () => {
    expect(reviewApplyBody(group, 'Coffee Shops', { status: 'ready', spec: {} }).rule).toBeNull();
  });
  it('falls back to the payee rule while conditions load or after they fail', () => {
    for (const status of ['loading', 'error', 'idle'] as const) {
      expect(reviewApplyBody(group, 'Coffee Shops', { status, spec: {} }).rule).toBe('payee');
    }
  });
});

describe('typicalAmount', () => {
  it('picks the repeating amount, the most recent on a tie', () => {
    expect(typicalAmount([{ amount: -7.25 }, { amount: -5.5 }, { amount: -5.5 }])).toBe(-5.5);
    expect(typicalAmount([{ amount: -7.25 }, { amount: -5.5 }])).toBe(-7.25);
    expect(typicalAmount([])).toBe(0);
  });
});

describe('reviewShortcut (keyboard guard)', () => {
  const ok = { busy: false, blocked: false, choices: 6 };
  const btn = { tagName: 'BUTTON', closest: () => null };
  it('maps 1–6 to the suggested categories and S to skip', () => {
    expect(reviewShortcut({ key: '1', target: btn }, ok)).toEqual({ pick: 0 });
    expect(reviewShortcut({ key: '6', target: btn }, ok)).toEqual({ pick: 5 });
    expect(reviewShortcut({ key: 's', target: btn }, ok)).toBe('skip');
    expect(reviewShortcut({ key: 'S', target: btn }, ok)).toBe('skip');
  });
  it('ignores keys past the shortlist and past 6', () => {
    expect(reviewShortcut({ key: '4', target: btn }, { ...ok, choices: 3 })).toBeNull();
    expect(reviewShortcut({ key: '7', target: btn }, { ...ok, choices: 8 })).toBeNull();
    expect(reviewShortcut({ key: 'x', target: btn }, ok)).toBeNull();
  });
  it('stays quiet mid-request, under another layer, with modifiers, or while typing', () => {
    expect(reviewShortcut({ key: '1', target: btn }, { ...ok, busy: true })).toBeNull();
    expect(reviewShortcut({ key: '1', target: btn }, { ...ok, blocked: true })).toBeNull();
    expect(reviewShortcut({ key: '1', target: btn, metaKey: true }, ok)).toBeNull();
    expect(reviewShortcut({ key: 's', target: btn, ctrlKey: true }, ok)).toBeNull();
    expect(reviewShortcut({ key: '1', target: btn, defaultPrevented: true }, ok)).toBeNull();
    expect(reviewShortcut({ key: '1', target: { tagName: 'INPUT' } }, ok)).toBeNull();
    expect(reviewShortcut({ key: 's', target: { tagName: 'textarea' } }, ok)).toBeNull();
    expect(reviewShortcut({ key: 's', target: { tagName: 'DIV', isContentEditable: true } }, ok)).toBeNull();
  });
  it('treats anything inside the category picker as typing', () => {
    const inPicker = { tagName: 'BUTTON', closest: (sel: string) => (sel === '[data-cat-popover]' ? {} : null) };
    expect(isTypingTarget(inPicker)).toBe(true);
    expect(isTypingTarget(btn)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
