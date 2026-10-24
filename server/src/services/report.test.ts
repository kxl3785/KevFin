import { describe, it, expect } from 'vitest';
import {
  parseAdvisory, savingsNote, buildSignals, buildAdvisorySystemPrompt, aggregateCashflow, buildKpis,
  deterministicBrief, splitBrief,
} from './report.js';
import { renderReportHtml, collapseAccounts, type ReportModel } from './reportTemplate.js';
import { attributeChange } from '../util/reportCharts.js';
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


describe('aggregateCashflow', () => {
  const months = [
    { income: 5000, spending: 2000, mortgage: 1000, byCategory: [{ category: 'Groceries', spent: 800 }, { category: 'Travel', spent: 1300 }] },
    null,
    { income: 5000, spending: 1000, mortgage: 1000, byCategory: [{ category: 'Groceries', spent: 400 }, { category: 'Zero', spent: 0 }, { category: 'Gas', spent: 600 }] },
  ];
  const cf = aggregateCashflow(['2026-04', '2026-05', '2026-06'], months, c => c.toUpperCase(), 2);
  it('counts mortgage payments in spending so saved = income - spending', () => {
    expect(cf.income).toBe(10000);
    expect(cf.spending).toBe(5000);
    expect(cf.saved).toBe(5000);
    expect(cf.savingsRate).toBe(0.5);
    expect(cf.status).toBe('ok');
  });
  it('builds a per-month series, treating a month with no data as zero', () => {
    expect(cf.months).toEqual([
      { label: 'Apr', income: 5000, spending: 3000 },
      { label: 'May', income: 0, spending: 0 },
      { label: 'Jun', income: 5000, spending: 2000 },
    ]);
  });
  it('ranks categories (incl. Mortgage) and reconciles "everything else"', () => {
    expect(cf.categories).toEqual([{ label: 'MORTGAGE', amount: 2000 }, { label: 'TRAVEL', amount: 1300 }]);
    expect(cf.other).toBe(5000 - 3300);
  });
  it('is empty (not a $0 quarter) when no month has data', () => {
    expect(aggregateCashflow(['a', 'b', 'c'], [null, null, null], c => c).status).toBe('empty');
  });
});

describe('KPIs, brief and attribution wiring', () => {
  const ok = { saved: 1000, savingsRate: 0.2, status: 'ok' as const };
  const attr = attributeChange({ start: 100000, end: 112000, saved: 3000, homeEquityDelta: 2000 });
  it('shows "—" with a reason for any tile lacking inputs', () => {
    const k = buildKpis({ cashflow: { saved: 0, savingsRate: null, status: 'failed' }, attribution: null, runway: null, homeShare: null });
    expect(k.map(x => x.value)).toEqual(['—', '—', '—', '—']);
    expect(k.every(x => x.note.length > 0)).toBe(true);
  });
  it('flags a runway below 6 months', () => {
    const k = buildKpis({ cashflow: ok, attribution: attr, runway: 4.2, homeShare: 0.47 });
    expect(k[2]).toMatchObject({ value: '4.2 mo', note: 'Below a 6-month target', noteTone: 'warn' });
    expect(k[1].value).toBe('+$7,000');
    expect(k[3].value).toBe('47%');
  });
  it('colors negative savings down', () => {
    const k = buildKpis({ cashflow: { saved: -500, savingsRate: -0.1, status: 'ok' }, attribution: null, runway: null, homeShare: null });
    expect(k[0]).toMatchObject({ value: '−$500', valueTone: 'down' });
  });
  it('writes deterministic bullets naming the biggest driver and prior savings rate', () => {
    const b = deterministicBrief({
      quarterLabel: 'Q2 2026', netWorth: 112000, netWorthChange: 12000, netWorthChangePct: 0.12, attribution: attr,
      cashflow: { savingsRate: 0.2, status: 'ok' }, prior: { label: 'Q1', rate: 0.26 }, runway: 4.2,
    });
    expect(b[0]).toContain('rose $12,000');
    expect(b[0]).toContain('led by market moves and other changes (+$7,000)');
    expect(b[1]).toBe('You kept 20% of what you earned this quarter (26% in Q1).');
    expect(b[2]).toContain('4.2 months');
    expect(b).toHaveLength(3);
  });
  it('splits an assistant note into sentences when that yields 2-4 bullets, else keeps paragraphs', () => {
    expect(splitBrief('Net worth grew 4%. Savings were steady. Watch cash.')).toHaveLength(3);
    expect(splitBrief('One long sentence only.')).toEqual(['One long sentence only.']);
    const many = 'A one. B two. C three. D four. E five.\n\nSecond para.';
    expect(splitBrief(many)).toEqual(['A one. B two. C three. D four. E five.', 'Second para.']);
    expect(splitBrief('Holdings are 60% U.S. Stocks are fine.')).toHaveLength(1);
    expect(splitBrief('Equities rose 6%. U.S. stocks led.')).toHaveLength(2);
  });
  it('collapses accounts beyond the row limit, summing balances and changes only when all known', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ name: `A${i}`, org: 'X', balance: (10 - i) * 100, change: i < 9 ? 5 : null }));
    const c = collapseAccounts(rows, 8);
    expect(c).toHaveLength(8);
    expect(c[7].name).toBe('Other accounts (3)');
    expect(c[7].balance).toBe(300 + 200 + 100);
    expect(c[7].change).toBeNull();
    expect(collapseAccounts(rows.slice(0, 3).map(r => ({ ...r, change: 5 })), 8)).toHaveLength(3);
    expect(collapseAccounts(rows.slice(0, 9).map(r => ({ ...r, change: 5 })), 8)[7].change).toBe(10);
  });
});

