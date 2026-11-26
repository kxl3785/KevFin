import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import FundFeesCard from './FundFeesCard.tsx';
import HeadlineTiles from './HeadlineTiles.tsx';
import type { FeeCheckupData, FeeRow } from './FeeCheckup.tsx';
import { unrealizedGain } from '../../lib/investments.ts';
import { DEFAULT_RANGE } from '../../lib/perfWindow.ts';

// Static renders of the "Fund fees" card (no DOM in this test setup), in the
// style of InvestmentsCards.test.tsx. The Forecast's saved plan is read from
// localStorage, so a stub stands in for it.

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  };
});
afterEach(() => { delete (globalThis as { localStorage?: unknown }).localStorage; });

const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const masked = () => '••••••';

const fee = (symbol: string, value: number, expenseRatio: number | null, source: FeeRow['source'] = expenseRatio == null ? 'unknown' : 'provider', more: Partial<FeeRow> = {}): FeeRow => ({
  id: symbol, symbol, name: `${symbol} Fund`, value, expenseRatio, source,
  annualCost: expenseRatio == null ? null : value * expenseRatio, ...more,
});

function checkup(rows: FeeRow[]): FeeCheckupData {
  const known = rows.filter(r => r.expenseRatio != null);
  const coveredValue = known.reduce((s, r) => s + r.value, 0);
  const totalAnnualCost = known.reduce((s, r) => s + (r.annualCost ?? 0), 0);
  const totalValue = rows.reduce((s, r) => s + r.value, 0);
  return {
    rows, totalValue, coveredValue, coverage: totalValue ? coveredValue / totalValue : 0,
    weightedRatio: coveredValue > 0 ? totalAnnualCost / coveredValue : null, totalAnnualCost,
    unknownCount: rows.length - known.length, largestId: null,
    location: { buckets: [], classes: [], cells: {}, bucketTotals: {} as never, classTotals: {}, total: 0, observations: [] },
  } as FeeCheckupData;
}

const ROWS = [
  fee('VTI', 400_000, 0.0003, 'provider', { provider: 'yahoo' }),          // $120
  fee('ARKK', 20_000, 0.0075, 'provider', { provider: 'sec', asOf: '2026-06-30' }), // $150
  fee('MINE', 10_000, 0.005, 'manual'),                                     // $50
  fee('AAPL', 50_000, 0, 'stock'),
  fee('MSFT', 40_000, 0, 'stock'),
  fee('CASH', 5_000, 0, 'cash'),
  fee('PLAN529', 30_000, null),
];
const DATA = checkup(ROWS);
const state = (data: FeeCheckupData | null, over: Partial<{ loading: boolean; error: string | null }> = {}) =>
  ({ data, loading: false, error: null, refetch: () => {}, ...over });
const render = (data: FeeCheckupData | null, over: Partial<Parameters<typeof FundFeesCard>[0]> = {}, st: Partial<{ loading: boolean; error: string | null }> = {}) =>
  renderToStaticMarkup(<FundFeesCard fees={state(data, st)} money={usd} privacy={false} {...over} />);

