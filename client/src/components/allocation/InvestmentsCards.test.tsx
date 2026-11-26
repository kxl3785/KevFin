import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import PositionsCard, { type HoldingRow } from './PositionsCard.tsx';
import AllocationCard, { homeChipLabel } from './AllocationCard.tsx';
import HeadlineTiles from './HeadlineTiles.tsx';
import ExposureCard from './ExposureCard.tsx';
import BondQuality, { type BondSummary, type BondHolding } from './BondQuality.tsx';
import AccountTypesCard, { type FeeCheckupData } from './FeeCheckup.tsx';
import PerformanceChart, { type PerformanceData } from '../PerformanceChart.tsx';
import type { AllocationStatus } from './useAllocationStatus.ts';
import { unrealizedGain } from '../../lib/investments.ts';
import { DEFAULT_RANGE } from '../../lib/perfWindow.ts';

// Static renders of the Investments cards (no DOM in this test setup). Saved
// settings are read from localStorage on first render, so a stub stands in for
// it where a test needs one.

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

const row = (p: Partial<HoldingRow>): HoldingRow => ({
  symbol: '', name: '', value: 0, costBasis: null, costBasisCoveredValue: 0, costBasisComplete: true,
  costBasisSource: null, pct: 0, assetClass: 'Domestic Stock', overridden: false, accounts: [], ...p,
});
const VTI = row({
  symbol: 'VTI', name: 'Total Stock', value: 1000, costBasis: 800, costBasisCoveredValue: 1000, costBasisSource: 'reported',
  accounts: [{ name: 'Brokerage', value: 1000, costBasis: 800 }],
});
const BND = row({
  symbol: 'BND', name: 'Total Bond', value: 700, costBasis: 900, costBasisCoveredValue: 700, costBasisSource: 'reported',
  assetClass: 'Bonds', accounts: [{ name: 'Brokerage', value: 700, costBasis: 900 }],
});
const noFees = { data: null, loading: false, error: null, refetch: () => {} };

const positions = (over: Partial<Parameters<typeof PositionsCard>[0]> = {}) => renderToStaticMarkup(
  <PositionsCard holdings={[VTI, BND]} realEstateNames={new Set()} selectedClass={null} onClearClass={() => {}}
    money={usd} privacy={false} estimateBasis={false} onEstimateBasis={() => {}}
    onClassify={() => {}} onEditBasis={() => {}} onProfileSaved={() => {}} fees={noFees} {...over} />,
);

describe('PositionsCard', () => {
  it('shows signed, coloured gains and their percentages normally', () => {
    const html = positions();
    expect(html).toContain('+$200');
    expect(html).toContain('+25.0%');
    expect(html).toContain('−$200');
    expect(html).toContain('var(--green)');
  });

  it('privacy mode leaks no gain direction, percentage or colour', () => {
    const html = positions({ money: masked, privacy: true });
    expect(html).not.toMatch(/[+−]••••••/);
    expect(html).not.toContain('+25.0%');
    expect(html).not.toContain('−22.2%');
    expect(html).not.toContain('var(--green)');
    expect(html).not.toContain('var(--red)');
    expect(html).toContain('••••••');
  });

  it('shows one "no results" message, and the class by its display name', () => {
    const html = positions({ selectedClass: 'Short Term' });
    expect(html).toContain('Cash &amp; Short-Term <span');
    expect(html).toContain('No positions classified as Cash &amp; Short-Term.');
    expect(html).not.toContain('No investments match.');
    const searched = positions({ selectedClass: null });
    expect(searched).not.toContain('No positions match');
  });

  it('still says "No investments match" above other assets that do match', () => {
    const coins = row({ name: 'Coins', value: 500, assetClass: 'Bonds' });
    const html = positions({ holdings: [VTI, coins], selectedClass: 'Bonds' });
    expect(html).toContain('No investments match.');
    expect(html).not.toContain('No positions classified');
  });
});

const status = (over: Partial<AllocationStatus> = {}): AllocationStatus => ({ values: {}, model: null, source: null, band: 5, result: null, ...over });
const classes = [{ name: 'Domestic Stock', value: 6000, pct: 0.6 }, { name: 'Bonds', value: 4000, pct: 0.4 }];
const card = (over: Partial<Parameters<typeof AllocationCard>[0]> = {}) => renderToStaticMarkup(
  <AllocationCard classes={classes} homes={[]} money={usd} status={status()} riskProfile={null}
    onOpenRiskProfile={() => {}} onToggleHome={() => {}} selectedClass={null} onSelectClass={() => {}}
    worksheetOpen={false} onToggleWorksheet={() => {}} compact={false} {...over} />,
);

