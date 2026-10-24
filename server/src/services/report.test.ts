import { describe, it, expect } from 'vitest';
import { parseAdvisory, savingsNote, buildSignals, deterministicNote, buildAdvisorySystemPrompt } from './report.js';
import { renderReportHtml, type ReportModel } from './reportTemplate.js';
import { getReportWindow } from '../util/reportWindow.js';

describe('parseAdvisory', () => {
  const full = JSON.stringify({
    note: 'A solid quarter.\n\nStay the course.',
    marketView: ['Rates likely ease into 2027.', 'Equity leadership should broaden.'],
    taxActions: [
      { action: 'Optimize asset location', why: 'Put bonds in pre-tax accounts.' },
      { action: 'Harvest losses', why: 'Offset gains in the taxable brokerage.' },
    ],
    estateActions: [
      { action: 'Fund a revocable living trust', why: 'Keeps real estate out of probate.' },
      { action: 'Refresh beneficiary designations', why: 'They override the will on retirement accounts.' },
    ],
  });

  it('parses a clean JSON object', () => {
    const a = parseAdvisory(full);
    expect(a?.note).toContain('solid quarter');
    expect(a?.marketView).toHaveLength(2);
    expect(a?.taxActions?.[0].action).toBe('Optimize asset location');
    expect(a?.estateActions).toHaveLength(2);
    expect(a?.estateActions?.[0].action).toBe('Fund a revocable living trust');
  });

  it('keeps up to six market-view bullets and drops the rest', () => {
    const many = Array.from({ length: 8 }, (_, i) => `Outlook point ${i + 1}.`);
    const a = parseAdvisory(JSON.stringify({ note: 'ok', marketView: many }));
    expect(a?.marketView).toHaveLength(6);
    expect(a?.marketView?.[0]).toBe('Outlook point 1.');
  });

  it('drops malformed estate-action entries', () => {
    const a = parseAdvisory(JSON.stringify({
      note: 'ok',
      estateActions: [{ action: 'Set up POA', why: 'Names a decision-maker.' }, { action: 'no why' }, 42],
    }));
    expect(a?.estateActions).toEqual([{ action: 'Set up POA', why: 'Names a decision-maker.' }]);
  });

  it('returns an advisory when only estate actions are present', () => {
    const a = parseAdvisory(JSON.stringify({
      estateActions: [{ action: 'Draft a will', why: 'Directs your assets.' }],
    }));
    expect(a?.estateActions).toHaveLength(1);
    expect(a?.note).toBeUndefined();
  });

  it('unwraps a ```json fenced block', () => {
    const a = parseAdvisory('Here you go:\n```json\n' + full + '\n```\nHope that helps!');
    expect(a?.marketView).toHaveLength(2);
    expect(a?.taxActions).toHaveLength(2);
  });

  it('extracts JSON embedded in surrounding prose', () => {
    const a = parseAdvisory('Sure — ' + full + ' Let me know.');
    expect(a?.note).toBeTruthy();
  });

  it('drops malformed tax-action entries and non-string bullets', () => {
    const a = parseAdvisory(JSON.stringify({
      note: 'ok',
      marketView: ['good', 42, '', '  spaced  '],
      taxActions: [{ action: 'keep', why: 'valid' }, { action: 'no why' }, 'nope'],
    }));
    expect(a?.marketView).toEqual(['good', 'spaced']);
    expect(a?.taxActions).toEqual([{ action: 'keep', why: 'valid' }]);
  });

  it('returns a note-only advisory when the other keys are absent', () => {
    const a = parseAdvisory(JSON.stringify({ note: 'just a note' }));
    expect(a).toEqual({ note: 'just a note' });
    expect(a?.marketView).toBeUndefined();
  });

  it('returns null for junk or empty content', () => {
    expect(parseAdvisory('not json at all')).toBeNull();
    expect(parseAdvisory('')).toBeNull();
    expect(parseAdvisory('{}')).toBeNull();
    expect(parseAdvisory('{ broken')).toBeNull();
  });
});

describe('savings wording', () => {
  it('says "kept" for a positive savings rate', () => {
    expect(savingsNote(0.25)).toBe('You kept 25% of what you earned this quarter.');
  });
  it('says "spent more than you earned" for a negative rate', () => {
    expect(savingsNote(-0.15)).toBe('You spent 15% more than you earned this quarter.');
  });
  it('uses the same wording in the savings-rate signal and drops cash-flow signals when unavailable', () => {
    const sig = buildSignals(10000, { spending: 3000, savingsRate: -0.15, status: 'ok' }, null)
      .find(s => s.label === 'Savings rate')!;
    expect(sig.note).toContain('spent 15% more');
    expect(sig.tag).toBe('Negative');
    expect(buildSignals(10000, { spending: 0, savingsRate: null, status: 'failed' }, null)).toEqual([]);
  });
  it('keeps the runway value and note consistent', () => {
    const sig = buildSignals(12600, { spending: 9000, savingsRate: null, status: 'ok' }, null)[0];
    expect(sig.value).toBe('4.2 mo');
    expect(sig.note).toContain('about 4.2 months');
  });
});