const tiles = (over: Partial<Parameters<typeof HeadlineTiles>[0]> = {}) => renderToStaticMarkup(
  <HeadlineTiles invested={1000} accounts={1} gain={unrealizedGain([])} off={null} band={5} hasTargets={false}
    fees={DATA} feesLoading={false} money={usd} privacy={false} perf={null}
    perfRange={{ ...DEFAULT_RANGE, range: 'ALL' }} onJump={() => {}} {...over} />,
);
// The Fund fees tile's value and sub-line, as text.
function feeTile(html: string): string {
  const m = html.match(/<button[^>]*class="inv-kpi"[^>]*>(?:(?!<button).)*?Fund fees.*?<\/button>/);
  return (m?.[0] ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

describe('FundFeesCard', () => {
  it('shows the same three figures as the headline tile', () => {
    const html = render(DATA);
    const tile = feeTile(tiles());
    // $320 a year, 0.06% average, and the drag over the Forecast's years.
    const drag = tile.match(/(\$[\d,]+) over (\d+) yrs/);
    expect(drag).toBeTruthy();
    expect(tile).toContain('$320');
    expect(tile).toContain('0.061% average');
    expect(html).toContain('$320');
    expect(html).toContain('0.061%');
    expect(html).toContain(drag![1]);
    expect(html).toContain(`Over ${drag![2]} yrs`);
    expect(html).toContain('Forecast’s defaults');
  });

  it('ranks the holdings that charge a fee by yearly cost, with each one’s source', () => {
    const html = render(DATA);
    const order = ['ARKK', 'VTI', 'MINE'].map(s => html.indexOf(`<strong style="font-weight:600">${s}</strong>`));
    expect(order.every(i => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('ARKK · From the fund’s SEC shareholder report (period ending 2026-06-30)');
    expect(html).toContain('VTI · Published fund data (Yahoo Finance)');
    expect(html).toContain('MINE · Your figure');
    // Stocks and cash aren't rows; one line says they charge nothing.
    expect(html).not.toContain('<strong style="font-weight:600">AAPL</strong>');
    expect(html).toContain('3 holdings charge nothing: single stocks and cash.');
    // Bars are decorative; the list is a list.
    expect(html).toContain('<ul');
    expect(html).toMatch(/class="inv-rank-bar" aria-hidden="true"/);
  });

  it('folds a long list behind "Show all N"', () => {
    const many = checkup(['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((s, i) => fee(s, 10_000 - i * 100, 0.001)));
    const html = render(many);
    expect(html).toContain('Show all 7');
    expect((html.match(/<li /g) ?? []).length).toBe(5);
    expect(render(checkup(ROWS.slice(0, 3)))).not.toContain('Show all');
  });

  it('names the holdings with no fee figure, and links to Positions to add one', () => {
    const html = render(DATA);
    expect(html).toContain('1 holding has no fee figure, so it isn’t in these totals: PLAN529.');
    expect(html).toMatch(/<a href="#inv-positions" class="inv-link"[^>]*>Add its fee in Positions<\/a>/);
    const lots = render(checkup([...ROWS, fee('U1', 9, null), fee('U2', 8, null), fee('U3', 7, null), fee('U4', 6, null)]));
    expect(lots).toContain('5 holdings have no fee figure, so they aren’t in these totals: PLAN529, U1, U2 and 2 more.');
    expect(lots).toContain('Add their fees in Positions');
    expect(render(checkup(ROWS.filter(r => r.expenseRatio != null)))).not.toContain('no fee figure');
  });

  it('privacy mode masks every dollar amount but keeps the fee percentages', () => {
    const html = render(DATA, { money: masked, privacy: true });
    expect(html).not.toMatch(/\$\d/);
    expect(html).toContain('••••••');
    expect(html).toContain('0.75%');
  });

  it('says when it is loading, unavailable, or has no fee figures yet', () => {
    expect(render(null, {}, { loading: true })).toContain('Looking up fund fees…');
    const failed = render(null, {}, { error: 'HTTP 500' });
    expect(failed).toContain('Fees unavailable: HTTP 500.');
    expect(failed).toContain('Retry');
    const none = render(checkup([fee('PLAN529', 30_000, null)]));
    expect(none).toContain('No fee figures yet.');
    expect(none).not.toContain('Cost per year');
    expect(none).toContain('Add its fee in Positions');
    expect(feeTile(tiles({ fees: checkup([fee('PLAN529', 30_000, null)]) }))).toContain('No fee figures yet');
  });

  it('with only stocks and cash, shows $0 and the one line, no list', () => {
    const html = render(checkup(ROWS.filter(r => r.expenseRatio === 0)));
    expect(html).toContain('$0');
    expect(html).toContain('3 holdings charge nothing');
    expect(html).not.toContain('Where the fees go');
  });
});

describe('Fund fees tile', () => {
  it('leads to the Fund fees card when it is on the page, else to Positions', () => {
    expect(tiles({ feesJump: 'inv-fees' })).toMatch(/<button[^>]*class="inv-kpi"[^>]*title="[^"]*Click for the Fund fees card\.[^"]*"/);
    expect(tiles()).toMatch(/<button[^>]*class="inv-kpi"[^>]*title="[^"]*each holding&#x27;s fee in Positions[^"]*"/);
  });
});
