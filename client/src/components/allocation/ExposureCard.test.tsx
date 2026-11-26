import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ExposureCard from './ExposureCard.tsx';

// The stock list with rows the server merged by company (aliases) and rows
// that share a symbol but are different companies (BN). Static renders, as in
// InvestmentsCards.test.tsx; the saved tab is read from a localStorage stub.

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  store.set('mon.exposureTab', JSON.stringify('stocks'));
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  };
});
afterEach(() => { delete (globalThis as { localStorage?: unknown }).localStorage; });

const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const stock = (symbol: string, name: string, value: number, aliases?: string[]) => ({
  symbol, name, value, pct: value / 10000, accounts: [{ name: 'Brokerage', value }],
  sources: [{ label: 'VXUS', value }], ...(aliases ? { aliases } : {}),
});
const render = (byStock: ReturnType<typeof stock>[]) => renderToStaticMarkup(
  <ExposureCard byCountry={[]} bySector={[]} byStock={byStock} money={usd} onLookThroughSaved={() => {}} />,
);

describe('ExposureCard stock rows', () => {
  it('names a merged row’s other tickers quietly, after the name and in the tooltip', () => {
    const html = render([stock('TSM', 'Taiwan Semiconductor', 800, ['2330']), stock('GOOGL', 'Alphabet', 700, ['GOOG', 'GOOGL.MX'])]);
    expect(html).toContain('<small>· also 2330</small>');
    expect(html).toContain('<small>· also GOOG and GOOGL.MX</small>');
    expect(html).toMatch(/title="TSM, also 2330\n/);
  });

  it('shows nothing extra for a row with no other tickers', () => {
    const html = render([stock('AAPL', 'Apple', 900), stock('MSFT', 'Microsoft', 500)]);
    expect(html).not.toContain('also ');
  });

  it('lists two companies under one symbol as two rows', () => {
    const html = render([stock('BN', 'BROOKFIELD CORP', 65), stock('BN', 'DANONE', 38), stock('AAPL', 'Apple', 900)]);
    expect(html).toContain('BROOKFIELD CORP');
    expect(html).toContain('DANONE');
    expect(html.match(/<strong style="font-weight:600">BN<\/strong>/g)).toHaveLength(2);
  });
});
