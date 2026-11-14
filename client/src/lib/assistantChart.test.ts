import { describe, it, expect } from 'vitest';
import { splitMessage, fmtChartValue, fmtChartAxis, fmtShare } from './assistantChart.ts';

const SPEC = {
  type: 'bar', title: 'Spending by month', format: 'currency',
  labels: ['Aug', 'Sep', 'Oct'],
  series: [{ name: 'Spending', data: [4210, 3875, 4490] }],
};
const block = (body: unknown) => '```chart\n' + (typeof body === 'string' ? body : JSON.stringify(body)) + '\n```';

describe('splitMessage', () => {
  it('returns plain text untouched when there is no chart', () => {
    const text = 'Your net worth is $1,234.\n\n- one\n- two';
    expect(splitMessage(text)).toEqual([{ kind: 'text', text }]);
  });

  it('returns nothing for an empty message', () => {
    expect(splitMessage('')).toEqual([]);
  });

  it('splits text / chart / text and trims the blank lines around the block', () => {
    const parts = splitMessage(`Spending rose in October.\n\n${block(SPEC)}\n\nGroceries drove it.`);
    expect(parts).toEqual([
      { kind: 'text', text: 'Spending rose in October.' },
      { kind: 'chart', spec: SPEC },
      { kind: 'text', text: 'Groceries drove it.' },
    ]);
  });

  it('handles a message that is only a chart, pretty-printed JSON, and CRLF', () => {
    expect(splitMessage(block(SPEC))).toEqual([{ kind: 'chart', spec: SPEC }]);
    expect(splitMessage(block(JSON.stringify(SPEC, null, 2)))).toEqual([{ kind: 'chart', spec: SPEC }]);
    expect(splitMessage('Intro\r\n```chart\r\n' + JSON.stringify(SPEC) + '\r\n```\r\nOutro').map(p => p.kind))
      .toEqual(['text', 'chart', 'text']);
  });

  it('draws several charts in one message', () => {
    const pie = { type: 'donut', title: 'Allocation', format: 'percent', labels: ['Stocks', 'Bonds'], series: [{ name: 'Share', data: [80, 20] }] };
    const parts = splitMessage(`${block(SPEC)}\n\nAnd the mix:\n\n${block(pie)}`);
    expect(parts.map(p => p.kind)).toEqual(['chart', 'text', 'chart']);
  });

  it('keeps a block that is still streaming as plain text', () => {
    const partial = 'Here is the trend:\n\n```chart\n{"type":"line","title":"Net wor';
    expect(splitMessage(partial)).toEqual([{ kind: 'text', text: partial }]);
    // Complete JSON but no closing fence yet — still text.
    const unclosed = '```chart\n' + JSON.stringify(SPEC);
    expect(splitMessage(unclosed)).toEqual([{ kind: 'text', text: unclosed }]);
  });

  it('keeps a malformed block as plain text, fences and all', () => {
    const cases = [
      block('{"type":"bar", oops'),                                   // not JSON
      block({ ...SPEC, type: 'scatter' }),                            // unknown type
      block({ ...SPEC, series: [{ name: 'Spending', data: [1, 2] }] }), // ragged
      block(JSON.stringify(SPEC).replace('3875', '1e999')),           // Infinity
      block('<script>alert(1)</script>'),
    ];
    for (const bad of cases) {
      const msg = `Before.\n\n${bad}\n\nAfter.`;
      expect(splitMessage(msg)).toEqual([{ kind: 'text', text: msg }]);
    }
  });

  it('draws the valid chart and keeps the invalid one as text in the same message', () => {
    const bad = block({ ...SPEC, type: 'radar' });
    const parts = splitMessage(`${bad}\n\n${block(SPEC)}`);
    expect(parts).toEqual([
      { kind: 'text', text: bad },
      { kind: 'chart', spec: SPEC },
    ]);
  });

  it('ignores other fenced blocks and inline mentions of the fence', () => {
    const json = '```json\n' + JSON.stringify(SPEC) + '\n```';
    expect(splitMessage(json)).toEqual([{ kind: 'text', text: json }]);
    const inline = 'Write a ```chart block to draw one.';
    expect(splitMessage(inline)).toEqual([{ kind: 'text', text: inline }]);
    const indented = '  ```chart\n' + JSON.stringify(SPEC) + '\n```';
    expect(splitMessage(indented)).toEqual([{ kind: 'text', text: indented }]);
  });
});