describe('AllocationCard', () => {
  it('says "No targets yet" only when there are none', () => {
    const html = card();
    expect(html).toContain('Set a risk profile or your own targets');
    expect(html).toContain('Set your own targets');
  });

  it('with your own targets saved but the unset risk profile chosen, says so', () => {
    store.set('mon.allocTargets', JSON.stringify({ mode: 'profile', custom: { 'Domestic Stock': 70, Bonds: 30 }, band: 5 }));
    const closed = card();
    expect(closed).toContain('No risk profile is set');
    expect(closed).toContain('Use your own targets');
    expect(closed).not.toContain('No targets yet');
    expect(closed).not.toContain('Set your own targets');
    // Worksheet open: one set of actions, in the worksheet, beside "Edit your targets".
    const open = card({ worksheetOpen: true });
    expect(open).not.toContain('No targets yet');
    expect(open).not.toContain('Set your own targets');
    expect(open).toContain('Edit your targets');
    expect(open.match(/Use your own targets/g)?.length).toBe(1);
  });

  it('names each home chip by its full address', () => {
    const a = homeChipLabel({ id: 1, address: '1 Main St, Springfield, IL', equity: 300000, excluded: false }, usd);
    const b = homeChipLabel({ id: 2, address: '1 Main St, Shelbyville, IL', equity: 300000, excluded: true }, usd);
    expect(a).toBe('Count 1 Main St · $300,000 in the allocation (1 Main St, Springfield, IL)');
    expect(a).not.toBe(b);
    expect(homeChipLabel({ id: 3, address: 'Cabin', equity: 5, excluded: false }, masked)).toBe('Count Cabin · •••••• in the allocation');
  });

  it('names the manual assets the bars count', () => {
    expect(card()).toContain('Investments only');
    const html = card({ manualInKinds: [{ name: 'I Bonds', value: 15000 }] });
    expect(html).toContain('Investments plus I Bonds ($15,000)');
    expect(card({ manualInKinds: [{ name: 'I Bonds', value: 15000 }], money: masked })).not.toContain('15,000');
  });
});

// Weekly points on one grid: your series from Nov 27, the S&P 500 from Dec 4.
const perfData: PerformanceData = {
  startDate: '2021-11-27', endDate: '2026-11-21',
  series: [
    { id: 'total', label: 'All accounts', type: 'account', accounts: [], cagr: 0, totalReturn: 0,
      points: [{ date: '2021-11-27', value: 100 }, { date: '2021-12-04', value: 110 }, { date: '2026-11-21', value: 165 }] },
    { id: 'SPY', label: 'S&P 500', type: 'benchmark', accounts: [], cagr: 0, totalReturn: 0,
      points: [{ date: '2021-12-04', value: 100 }, { date: '2026-11-21', value: 160 }] },
  ],
};

describe('HeadlineTiles', () => {
  const tiles = (over: Partial<Parameters<typeof HeadlineTiles>[0]> = {}) => renderToStaticMarkup(
    <HeadlineTiles invested={1700} accounts={1} gain={unrealizedGain([VTI, BND])} off={null} band={5} hasTargets={false}
      fees={null} feesLoading={false} money={usd} privacy={false} perf={perfData}
      perfRange={{ ...DEFAULT_RANGE, range: 'ALL' }} onJump={() => {}} {...over} />,
  );
  it('measures your return and the S&P 500 from the same date, and says which', () => {
    const html = tiles();
    expect(html).toContain('+50.0%');
    expect(html).toContain('S&amp;P 500 +60.0%');
    expect(html).toContain('10.0 pts behind');
    expect(html).toContain('since Dec 4, 2021');
  });
  it('says your own targets are saved when the risk profile in use is not set', () => {
    expect(tiles()).toContain('No targets yet');
    const html = tiles({ customTargetsSaved: true });
    expect(html).toContain('No risk profile set · your own targets are saved');
    expect(html).not.toContain('No targets yet');
  });
  it('makes the Fund fees tile a link to Positions, where the fees are', () => {
    const html = tiles();
    expect(html).toMatch(/<button[^>]*class="inv-kpi"[^>]*title="[^"]*each holding&#x27;s fee in Positions[^"]*"/);
  });
});

