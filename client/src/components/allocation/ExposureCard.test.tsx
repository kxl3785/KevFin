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
  it('shows one other ticker in full after the name, and says it once to screen readers', () => {
    const html = render([stock('TSM', 'Taiwan Semiconductor', 800, ['2330'])]);
    expect(html).toContain('<small class="inv-rank-name">Taiwan Semiconductor</small><small class="inv-rank-also" aria-hidden="true">· 2330</small>');
    expect(html).toContain('<strong class="inv-rank-sym" style="font-weight:600">TSM</strong><span class="sr-only">, also 2330, </span>');
    expect(html).toMatch(/title="TSM, also 2330\n/);
  });

  it('shows the first of several other tickers and a count, with every one in words', () => {
    const html = render([stock('CIB', 'Grupo Cibest', 700, ['CIBEST', 'PFCIBEST'])]);
    expect(html).toContain('<small class="inv-rank-also" aria-hidden="true">· CIBEST +1</small>');
    expect(html).toContain('<span class="sr-only">, also CIBEST and PFCIBEST, </span>');
    expect(html).toMatch(/title="CIB, also CIBEST and PFCIBEST\n/);
  });

  it('shows nothing extra for a row with no other tickers', () => {
    const html = render([stock('AAPL', 'Apple', 900), stock('MSFT', 'Microsoft', 500)]);
    expect(html).not.toContain('also ');
    expect(html).not.toContain('inv-rank-also');
    expect(html).not.toContain('sr-only');
    expect(html).toContain('<strong class="inv-rank-sym" style="font-weight:600">AAPL</strong><small class="inv-rank-name">Apple</small>');
  });

  it('lists two companies under one symbol as two rows', () => {
    const html = render([stock('BN', 'BROOKFIELD CORP', 65), stock('BN', 'DANONE', 38), stock('AAPL', 'Apple', 900)]);
    expect(html).toContain('BROOKFIELD CORP');
    expect(html).toContain('DANONE');
    expect(html.match(/<strong class="inv-rank-sym" style="font-weight:600">BN<\/strong>/g)).toHaveLength(2);
  });
});
