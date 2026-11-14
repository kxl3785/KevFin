import { describe, it, expect } from 'vitest';
import { chartInstructions, systemPrompt } from './assistant.js';
import { CHART_FENCE, CHART_LIMITS, CHART_TYPES, parseChartSpec } from '../shared/chartSpec.js';

// The chat prompt teaches the model the chart format by example, and the client
// only draws what passes the shared validator — so the example the prompt shows
// has to be one the validator accepts, and the limits it quotes have to be the
// validator's own.
describe('assistant chart instructions', () => {
  const text = chartInstructions();

  it('shows an example block the validator accepts', () => {
    const m = new RegExp('```' + CHART_FENCE + '\\n([\\s\\S]*?)\\n```').exec(text);
    expect(m).not.toBeNull();
    const r = parseChartSpec(m![1]);
    expect(r.ok).toBe(true);
  });

  it('names every chart type and quotes the validator limits', () => {
    for (const t of CHART_TYPES) expect(text).toContain(t);
    expect(text).toContain(`At most ${CHART_LIMITS.maxPoints}`);
    expect(text).toContain(`at most ${CHART_LIMITS.maxSlices} for pie/donut`);
    expect(text).toContain(`series: at most ${CHART_LIMITS.maxSeries}`);
  });

  it('requires figures to come from the supplied data', () => {
    expect(text).toMatch(/must come from the snapshot or the data files/);
    expect(text).toMatch(/never estimate, interpolate or invent/);
  });

  it('is part of the chat system prompt, ahead of the snapshot', () => {
    const prompt = systemPrompt('## Net worth\n- Net worth: $1', '- accounts.json — accounts');
    expect(prompt).toContain(text);
    expect(prompt.indexOf('# Charts')).toBeLessThan(prompt.indexOf('# Current financial snapshot'));
    expect(prompt).toContain('# Detailed data files');
  });
});