describe('chart value formatting', () => {
  it('formats currency like the rest of the app', () => {
    expect(fmtChartValue(4210, 'currency')).toBe('$4,210');
    expect(fmtChartValue(-1234.4, 'currency')).toBe('−$1,234');
    expect(fmtChartValue(12.5, 'currency')).toBe('$12.50');
    expect(fmtChartAxis(15000, 'currency')).toBe('$15k');
    expect(fmtChartAxis(1_300_000, 'currency')).toBe('$1.3M');
  });

  it('treats percent values as already-scaled percentages', () => {
    expect(fmtChartValue(12.5, 'percent')).toBe('12.5%');
    expect(fmtChartValue(-3.256, 'percent')).toBe('−3.26%');
    expect(fmtChartAxis(40, 'percent')).toBe('40%');
  });

  it('formats plain numbers with separators and a true minus', () => {
    expect(fmtChartValue(1284, 'number')).toBe('1,284');
    expect(fmtChartValue(-0.5, 'number')).toBe('−0.5');
    expect(fmtChartAxis(950, 'number')).toBe('950');
    expect(fmtChartAxis(25000, 'number')).toBe('25k');
    expect(fmtChartAxis(-2_500_000, 'number')).toBe('−2.5M');
  });

  it('computes a slice share', () => {
    expect(fmtShare(25, 200)).toBe('12.5%');
    expect(fmtShare(1, 3)).toBe('33.3%');
    expect(fmtShare(5, 0)).toBe('0%');
  });
});

describe('splitMessage — action blocks', () => {
  const ACTION = { type: 'recategorize_merchant', merchant: 'blue bottle coffee', category: 'Dining', scope: 'merchant' };
  const act = (body: unknown) => '```action\n' + (typeof body === 'string' ? body : JSON.stringify(body)) + '\n```';

  it('turns a valid action block into a card part between the text', () => {
    expect(splitMessage(`That looks like a coffee shop.\n\n${act(ACTION)}\n\nApply it if you agree.`)).toEqual([
      { kind: 'text', text: 'That looks like a coffee shop.' },
      { kind: 'action', action: ACTION, index: 0 },
      { kind: 'text', text: 'Apply it if you agree.' },
    ]);
  });

  it('numbers the cards within a message and mixes with charts', () => {
    const hide = { type: 'set_account_hidden', id: 'ACT-9', hidden: true };
    const parts = splitMessage(`${act(ACTION)}\n\n${block(SPEC)}\n\n${act(hide)}`);
    expect(parts).toEqual([
      { kind: 'action', action: ACTION, index: 0 },
      { kind: 'chart', spec: SPEC },
      { kind: 'action', action: hide, index: 1 },
    ]);
  });

  it('keeps an unknown, malformed or still-streaming action as plain text', () => {
    const cases = [
      act({ type: 'delete_account', id: 'ACT-9' }),          // not on the whitelist
      act({ type: 'set_account_hidden', id: 'ACT-9' }),      // missing field
      act('{"type":"set_sign_flip", oops'),                  // not JSON
      act([ACTION, ACTION]),                                 // a batch
      '```action\n' + JSON.stringify(ACTION),                // no closing fence yet
    ];
    for (const bad of cases) {
      const msg = `Before.\n\n${bad}`;
      expect(splitMessage(msg)).toEqual([{ kind: 'text', text: msg }]);
    }
  });

  it('does not count a rejected action when numbering the valid ones', () => {
    const parts = splitMessage(`${act({ type: 'drop_tables' })}\n\n${act(ACTION)}`);
    expect(parts[parts.length - 1]).toEqual({ kind: 'action', action: ACTION, index: 0 });
  });
});
