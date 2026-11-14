import { describe, it, expect } from 'vitest';
import { actionInstructions, forecastInstructions, reportInstructions, systemPrompt, REPORT_FILE } from './assistant.js';
import { ACTION_FENCE, ACTION_TYPES, ACCOUNT_CATEGORIES, FORECAST_FIELDS, parseAssistantAction } from '../shared/assistantAction.js';

// The chat prompt teaches the model how to PROPOSE a change. The example it shows
// must be one the shared validator accepts, every whitelisted action must be
// described (and nothing else), and the prompt must never suggest the model can
// change data itself.
describe('assistant action instructions', () => {
  const text = actionInstructions(['Groceries', 'Dining', 'Shopping']);

  it('shows an example block the validator accepts', () => {
    const m = new RegExp('```' + ACTION_FENCE + '\\n([\\s\\S]*?)\\n```').exec(text);
    expect(m).not.toBeNull();
    expect(parseAssistantAction(m![1]).ok).toBe(true);
  });

  it('describes every whitelisted action type and no other', () => {
    for (const t of ACTION_TYPES) expect(text).toContain(t);
    const named = new Set(text.match(/\b(?:set|recategorize|delete|add|remove|create|update)_[a-z_]+/g) ?? []);
    expect([...named].sort()).toEqual([...ACTION_TYPES].sort());
  });

  it('lists the user\'s categories and the account categories', () => {
    expect(text).toContain('Groceries, Dining, Shopping');
    expect(text).toContain(ACCOUNT_CATEGORIES.join(', '));
  });

  it('says the model cannot change data and the user decides', () => {
    expect(text).toMatch(/You cannot change the user's data/);
    expect(text).toMatch(/Nothing changes unless they click Apply/);
    expect(text).toMatch(/no way to delete/);
  });
});

describe('assistant forecast instructions', () => {
  const text = forecastInstructions(true);

  it('lists every forecast input the validator accepts, with its range', () => {
    for (const [field, spec] of Object.entries(FORECAST_FIELDS)) {
      expect(text).toContain(spec.kind === 'boolean' ? field : `${field} [${spec.min} to ${spec.max}]`);
    }
  });

  it('says rates are fractions and that the simulation cannot be run here', () => {
    expect(text).toMatch(/0\.07 means 7%/);
    expect(text).toMatch(/You cannot run it/);
    expect(text).toMatch(/not financial advice/);
  });

  it('says there is no plan when the browser sent none', () => {
    const none = forecastInstructions(false);
    expect(none).toMatch(/has not set up a forecast yet/);
    expect(none).not.toMatch(/forecast\.json holds/);
  });
});

describe('assistant report instructions', () => {
  it('points at the report file when there is one, with the tax caveat', () => {
    const text = reportInstructions(true);
    expect(text).toContain(REPORT_FILE);
    expect(text).toMatch(/general\s+information, not tax advice/);
  });

  it('says there is no report when none is stored', () => {
    const text = reportInstructions(false);
    expect(text).not.toContain(REPORT_FILE);
    expect(text).toMatch(/No report has been generated yet/);
  });
});

describe('systemPrompt', () => {
  it('always includes the action section, and the report section only in the report view', () => {
    const plain = systemPrompt('## Net worth', '- accounts.json', { categories: ['Groceries'] });
    expect(plain).toContain('# Proposing changes');
    expect(plain).toContain('# Forecasting');
    expect(plain).not.toContain('# The quarterly report');

    const report = systemPrompt('## Net worth', `- ${REPORT_FILE}`, { categories: ['Groceries'], reportOpen: true, hasReportFile: true });
    expect(report).toContain('# The quarterly report');
    expect(report.indexOf('# The quarterly report')).toBeLessThan(report.indexOf('# Current financial snapshot'));
  });

  it('needs no database: categories are passed in', () => {
    expect(systemPrompt('ctx')).toContain('(none set up yet)');
  });
});