const model = (over: Partial<ReportModel> = {}): ReportModel => ({
  quarterLabel: 'Q3 2026', quarterShort: 'Q3', periodLabel: 'Jul 1 – Sep 30, 2026', generatedAt: 'Oct 2, 2026',
  asOf: 'Sep 30, 2026', netWorth: 500000, netWorthChange: -5000, netWorthChangePct: -0.01,
  deltaFrom: 'Jun 30, 2026', yoyPct: null,
  trend: {
    points: [{ key: '2026-06', value: 505000 }, { key: '2026-07', value: 503000 }, { key: '2026-09', value: 500000 }],
    shadeKeys: ['2026-07', '2026-08', '2026-09'],
  },
  kpis: buildKpis({
    cashflow: { saved: -150, savingsRate: -0.15, status: 'ok' },
    attribution: attributeChange({ start: 505000, end: 500000, saved: -150, homeEquityDelta: -1000 }), runway: 4.2, homeShare: 0.4,
  }),
  brief: ['First point.', 'Second <point>.'], noteSource: 'summary',
  attribution: attributeChange({ start: 505000, end: 500000, saved: -150, homeEquityDelta: -1000 }),
  startLabel: 'Jun 30', endLabel: 'Sep 30',
  accounts: [{ name: 'Checking', org: 'Bank <&>', balance: 1000, change: 50 }], accountsStatus: 'ok', showChange: true,
  allocation: [{ label: 'Equity', pct: 100 }], allocationStatus: 'ok', allocationTotal: 350000,
  taxBuckets: [{ label: 'Taxable', value: 1000 }], taxStatus: 'ok',
  cashflow: {
    income: 1000, spending: 1150, saved: -150, savingsRate: -0.15, status: 'ok',
    months: [{ label: 'Jul', income: 300, spending: 400 }, { label: 'Aug', income: 300, spending: 350 }, { label: 'Sep', income: 400, spending: 400 }],
    categories: [{ label: 'Rent', amount: 600 }], other: 550,
  },
  signals: [{ tag: 'Low', tone: 'watch', label: 'Savings rate', value: '-15%', note: 'You spent 15% more than you earned this quarter.' }],
  ...over,
});

