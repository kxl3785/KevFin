import { CHART_FENCE, parseChartSpec, type ChartFormat, type ChartSpec } from '@shared/chartSpec';
import { ACTION_FENCE, parseAssistantAction, type AssistantAction } from '@shared/assistantAction';
import { MINUS, fmtMoney, fmtMoneyCompact } from './format.ts';

// Splitting an assistant chat message into what to draw.
//
// Besides text, an answer can carry two kinds of fenced block, each holding one
// JSON object: ```chart (a chart to draw — server/src/shared/chartSpec.ts) and
// ```action (a change the assistant proposes, shown as a card the user may
// apply — server/src/shared/assistantAction.ts). Everything here is model
// output, so it is untrusted: a block becomes a chart or a card only if its body
// passes that block's shared validator. Anything else — a block that is still
// streaming in (no closing fence yet), broken JSON, an unknown chart or action
// type, a spec over the limits — stays in the message as the plain text it
// arrived as, so a bad block can never break the bubble or hide what the model
// wrote.

export type MessagePart =
  | { kind: 'text'; text: string }
  | { kind: 'chart'; spec: ChartSpec }
  // `index` counts the action cards within one message (0, 1, …); the chat keys
  // each card's applied / dismissed state by it.
  | { kind: 'action'; action: AssistantAction; index: number };

// An opening fence line, the body, then a closing fence on its own line. Only a
// closed block matches, which is what keeps a half-streamed one as text. A JSON
// string cannot contain a raw newline, so the lazy body can't end early on a
// "```" inside the spec.
const BLOCK = new RegExp('^```(' + CHART_FENCE + '|' + ACTION_FENCE + ')[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n```[ \\t]*$', 'gm');

export function splitMessage(content: string): MessagePart[] {
  const parts: MessagePart[] = [];
  // Text accumulates across rejected blocks so they read as one run of text.
  let pending = '';
  const flushText = (before: 'block' | 'end') => {
    // Drop the blank lines the model leaves around a block; a chart or card has
    // its own spacing. Text that is not next to one is left exactly as written.
    let t = pending;
    if (parts.length && parts[parts.length - 1].kind !== 'text') t = t.replace(/^\s*\n/, '');
    if (before === 'block') t = t.replace(/\n\s*$/, '');
    if (t.trim()) parts.push({ kind: 'text', text: t });
    pending = '';
  };

  let last = 0;
  let actions = 0;
  for (const m of content.matchAll(BLOCK)) {
    const start = m.index ?? 0;
    let part: MessagePart;
    if (m[1] === CHART_FENCE) {
      const parsed = parseChartSpec(m[2]);
      if (!parsed.ok) continue; // leave the whole block in the surrounding text
      part = { kind: 'chart', spec: parsed.spec };
    } else {
      const parsed = parseAssistantAction(m[2]);
      if (!parsed.ok) continue;
      part = { kind: 'action', action: parsed.action, index: actions++ };
    }
    pending += content.slice(last, start);
    flushText('block');
    parts.push(part);
    last = start + m[0].length;
  }
  pending += content.slice(last);
  flushText('end');
  return parts;
}

// --- value formatting ---------------------------------------------------------

const trimNum = (n: number, digits: number) =>
  n.toLocaleString('en-US', { maximumFractionDigits: digits });
// toLocaleString prints an ASCII hyphen; the app uses a true minus everywhere.
const withMinus = (s: string) => s.replace(/^-/, MINUS);

/** A value as shown in tooltips and the data table: "$4,210", "12.5%", "1,284". */
export function fmtChartValue(n: number, format: ChartFormat): string {
  if (format === 'currency') {
    // Whole dollars for totals; cents only when a small amount actually has them.
    return fmtMoney(n, { cents: Math.abs(n) < 1000 && !Number.isInteger(n) });
  }
  if (format === 'percent') return `${withMinus(trimNum(n, 2))}%`;
  return withMinus(trimNum(n, 2));
}

/** A compact value for axis ticks: "$15k", "40%", "1.2M". */
export function fmtChartAxis(n: number, format: ChartFormat): string {
  if (format === 'currency') return fmtMoneyCompact(n);
  if (format === 'percent') return `${withMinus(trimNum(n, 1))}%`;
  const abs = Math.abs(n);
  const sign = n < 0 ? MINUS : '';
  if (abs >= 1e6) return `${sign}${trimNum(abs / 1e6, 1)}M`;
  if (abs >= 1e4) return `${sign}${trimNum(abs / 1e3, 1)}k`;
  return withMinus(trimNum(n, 2));
}

/** A slice's share of the pie it is drawn in: "41.2%". `total` must be > 0. */
export function fmtShare(value: number, total: number): string {
  return total > 0 ? `${trimNum((value / total) * 100, 1)}%` : '0%';
}
