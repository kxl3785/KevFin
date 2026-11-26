import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TaxPicture, { TaxControls } from './TaxPicture.tsx';
import { runForecastSim, type SimInput, type SimResult } from '../../lib/forecastSim.ts';
import { DEFAULT_TAX_PLAN, type TaxPlan } from '../../lib/taxPlan.ts';

// Static renders of the Tax picture card. Dollar figures go through a plain
// formatter (whole dollars), so the expected strings below are worked by hand.

const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, ' ');
const plan: TaxPlan = { ...DEFAULT_TAX_PLAN, mode: 'brackets' };

function input(over: Partial<SimInput>): SimInput {
  return {
    A: {
      endAge: 70, annualSpending: 0, eduInflation: 0,
      collegeStartAge: 18, collegeYears: 4, collegeCostPerYear: 0,
      gradStartAge: 22, gradYears: 2, gradCostPerYear: 0, gradCoverage: 0,
      effTaxRate: 0, investReturn: 0, volatility: 0, realEstateGrowth: 0, retireTaxRate: 0,
    },
    currentAge0: 66, infl: 0, costPerKid: 0, kidIndependentAge: 18, kidAges: [], events: [],
    earners: [{ currentAge: 66, income: 0, retireAge: 66, raisePct: 0, ssEnabled: false, ssClaimAge: 67, ssAnnual: 0, enabled: true }],
    pools0: { taxable: 0, pretax: 0, roth: 0, hsa: 0, college: 0 },
    contribByBucket: { taxable: 0, pretax: 0, roth: 0, hsa: 0, college: 0 },
    baseRE: 0, hsaLast: true, collegeOn: false, gradOn: false, spendingAdjust: 1, runs: 1, yearNow: 2026,
    tax: { mode: 'brackets', filing: 'single', stateRate: 0, conversions: null },
    ...over,
  };
}
const render = (sim: SimResult, p: { infl: number; currentAge0: number; retireAge: number; realDollars?: boolean; twoEarners?: boolean }) =>
  text(renderToStaticMarkup(createElement(TaxPicture, {
    plan, onChange: () => {}, sim, simNoConv: null, infl: p.infl, realDollars: p.realDollars ?? true,
    currentAge0: p.currentAge0, endAge: 90, retireAge: p.retireAge, filing: 'single', twoEarners: p.twoEarners, money, privacy: false,
  })));

describe('TaxControls', () => {
  it('labels the bracket-model checkbox itself, not the info button', () => {
    const html = renderToStaticMarkup(createElement(TaxControls, { plan: DEFAULT_TAX_PLAN, onChange: () => {}, twoEarners: false }));
    expect(html).toMatch(/<label for="fc-tax-brackets"/);
    expect(html).toMatch(/<input id="fc-tax-brackets" type="checkbox"/);
  });

  it('says that Single with two earners is one combined return', () => {
    const two = text(renderToStaticMarkup(createElement(TaxControls, { plan: { ...plan, filing: 'single' }, onChange: () => {}, twoEarners: true })));
    expect(two).toContain('Single (one combined return)');
    expect(two).toContain('overstates tax for an unmarried couple');
    const one = text(renderToStaticMarkup(createElement(TaxControls, { plan: { ...plan, filing: 'single' }, onChange: () => {}, twoEarners: false })));
    expect(one).not.toContain('combined return');
  });
});