describe('BondQuality', () => {
  const base: BondSummary = {
    value: 1000, coverage: 1, govShare: 0.4, avgDuration: 6,
    byRating: [{ name: 'AAA', value: 700, pct: 0.7 }, { name: 'BBB', value: 300, pct: 0.3 }],
  };
  const fund = (symbol: string, value: number, accounts = [{ name: 'Roth IRA', value }]): BondHolding => ({ symbol, name: `${symbol} Fund`, value, accounts });
  it('renders as before when a stored result has no "Held in" list', () => {
    const html = renderToStaticMarkup(<BondQuality bonds={base} money={usd} />);
    expect(html).toContain('AAA');
    expect(html).not.toContain('Held in');
  });
  it('lists where the bonds are held: fund, accounts, dollars and share', () => {
    const html = renderToStaticMarkup(<BondQuality bonds={{ ...base, heldIn: [fund('BND', 750, [{ name: 'Brokerage', value: 500 }, { name: 'Roth IRA', value: 250 }]), fund('VBIAX', 250)] }} money={usd} />);
    expect(html).toContain('Held in');
    expect(html).toContain('BND');
    expect(html).toContain('BND Fund');
    expect(html).toContain('Brokerage');
    expect(html).toContain('$750');
    expect(html).toContain('75%');
    expect(html).not.toContain('Show all');
  });
  it('folds a long list to the largest five behind "Show all N"', () => {
    const heldIn = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((s, i) => fund(s, 100 - i));
    const html = renderToStaticMarkup(<BondQuality bonds={{ ...base, heldIn }} money={usd} />);
    expect(html).toContain('Show all 7');
    expect((html.match(/class="inv-held-row"/g) ?? []).length).toBe(5);
    // Six or fewer just show.
    const six = renderToStaticMarkup(<BondQuality bonds={{ ...base, heldIn: heldIn.slice(0, 6) }} money={usd} />);
    expect((six.match(/class="inv-held-row"/g) ?? []).length).toBe(6);
    expect(six).not.toContain('Show all');
  });
  it('privacy mode masks every dollar figure in the list', () => {
    const html = renderToStaticMarkup(<BondQuality bonds={{ ...base, heldIn: [fund('BND', 750)] }} money={masked} />);
    expect(html).not.toMatch(/\$\d/);
    expect(html).toContain('••••••');
  });
});

describe('AccountTypesCard', () => {
  const data = {
    rows: [], totalValue: 0, coveredValue: 0, coverage: 0, weightedRatio: null, totalAnnualCost: 0, unknownCount: 0, largestId: null,
    location: {
      buckets: ['taxable', 'pretax'], classes: ['US Stocks'],
      cells: { 'US Stocks': { taxable: 1_658_217, pretax: 352_000 } },
      bucketTotals: { taxable: 1_658_217, pretax: 352_000, roth: 0, hsa: 0, college: 0 }, classTotals: { 'US Stocks': 2_010_217 }, total: 2_010_217,
      observations: [],
    },
  } as unknown as FeeCheckupData;
  const fees = { data, loading: false, error: null, refetch: () => {} };
  it('shows full figures until the card has been measured, with a caption and scopes', () => {
    const html = renderToStaticMarkup(<AccountTypesCard fees={fees} money={usd} moneyShort={() => 'SHORT'} />);
    expect(html).toContain('$1,658,217');
    expect(html).not.toContain('SHORT');
    expect(html).toContain('<caption');
    expect(html).toContain('scope="row"');
    expect(html).toContain('More about Taxable');
  });
  it('privacy mode masks every figure', () => {
    const html = renderToStaticMarkup(<AccountTypesCard fees={fees} money={masked} moneyShort={masked} />);
    expect(html).not.toMatch(/\$\d/);
  });
});

describe('PerformanceChart', () => {
  it('re-bases the drawn lines at their common start', () => {
    const html = renderToStaticMarkup(
      <PerformanceChart perf={{ data: perfData, loading: false, error: null }} privacy={false}
        sel={{ ...DEFAULT_RANGE, range: 'ALL' }} onSel={() => {}} />,
    );
    // All accounts and the S&P 500 are drawn by default: both from Dec 4.
    expect(html).toContain('+50.0%');
    expect(html).toContain('+60.0%');
    expect(html).not.toContain('+65.0%');
    expect(html).toContain('lines compared from Dec 4, 2021');
  });
  it('keeps a lone line on its own start', () => {
    store.set('mon.perfCompare', JSON.stringify([]));
    const html = renderToStaticMarkup(
      <PerformanceChart perf={{ data: perfData, loading: false, error: null }} privacy={false}
        sel={{ ...DEFAULT_RANGE, range: 'ALL' }} onSel={() => {}} />,
    );
    expect(html).toContain('+65.0%');
    expect(html).not.toContain('lines compared from');
  });
});

describe('ExposureCard', () => {
  it('calls mostly-direct top stocks "mostly held directly"', () => {
    store.set('mon.exposureTab', JSON.stringify('stocks'));
    const stock = (symbol: string, value: number, direct: number) => ({
      symbol, name: symbol, value, pct: value / 10000, accounts: [],
      sources: [{ label: 'Direct holding', value: direct }, { label: 'VTI', value: value - direct }],
    });
    const html = renderToStaticMarkup(
      <ExposureCard byCountry={[]} bySector={[]} byStock={[stock('AAPL', 1000, 600), stock('MSFT', 800, 450), stock('NVDA', 600, 270)]}
        money={usd} onLookThroughSaved={() => {}} />,
    );
    expect(html).toContain('mostly held directly');
  });
});