const model = (over: Partial<ReportModel> = {}): ReportModel => ({
  quarterLabel: 'Q3 2026', periodLabel: '1 Jul – 30 Sep 2026', generatedAt: '2 Oct 2026',
  asOf: '30 Sep 2026', netWorth: 500000, netWorthChange: -5000, netWorthChangePct: -0.01,
  deltaFrom: '30 Jun 2026', yoyPct: null,
  groups: [{ name: 'Cash & banking', subtotal: 1000, rows: [{ name: 'Checking', org: 'Bank', balance: 1000 }] }],
  groupsStatus: 'ok', currentTotal: 1000,
  allocation: [{ label: 'Equity', pct: 100 }], allocationStatus: 'ok',
  cashflow: { income: 1000, spending: 1150, saved: -150, savingsRate: -0.15, status: 'ok' },
  taxBuckets: [{ label: 'Taxable', value: 1000 }], taxStatus: 'ok',
  signals: [], analystNote: 'Note.', noteSource: 'summary', ...over,
});

describe('deterministicNote', () => {
  it('words a negative-savings quarter as overspending, without a negative "saved"', () => {
    const n = deterministicNote(model());
    expect(n).toContain('You spent $150 more than the $1,000 you earned');
    expect(n).not.toContain('saved $-');
    expect(n).toContain('fell $5,000 (1.0%)');
  });
  it('omits the savings sentence when cash flow is unavailable', () => {
    const n = deterministicNote(model({ cashflow: { income: 0, spending: 0, saved: 0, savingsRate: null, status: 'empty' } }));
    expect(n).not.toContain('saved');
    expect(n).not.toContain('spent');
  });
});

describe('renderReportHtml', () => {
  it('shows the as-of date, delta start date, and current-holdings labels', () => {
    const html = renderReportHtml(model());
    expect(html).toContain('balances as of 30 Sep 2026');
    expect(html).toContain('from 30 Jun 2026');
    expect(html).toContain('current holdings, as of 2 Oct 2026');
  });
  it('colors negative savings as down, not up', () => {
    const html = renderReportHtml(model());
    expect(html).toContain('<dd class="down">−$150</dd>');
    expect(html).toContain('flowv down');
    expect(html).not.toContain('flowv up');
  });
  it('says "Not enough history" instead of a year-over-year figure', () => {
    expect(renderReportHtml(model())).toContain('Not enough history');
  });
  it('renders "not available" rather than zeros, distinguishing failure from empty', () => {
    const failed = renderReportHtml(model({
      cashflow: { income: 0, spending: 0, saved: 0, savingsRate: null, status: 'failed' },
      allocation: [], allocationStatus: 'failed', groups: [], groupsStatus: 'failed', currentTotal: null,
    }));
    expect(failed).toContain('could not be generated');
    expect(failed).not.toContain('class="flowbar"');
    expect(failed).not.toContain('No investment holdings found');
    const empty = renderReportHtml(model({
      cashflow: { income: 0, spending: 0, saved: 0, savingsRate: null, status: 'empty' },
      allocation: [], allocationStatus: 'empty',
    }));
    expect(empty).toContain('Not available for this quarter');
    expect(empty).toContain('No investment holdings found.');
  });
  it('uses accessible footer/disclaimer text color and size', () => {
    const html = renderReportHtml(model());
    expect(html).not.toContain('#9aa29b;margin');
    expect(html).toMatch(/\.disc\{ font-size:12px;[^}]*color:#5f6862/);
  });
});

describe('buildAdvisorySystemPrompt', () => {
  it('uses the real quarter, date and horizon instead of hard-coded mid-2026', () => {
    const now = new Date('2027-01-02T00:00:00Z');
    const p = buildAdvisorySystemPrompt(getReportWindow(now), now);
    expect(p).toContain('dated 2 January 2027');
    expect(p).toContain('Q4 2026');
    expect(p).toContain('the remainder of 2027 (Q1 through Q4)');
    expect(p).toContain('early 2028');
    expect(p).not.toContain('mid-2026');
    expect(p).not.toContain('second half');
  });
});
