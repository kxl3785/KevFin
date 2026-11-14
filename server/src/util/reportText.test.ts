import { describe, it, expect } from 'vitest';
import { reportHtmlToText } from './reportText.js';

describe('reportHtmlToText', () => {
  it('keeps headings, paragraphs and list items as lines of text', () => {
    const html = '<!doctype html><html><head><title>Q3</title><style>h1{color:red}</style></head><body>' +
      '<h1>Q3 2026 report</h1><p>Net worth rose <strong>$12,400</strong> to $666,712.</p><ul><li>Saved $6,100</li><li>Markets +$4,900</li></ul></body></html>';
    expect(reportHtmlToText(html)).toBe('Q3 2026 report\n\nNet worth rose $12,400 to $666,712.\n\nSaved $6,100\n\nMarkets +$4,900');
  });

  it('drops scripts, styles and comments entirely', () => {
    const text = reportHtmlToText('<p>Before</p><script>window.print(); var secret = 1;</script><style>.x{}</style><!-- hidden note --><p>After</p>');
    expect(text).toBe('Before\n\nAfter');
  });

  it('replaces a chart with the description it carries', () => {
    const html = '<p>Allocation</p><svg class="chart donut" viewBox="0 0 140 140" role="img" aria-label="Stocks 62%, bonds 18%, cash 20%"><circle r="5"/><text>62%</text></svg><p>Next</p>';
    expect(reportHtmlToText(html)).toBe('Allocation\n\n[Chart: Stocks 62%, bonds 18%, cash 20%]\n\nNext');
  });

  it('drops an undescribed svg (an icon)', () => {
    expect(reportHtmlToText('<button><svg viewBox="0 0 24 24"><path d="M1 1"/></svg>Save as PDF</button>')).toBe('Save as PDF');
  });

  it('separates table cells and rows', () => {
    const html = '<table><tr><th>Account</th><th>Balance</th></tr><tr><td>Checking</td><td>$5,000</td></tr></table>';
    expect(reportHtmlToText(html)).toBe('Account | Balance\n\nChecking | $5,000');
  });

  it('decodes the entities the report template writes', () => {
    expect(reportHtmlToText('<p>Tom &amp; Ana&#39;s home &middot; &lt;10% &gt; 5% &quot;ok&quot; &#x2212;$40&nbsp;k</p>'))
      .toBe('Tom & Ana\'s home · <10% > 5% "ok" −$40 k');
  });

  it('leaves an unknown entity alone and drops control code points', () => {
    expect(reportHtmlToText('<p>a &bogus; b&#0;c&#7;d</p>')).toBe('a &bogus; bcd');
  });

  it('caps very long reports', () => {
    const text = reportHtmlToText(`<p>${'x'.repeat(5000)}</p>`, 1000);
    expect(text.length).toBeLessThan(1100);
    expect(text.endsWith('[report text cut off here]')).toBe(true);
  });

  it('returns an empty string for an empty page', () => {
    expect(reportHtmlToText('<html><head><style>a{}</style></head><body></body></html>')).toBe('');
  });
});
