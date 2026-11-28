import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import NetWorthChart, { MeasureReadout } from './NetWorthChart.tsx';
import { measureSpan } from '../lib/historyMeasure.ts';

// Static renders of the History chart's measure readout (no DOM in this test
// setup, so no real pointer): the text for a given selection, the idle hint,
// the no-percentage case, and what the live region announces.

const pt = (date: string, acc: number, re: number, index?: number) =>
  ({ date, accounts_total: acc, real_estate_total: re, net_worth: acc + re, index });
const DATA = [
  pt('2025-03-03', 600_000, 364_000, 964_000),
  pt('2025-09-01', 610_000, 370_000, 1_000_000),
  pt('2026-06-09', 612_340, 364_000, 1_060_000),
];
const both = { showAccounts: true, showRealEstate: true, hasIndex: true };
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const readout = (m: ReturnType<typeof measureSpan>, over: Partial<Parameters<typeof MeasureReadout>[0]> = {}) =>
  renderToStaticMarkup(<MeasureReadout measurement={m} compact={false} touch={false} {...over} />);

describe('MeasureReadout', () => {
  it('shows the change, its share of the start, the dates and each part', () => {
    const html = readout(measureSpan(DATA, 2, 0, both), { indexLabel: 'S&P 500' });
    expect(text(html)).toBe(
      '+$12,340 (1.28%) ↑ Mar 3, 2025 – Jun 9, 2026 ⓘ '
      + 'Accounts & assets +$12,340 (2.06%) · Home equity $0 (0.00%) · S&P 500 +9.96% Includes deposits and withdrawals',
    );
    expect(html).toContain('class="nw-readout-change up"');
    // The tip says what the figure is, and that the comparison is a total return.
    expect(html).toContain('not an investment return');
    expect(html).toContain('dividends reinvested');
  });

  it('marks a fall as down, and never says "return"', () => {
    const fall = [pt('2026-01-02', 500_000, 0), pt('2026-02-02', 490_000, 0)];
    const html = readout(measureSpan(fall, 0, 1, { ...both, showRealEstate: false }));
    expect(text(html)).toContain('−$10,000 (−2.00%) ↓ Jan 2 – Feb 2, 2026');
    expect(html).toContain('class="nw-readout-change down"');
    // One part switched on is the net worth itself, so it isn't repeated.
    expect(text(html)).not.toContain('Accounts & assets');
    expect(text(html).toLowerCase()).not.toMatch(/\breturn\b/);
  });

  it('gives only the dollar change from a zero or negative start', () => {
    const neg = [pt('2026-01-02', -20_000, 0), pt('2026-03-02', -5_000, 0)];
    expect(text(readout(measureSpan(neg, 0, 1, both)))).toContain('+$15,000 ↑ Jan 2 – Mar 2, 2026');
    expect(text(readout(measureSpan(neg, 0, 1, both)))).not.toContain('%');
  });

  it('leaves the comparison out when its move is unknown', () => {
    const html = readout(measureSpan(DATA, 0, 2, { ...both, hasIndex: false }), { indexLabel: 'S&P 500' });
    expect(text(html)).not.toContain('S&P 500');
    expect(html).not.toContain('dividends reinvested');
  });

  it('shows a hint while idle, worded for the pointer in use', () => {
    expect(text(readout(null))).toBe('Drag across the chart to measure a change between two dates');
    expect(text(readout(null, { touch: true, compact: true }))).toBe('Press and hold the chart, then slide, to measure a change');
  });
});

describe('NetWorthChart measuring', () => {
  it('reads out and announces a finished measurement', () => {
    const html = renderToStaticMarkup(<NetWorthChart data={DATA} initialSelection={{ a: 2, b: 0 }} indexLabel="S&P 500" />);
    expect(text(html)).toContain('+$12,340 (1.28%)');
    const live = html.match(/<div class="sr-only" role="status" aria-live="polite" aria-atomic="true">(.*?)<\/div>/);
    expect(live?.[1]).toBe(
      'Net worth changed +$12,340 (1.28%) from Mar 3, 2025 to Jun 9, 2026. '
      + 'Accounts and assets +$12,340 (2.06%); home equity $0 (0.00%). '
      + 'S&amp;P 500 +9.96% over the same dates. Includes deposits and withdrawals.',
    );
    // Focusable, with the keyboard instructions attached.
    expect(html).toMatch(/class="nw-chart"[^>]*tabindex="0"/);
    expect(html).toContain('arrow keys');
  });

  it('measures nothing, and announces nothing, in privacy mode', () => {
    const html = renderToStaticMarkup(<NetWorthChart data={DATA} initialSelection={{ a: 0, b: 2 }} interactive={false} />);
    expect(text(html)).toContain('Drag across the chart');
    expect(text(html)).not.toContain('$12,340');
    expect(html).toMatch(/role="status" aria-live="polite" aria-atomic="true"><\/div>/);
    expect(html).toMatch(/class="nw-chart"[^>]*tabindex="-1"/);
  });

  it('never measures a single point', () => {
    const html = renderToStaticMarkup(<NetWorthChart data={DATA} initialSelection={{ a: 1, b: 1 }} />);
    expect(text(html)).toContain('Drag across the chart');
    expect(html).not.toContain('nw-wash');
  });
});