describe('TaxPicture', () => {
  it('deflates a replayed historical year by its own inflation and names the starting year', () => {
    // 10% replayed inflation vs a 2% plan; 100,000 wage, no raise. Age 50 (year 10):
    // today's-dollar wages = 100,000 / 1.02^10 = 82,034.83 → "$82,035" (was $174,551).
    const sim = runForecastSim(input({
      currentAge0: 40, infl: 0.02,
      earners: [{ currentAge: 40, income: 100000, retireAge: 65, raisePct: 0, ssEnabled: false, ssClaimAge: 67, ssAnnual: 0, enabled: true }],
      A: { ...input({}).A, endAge: 69, annualSpending: 50000 },
      pools0: { taxable: 100000, pretax: 0, roth: 0, hsa: 0, college: 0 },
      returnModel: 'historical',
      historicalData: Array.from({ length: 30 }, (_, k) => ({ year: 1960 + k, stocks: 0, bonds: 0, bills: 0, inflation: 0.10 })),
    }));
    const t = render(sim, { infl: 0.02, currentAge0: 40, retireAge: 50 }); // retireAge picks the age-50 year
    expect(t).toContain('wages $82,035');
    expect(t).toContain('markets repeat what they did from 1960 onward');
    expect(t).toContain('not the replayed inflation');
  });

  it('lists every part of the income it totals, including gains on taxable withdrawals', () => {
    // 2026 single 66 spending 31,392 from taxable only: half is gain → 15,696 of gains,
    // all under the 24,150 deduction.
    const sim = runForecastSim(input({
      A: { ...input({}).A, endAge: 66, annualSpending: 31392 },
      pools0: { taxable: 1_000_000, pretax: 0, roth: 0, hsa: 0, college: 0 },
    }));
    const t = render(sim, { infl: 0, currentAge0: 66, retireAge: 66 });
    expect(t).toContain('of $15,696 received');
    expect(t).toContain('Income this year: gains on taxable-account withdrawals $15,696');
    expect(t).not.toContain('wages $0');
    // A simulated (not replayed) run is described as one typical run, with no starting year.
    expect(t).toContain('Taxes along one typical run of your plan: the simulated future that ends closest to the middle of all outcomes.');
    expect(t).not.toContain('markets repeat');
  });

  it('shows bracket room as the extra withdrawal that fits, counting Social Security', () => {
    // 2026 single 66 with 30,000 of SS only: 48,200 / 1.85 = 26,054.05 → "$26,054" (was $12,400).
    const sim = runForecastSim(input({
      A: { ...input({}).A, endAge: 66 },
      earners: [{ currentAge: 66, income: 0, retireAge: 66, raisePct: 0, ssEnabled: true, ssClaimAge: 66, ssAnnual: 30000, enabled: true }],
    }));
    const t = render(sim, { infl: 0, currentAge0: 66, retireAge: 66 });
    expect(t).toContain('Room left at 10% i $26,054'); // "i" is the tile's tip button
  });

  it('deflates the Medicare surcharge from its premium year, two years after the income year', () => {
    // From 71 in 2026 at 3% inflation with 8M pre-tax: at 75 (2030) the RMD is
    // 8M × (1 − 1/26.5) × (1 − 1/25.5) / 24.6 ≈ 300,659 of MAGI — tier 4 of the 2032
    // premiums (over 212,000 × 1.03^5 = 245,767). Its surcharge, (460.60 + 88.30) × 12 ×
    // 1.03^5 in 2032, is 6,586.80 × 1.03^5 / 1.03^6 = 6,394.95 in today's dollars.
    const sim = runForecastSim(input({
      currentAge0: 71, infl: 0.03,
      earners: [{ currentAge: 71, income: 0, retireAge: 65, raisePct: 0, ssEnabled: false, ssClaimAge: 67, ssAnnual: 0, enabled: true }],
      A: { ...input({}).A, endAge: 76 },
      pools0: { taxable: 0, pretax: 8_000_000, roth: 0, hsa: 0, college: 0 },
    }));
    const t = render(sim, { infl: 0.03, currentAge0: 71, retireAge: 75 }); // picks the age-75 year
    expect(t).toContain('2032 premiums · now +$6,395/yr each');
  });

  it('flags Single with two earners on the tax tile', () => {
    const sim = runForecastSim(input({ A: { ...input({}).A, endAge: 66 } }));
    expect(render(sim, { infl: 0, currentAge0: 66, retireAge: 66, twoEarners: true })).toContain('single, one combined return');
    expect(render(sim, { infl: 0, currentAge0: 66, retireAge: 66 })).not.toContain('combined return');
  });
});
