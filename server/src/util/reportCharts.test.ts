import { describe, it, expect } from 'vitest';
import {
  attributeChange, monthEndSeries, trendSvg, waterfallSvg, waterfallAxis, donutSvg, groupedBarsSvg, fmtK, esc, fmtDateUS, fmtRangeUS,
} from './reportCharts.js';

describe('attributeChange', () => {
  it('reconciles exactly: start + saved + home + market = end (whole dollars)', () => {
    const a = attributeChange({ start: 641210.4, end: 665963.6, saved: 9360.49, homeEquityDelta: 3913.5 });
    expect(a.start + a.saved + a.home + a.market).toBe(a.end);
    expect(a.market).toBe(a.end - a.start - a.saved - a.home);
  });
  it('supports negative steps', () => {
    const a = attributeChange({ start: 100000, end: 95000, saved: -2000, homeEquityDelta: -1500 });
    expect(a.saved).toBe(-2000);
    expect(a.market).toBe(-1500);
    expect(a.start + a.saved + a.home + a.market).toBe(a.end);
  });
  it('puts everything in market & other when saved and home are zero', () => {
    expect(attributeChange({ start: 10, end: 25, saved: 0, homeEquityDelta: 0 }).market).toBe(15);
  });
});

describe('monthEndSeries', () => {
  const hist = [
    { date: '2025-09-30', net_worth: 100 }, { date: '2025-10-15', net_worth: 105 }, { date: '2025-10-31', net_worth: 110 },
    { date: '2026-01-31', net_worth: 120 }, { date: '2026-02-10', net_worth: 125 },
  ];
  it('takes the last snapshot in each month and skips months without one', () => {
    const s = monthEndSeries(hist, '2026-02', 12);
    expect(s).toEqual([
      { key: '2025-09', value: 100 }, { key: '2025-10', value: 110 }, { key: '2026-01', value: 120 }, { key: '2026-02', value: 125 },
    ]);
  });
  it('limits to the trailing window and handles short history', () => {
    expect(monthEndSeries(hist, '2026-02', 2).map(p => p.key)).toEqual(['2026-01', '2026-02']);
    expect(monthEndSeries([], '2026-02')).toEqual([]);
  });
  it('rolls across the year boundary', () => {
    expect(monthEndSeries([{ date: '2025-12-31', net_worth: 1 }], '2026-01', 2)[0].key).toBe('2025-12');
  });
});

describe('waterfallAxis', () => {
  it('truncates when steps are small next to the totals', () => {
    const a = waterfallAxis([641210, 650570, 662050, 665963, 665963]);
    expect(a.truncated).toBe(true);
    expect(a.lo).toBe(620000);
  });
  it('stays zero-based when the steps are large', () => {
    expect(waterfallAxis([100, 160, 200])).toMatchObject({ lo: 0, truncated: false });
  });
  it('includes negative levels instead of truncating', () => {
    expect(waterfallAxis([-50, 10, 20]).lo).toBe(-50);
  });
});

describe('SVG builders', () => {
  const w = waterfallSvg({
    startLabel: 'Jun 30 <x>', endLabel: 'Sep 30', start: 641210, end: 665963,
    steps: [
      { label: 'Saved', amount: 9360 }, { label: 'Home & "equity"', sublabel: 'value + paydown', amount: -1000, title: "it's <b>" },
      { label: 'Market & other', amount: 16393 },
    ],
  });
  it('waterfall has role/aria with the real values and escapes labels', () => {
    expect(w.svg).toContain('role="img"');
    expect(w.svg).toContain('aria-label="Waterfall: start $641,210, plus $9,360 saved, minus $1,000 home &amp; &quot;equity&quot;');
    expect(w.svg).toContain('Jun 30 &lt;x&gt;');
    expect(w.svg).toContain('it&#39;s &lt;b&gt;');
    expect(w.svg).not.toContain('<b>');
    expect(w.truncated).toBe(true);
    // Negative step is drawn red.
    expect(w.svg).toContain('#b0473c');
  });
  it('waterfall markup is well-formed (balanced tags)', () => {
    for (const svg of [w.svg, trendSvg([{ key: '2026-01', value: 1 }, { key: '2026-02', value: 2 }], ['2026-02'], 'Q1'),
      donutSvg([{ label: 'A&B', pct: 60 }, { label: 'C', pct: 40 }], 'Total', '$1k'),
      groupedBarsSvg([{ label: 'Jul', a: 10, b: 5 }], 'Income', 'Spending')]) {
      const opens = (svg.match(/<(rect|text|line|circle|polyline|g|svg|title)\b/g) ?? []).length;
      const selfOrClose = (svg.match(/<\/(rect|text|g|svg|title|circle|line|polyline)>/g) ?? []).length;
      expect(opens).toBe(selfOrClose);
      expect(svg.startsWith('<svg')).toBe(true);
      expect(svg.endsWith('</svg>')).toBe(true);
    }
  });
  it('trend: needs 2+ points, shades the quarter, labels first/last months', () => {
    expect(trendSvg([{ key: '2026-01', value: 1 }], [], 'Q1')).toBe('');
    const t = trendSvg([{ key: '2025-10', value: 100 }, { key: '2025-11', value: 110 }, { key: '2025-12', value: 120 }], ['2025-11', '2025-12'], 'Q4');
    expect(t).toContain('Oct ’25');
    expect(t).toContain('Dec ’25');
    expect(t).toContain('>Q4<');
    expect(t).toContain('aria-label="Net worth over the last 3 months, from $100 in Oct ’25 to $120 in Dec ’25"');
  });
  it('trend: a flat series does not divide by zero', () => {
    expect(trendSvg([{ key: '2026-01', value: 5 }, { key: '2026-02', value: 5 }], [], 'Q1')).not.toContain('NaN');
  });
  it('donut sums dash lengths to the circumference and escapes legend text', () => {
    const d = donutSvg([{ label: 'A<', pct: 75 }, { label: 'B', pct: 25 }], 'Total', '$350k');
    expect(d).toContain('Asset allocation: A&lt; 75%, B 25%');
    expect(d).toContain('stroke-dasharray="235.6 314.2"');
    expect(d).not.toContain('NaN');
  });
  it('grouped bars scale to the max and label months', () => {
    const g = groupedBarsSvg([{ label: 'Jul', a: 100, b: 50 }, { label: 'Aug', a: 100, b: 60 }], 'Income', 'Spending');
    expect(g).toContain('>Jul<');
    expect(g).toContain('aria-label="Monthly income and spending: Jul $100 and $50; Aug $100 and $60"');
    expect(g).not.toContain('NaN');
  });
});

describe('formatting helpers', () => {
  it('US-style dates and ranges', () => {
    expect(fmtDateUS('2026-06-30')).toBe('Jun 30, 2026');
    expect(fmtDateUS('2026-06-05', false)).toBe('Jun 5');
    expect(fmtRangeUS('2026-04-01', '2026-06-30')).toBe('Apr 1 – Jun 30, 2026');
    expect(fmtRangeUS('2025-12-01', '2026-01-31')).toBe('Dec 1, 2025 – Jan 31, 2026');
  });
  it('fmtK', () => {
    expect(fmtK(620000)).toBe('$620k');
    expect(fmtK(1_250_000)).toBe('$1.3M');
    expect(fmtK(850)).toBe('$850');
    expect(fmtK(-12400)).toBe('−$12.4k');
  });
  it('esc handles all five characters', () => {
    expect(esc(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&#39;');
  });
});