describe('renderReportHtml', () => {
  it('follows the story order', () => {
    const html = renderReportHtml(model({ marketView: ['Rates may ease.'] }));
    const order = ['Quarterly statement of net worth', 'Saved this quarter', 'In brief', 'What changed this quarter',
      'Where your money is', '>Cash flow<', '>Signals<', 'Looking ahead', 'Generated Oct 2, 2026'];
    const idx = order.map(t => html.indexOf(t));
    expect(idx.every(i => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });
  it('shows the as-of date, delta start date, and current-holdings label', () => {
    const html = renderReportHtml(model());
    expect(html).toContain('balances as of Sep 30, 2026');
    expect(html).toContain('from Jun 30, 2026');
    expect(html).toContain('Current holdings, as of Oct 2, 2026');
    expect(html).toContain('Change in Q3');
  });
  it('colors negative savings and negative waterfall steps down, not up', () => {
    const html = renderReportHtml(model());
    expect(html).toContain('<p class="kpi-v down">−$150</p>');
    expect(html).toContain('minus $1,000 home equity');
    expect(html).toContain('fill="#b0473c"');
  });
  it('omits the year-over-year line when there is no valid figure, shows it when there is', () => {
    expect(renderReportHtml(model())).not.toContain('vs. a year ago');
    expect(renderReportHtml(model({ yoyPct: 0.124 }))).toContain('+12.4% vs. a year ago');
  });
  it('escapes labels and assistant text', () => {
    const html = renderReportHtml(model());
    expect(html).toContain('Second &lt;point&gt;.');
    expect(html).toContain('Bank &lt;&amp;&gt;');
    expect(html).not.toContain('Bank <&>');
  });
  it('states the axis truncation and the Market & other definition in the waterfall', () => {
    const html = renderReportHtml(model());
    expect(html).toContain('axis starts at $');
    expect(html).toContain('remainder');
  });
  it('drops the change column when no per-account change is available', () => {
    const html = renderReportHtml(model({ showChange: false }));
    expect(html).not.toContain('Change in Q3');
  });
  it('renders "Not available" for the waterfall when attribution is missing', () => {
    const html = renderReportHtml(model({ attribution: null, startLabel: null, endLabel: null }));
    expect(html).toContain('What changed this quarter');
    expect(html).toContain('Not available for this quarter — it needs balance snapshots');
    expect(html).not.toContain('Waterfall:');
  });
  it('renders "not available" rather than zeros, distinguishing failure from empty', () => {
    const failed = renderReportHtml(model({
      cashflow: { income: 0, spending: 0, saved: 0, savingsRate: null, status: 'failed', months: [], categories: [], other: 0 },
      allocation: [], allocationStatus: 'failed', accounts: [], accountsStatus: 'failed',
    }));
    expect(failed).toContain('could not be generated');
    expect(failed).not.toContain('Where it went');
    expect(failed).not.toContain('No investment holdings found');
    const empty = renderReportHtml(model({
      cashflow: { income: 0, spending: 0, saved: 0, savingsRate: null, status: 'empty', months: [], categories: [], other: 0 },
      allocation: [], allocationStatus: 'empty',
    }));
    expect(empty).toContain('Not available for this quarter');
    expect(empty).toContain('No investment holdings found.');
  });
  it('omits empty "Looking ahead" columns and the whole section when there is no advisory', () => {
    expect(renderReportHtml(model())).not.toContain('Looking ahead');
    const html = renderReportHtml(model({ marketView: ['x'], estateActions: [{ action: 'Will', why: 'Because' }] }));
    expect(html).toContain('ahead n2');
    expect(html).not.toContain('Tax-aware actions');
  });
  it('keeps accessible footer text color and size', () => {
    const html = renderReportHtml(model());
    expect(html).toMatch(/\.foot\{[^}]*font-size:12px;[^}]*color:var\(--muted\)/);
    expect(html).toContain('--muted:#5f6862');
  });
  it('keeps the print button, print rules and mobile breakpoint', () => {
    const html = renderReportHtml(model());
    expect(html).toContain('window.print()');
    expect(html).toContain('@media print');
    expect(html).toContain('@media (max-width:640px)');
    expect(html).toContain('break-inside:avoid');
  });
});

describe('buildAdvisorySystemPrompt', () => {
  it('uses the real quarter, date and horizon instead of hard-coded mid-2026', () => {
    const now = new Date('2027-01-02T00:00:00Z');
    const p = buildAdvisorySystemPrompt(getReportWindow(now), now);
    expect(p).toContain('dated January 2, 2027');
    expect(p).toContain('Q4 2026');
    expect(p).toContain('the remainder of 2027 (Q1 through Q4)');
    expect(p).toContain('early 2028');
    expect(p).not.toContain('mid-2026');
    expect(p).not.toContain('second half');
  });
});
