import { describe, it, expect } from 'vitest';
import {
  runForecastSim, completeHistoricalStarts, backcastHistory, rmdFactor, runSeed, mulberry32, bandOnReaching, balanceYearsOut, flowYearsOut, deflateReal, baselineMedianAt, restateFlow,
  type SimInput, type SimRealEstate,
} from './forecastSim.ts';
import { monthlyMortgagePayment, amortizeYear } from './mortgage.ts';
import { HISTORICAL_RETURNS, type HistoricalYear } from './historicalReturns.ts';
import { taxYearDetail } from './taxPlan.ts';

// A neutral baseline: one non-working earner, a single taxable pool, no income,
// no spending, no inflation, no taxes, no kids/education. Individual tests turn
// on just the dimension they exercise.
function baseInput(over: Partial<SimInput> = {}): SimInput {
  return {
    A: {
      endAge: 45,
      annualSpending: 0,
      eduInflation: 0,
      collegeStartAge: 18, collegeYears: 4, collegeCostPerYear: 0,
      gradStartAge: 22, gradYears: 2, gradCostPerYear: 0, gradCoverage: 0,
      effTaxRate: 0,
      investReturn: 0.05, volatility: 0,
      realEstateGrowth: 0,
      retireTaxRate: 0,
    },
    currentAge0: 40,
    infl: 0,
    costPerKid: 0,
    kidIndependentAge: 18,
    kidAges: [],
    events: [],
    // retireAge == currentAge → never working → no wage income or contributions.
    earners: [{ currentAge: 40, income: 0, retireAge: 40, raisePct: 0, ssEnabled: false, ssClaimAge: 67, ssAnnual: 0, enabled: true }],
    pools0: { taxable: 100000, pretax: 0, roth: 0, hsa: 0, college: 0 },
    contribByBucket: { taxable: 0, pretax: 0, roth: 0, hsa: 0, college: 0 },
    baseRE: 0,
    hsaLast: true,
    collegeOn: false,
    gradOn: false,
    spendingAdjust: 1,
    runs: 50,
    yearNow: 2026,
    ...over,
  };
}

describe('runForecastSim', () => {
  it('produces one band per projected year, labeled by age and calendar year', () => {
    const { bands } = runForecastSim(baseInput()); // ages 40..45 → 6 years
    expect(bands.length).toBe(6);
    bands.forEach((b, i) => {
      expect(b.age).toBe(40 + i);
      expect(b.year).toBe(2026 + i);
    });
  });

  it('floors the horizon at a single year when endAge precedes the current age', () => {
    const { bands } = runForecastSim(baseInput({ A: { ...baseInput().A, endAge: 39 } }));
    expect(bands.length).toBe(1);
  });

  it('matches closed-form compound growth when volatility is zero', () => {
    // No income, spending, or contributions → each pool just compounds at 5%.
    // After 6 yearly steps: 100000 · 1.05^6, identical across every run.
    const { bands, successPct } = runForecastSim(baseInput());
    const expected = 100000 * Math.pow(1.05, 6);
    const last = bands[bands.length - 1];
    expect(last.p50).toBeCloseTo(expected, 2);
    expect(last.band).toBe(0);       // zero volatility → no spread
    expect(successPct).toBe(100);    // no spending → never insolvent
  });

  it('grows real estate deterministically, independent of the random runs', () => {
    const { bands } = runForecastSim(baseInput({ baseRE: 500000, A: { ...baseInput().A, realEstateGrowth: 0.03 } }));
    bands.forEach((b, i) => {
      expect(b.re).toBe(Math.round(500000 * Math.pow(1.03, i + 1)));
    });
  });

  it('reports 0% success when spending dwarfs savings with no income', () => {
    const { bands, successPct } = runForecastSim(baseInput({
      pools0: { taxable: 1000, pretax: 0, roth: 0, hsa: 0, college: 0 },
      A: { ...baseInput().A, annualSpending: 100000 },
    }));
    expect(successPct).toBe(0);
    expect(bands[bands.length - 1].p50).toBe(0); // pools fully drained
  });

  it('is fully reproducible: identical inputs yield identical output', () => {
    const input = baseInput({ A: { ...baseInput().A, volatility: 0.15 } });
    expect(runForecastSim(input)).toEqual(runForecastSim(input));
  });

  it('produces a spread under volatility, with p10 ≤ p50 ≤ p90', () => {
    const { bands } = runForecastSim(baseInput({ A: { ...baseInput().A, volatility: 0.15 } }));
    const last = bands[bands.length - 1];
    expect(last.band).toBeGreaterThan(0);
    for (const b of bands) {
      expect(b.p10).toBeLessThanOrEqual(b.p50);
      expect(b.p50).toBeLessThanOrEqual(b.p10 + b.band); // p10 + band = p90
    }
  });

  it('taps home equity as a last resort only when opted in, lifting solvency', () => {
    // Retired now, spending far exceeds the tiny liquid pool, but a large house is
    // available. Without the toggle the run is insolvent (house untouched); with it,
    // home equity covers the shortfall and the run survives.
    const over = {
      pools0: { taxable: 5000, pretax: 0, roth: 0, hsa: 0, college: 0 },
      baseRE: 2_000_000,
      A: { ...baseInput().A, annualSpending: 80000, volatility: 0, realEstateGrowth: 0 },
    };
    const without = runForecastSim(baseInput(over));
    const withTap = runForecastSim(baseInput({ ...over, tapHomeEquity: true }));
    expect(without.successPct).toBe(0);
    expect(withTap.successPct).toBe(100);
    // And the net-worth band reflects the drawdown: the failing run keeps the whole
    // house, while the tapping run has spent part of it down by the final year.
    const last = (r: typeof without) => r.bands[r.bands.length - 1].p50;
    expect(last(withTap)).toBeLessThan(last(without));
  });

  it('does not tap home equity while still working, even when opted in', () => {
    // A working earner with a one-time cost they can't cover from liquid assets: the
    // house is off-limits during working years, so the toggle changes nothing.
    const over = {
      earners: [{ currentAge: 40, income: 10000, retireAge: 70, raisePct: 0, ssEnabled: false, ssClaimAge: 67, ssAnnual: 0, enabled: true }],
      pools0: { taxable: 1000, pretax: 0, roth: 0, hsa: 0, college: 0 },
      baseRE: 1_000_000,
      events: [{ type: 'oneTime', age: 41, amount: 500000 }],
      A: { ...baseInput().A, volatility: 0, realEstateGrowth: 0 },
    };
    expect(runForecastSim(baseInput(over)).successPct)
      .toBe(runForecastSim(baseInput({ ...over, tapHomeEquity: true })).successPct);
  });

  it('taxes Social Security at the retirement rate once nobody is working', () => {
    // Retired earner drawing only Social Security. The deterministic income net of
    // tax should reflect the retirement rate (15%), not the working rate (50%): with
    // a pool big enough to never need a withdrawal, end wealth = SS net of tax,
    // compounded. We isolate the tax path by checking the two rates diverge.
    const earner = { currentAge: 70, income: 0, retireAge: 65, raisePct: 0, ssEnabled: true, ssClaimAge: 67, ssAnnual: 100000, enabled: true };
    const base = {
      currentAge0: 70, earners: [earner],
      pools0: { taxable: 10_000_000, pretax: 0, roth: 0, hsa: 0, college: 0 },
      A: { ...baseInput().A, endAge: 71, investReturn: 0, volatility: 0, effTaxRate: 0.5, retireTaxRate: 0.15 },
    };
    const { bands } = runForecastSim(baseInput(base));
    // SS = 100k, 85% taxable at 15% → tax = 0.85*100k*0.15 = 12,750. Net SS added to
    // the pool in year 0 = 100k − 12,750 = 87,250 (no spending in the baseline).
    expect(bands[0].p50).toBeCloseTo(10_000_000 + 87_250, 0);
  });

  it('glide path narrows the outcome band versus staying fully invested', () => {
    const over = { A: { ...baseInput().A, endAge: 65, volatility: 0.15 } };
    const fully = runForecastSim(baseInput(over));
    const glided = runForecastSim(baseInput({ ...over, glidePath: true }));
    const lastBand = (r: typeof fully) => r.bands[r.bands.length - 1].band;
    expect(lastBand(glided)).toBeLessThan(lastBand(fully));
  });

  it('leaves results unchanged when the glide path is off (eq = 1)', () => {
    const input = baseInput({ A: { ...baseInput().A, volatility: 0.15 } });
    expect(runForecastSim({ ...input, glidePath: false })).toEqual(runForecastSim(input));
  });

  // A simple real-estate model: a $500k home with a $300k / 4% / 30yr loan.
  const payment = monthlyMortgagePayment(300000, 4, 30);
  const reModel = (over: Partial<SimRealEstate> = {}): SimRealEstate => ({
    properties: [{ value: 500000, balance: 300000, ratePct: 4, monthlyPI: payment, sellable: false }],
    propertyTaxAnnual: 0, insuranceAnnual: 0, hoaAnnual: 0, rentalIncomeAnnual: 0,
    taxGrowth: 0, insuranceGrowth: 0, hoaGrowth: 0, rentalGrowth: 0, ...over,
  });
  const noLoan = { value: 500000, balance: 0, ratePct: 0, monthlyPI: 0, sellable: false };

  it('models real-estate equity as appreciating value minus an amortizing balance', () => {
    const { bands } = runForecastSim(baseInput({ realEstate: reModel(), A: { ...baseInput().A, realEstateGrowth: 0.03 } }));
    // Independently track value and the amortizing balance year by year.
    let bal = 300000;
    bands.forEach((b, i) => {
      const value = 500000 * Math.pow(1.03, i + 1);
      bal = amortizeYear(bal, 4, payment).endBalance;
      expect(b.re).toBe(Math.round(value - bal));
    });
    // Equity rises (appreciation + paydown) and the loan is still active here.
    expect(bands[bands.length - 1].re).toBeGreaterThan(bands[0].re);
  });

  it('charges the mortgage payment as a housing outflow (lowers investable assets)', () => {
    const withPay = runForecastSim(baseInput({ realEstate: reModel() }));
    const noPay = runForecastSim(baseInput({ realEstate: reModel({ properties: [{ value: 500000, balance: 300000, ratePct: 4, monthlyPI: 0, sellable: false }] }) }));
    const inv = (r: typeof withPay) => r.bands[r.bands.length - 1].invP50;
    expect(inv(withPay)).toBeLessThan(inv(noPay)); // P&I draws down the liquid pool
  });

  it('charges property tax / insurance / HOA as ongoing housing costs', () => {
    const withCarry = runForecastSim(baseInput({ realEstate: reModel({ properties: [noLoan], propertyTaxAnnual: 6000, insuranceAnnual: 2000, hoaAnnual: 4000 }) }));
    const noCarry = runForecastSim(baseInput({ realEstate: reModel({ properties: [noLoan] }) }));
    const inv = (r: typeof withCarry) => r.bands[r.bands.length - 1].invP50;
    expect(inv(withCarry)).toBeLessThan(inv(noCarry));
  });

  it('adds rental income to cash flow (raises wealth and the income line)', () => {
    const withRent = runForecastSim(baseInput({ realEstate: reModel({ properties: [noLoan], rentalIncomeAnnual: 24000 }) }));
    const noRent = runForecastSim(baseInput({ realEstate: reModel({ properties: [noLoan] }) }));
    const inv = (r: typeof withRent) => r.bands[r.bands.length - 1].invP50;
    expect(inv(withRent)).toBeGreaterThan(inv(noRent)); // rent compounds into savings
    // It shows up in the income line, and offsets the housing cost in the net.
    expect(withRent.bands[0].income).toBe(noRent.bands[0].income + 24000);
  });

  it('frees up cash flow once the mortgage is paid off', () => {
    // A loan that's one year from payoff: P&I is charged in year 0 but gone after,
    // so the spending line (which includes the housing outflow) drops to ~0.
    const nearPayoff = reModel({ properties: [{ value: 500000, balance: payment * 11, ratePct: 0, monthlyPI: payment, sellable: false }] });
    const { bands } = runForecastSim(baseInput({ realEstate: nearPayoff }));
    expect(bands[0].spending).toBeGreaterThan(0);        // still paying in year 0
    expect(bands[bands.length - 1].spending).toBe(0);    // paid off → outflow gone
  });

  it('only taps the equity of properties marked sellable to fund retirement', () => {
    // Retired now, tiny liquid pool, two paid-off homes of equal equity. Equity only
    // covers shortfalls for the home(s) flagged sellable.
    const home = (sellable: boolean) => ({ value: 1_000_000, balance: 0, ratePct: 0, monthlyPI: 0, sellable });
    const re = (s0: boolean, s1: boolean): SimRealEstate => ({
      properties: [home(s0), home(s1)],
      propertyTaxAnnual: 0, insuranceAnnual: 0, hoaAnnual: 0, rentalIncomeAnnual: 0, taxGrowth: 0, insuranceGrowth: 0, hoaGrowth: 0, rentalGrowth: 0,
    });
    const over = { pools0: { taxable: 5000, pretax: 0, roth: 0, hsa: 0, college: 0 }, A: { ...baseInput().A, annualSpending: 80000, volatility: 0, realEstateGrowth: 0 } };
    const none = runForecastSim(baseInput({ ...over, realEstate: re(false, false) }));
    const one = runForecastSim(baseInput({ ...over, realEstate: re(true, false) }));
    expect(none.successPct).toBe(0);           // nothing sellable → insolvent despite $2M of homes
    expect(one.successPct).toBe(100);          // one sellable home covers the shortfalls
  });

  it('falls back to the legacy baseRE growth when no real-estate model is supplied', () => {
    const legacy = runForecastSim(baseInput({ baseRE: 500000, A: { ...baseInput().A, realEstateGrowth: 0.03 } }));
    legacy.bands.forEach((b, i) => expect(b.re).toBe(Math.round(500000 * Math.pow(1.03, i + 1))));
  });

  it('treats a one-time sale (isSale) as a windfall — the opposite of a one-time cost', () => {
    const none = runForecastSim(baseInput());
    const cost = runForecastSim(baseInput({ events: [{ type: 'oneTime', age: 41, amount: 100000 }] }));
    const sale = runForecastSim(baseInput({ events: [{ type: 'oneTime', age: 41, amount: 100000, isSale: true }] }));
    const fin = (r: typeof none) => r.bands[r.bands.length - 1].p50;
    expect(fin(sale)).toBeGreaterThan(fin(none)); // proceeds add wealth
    expect(fin(cost)).toBeLessThan(fin(none));    // a purchase removes it
    // Symmetric: a sale adds as much as the same-size purchase subtracts.
    expect(fin(sale) - fin(none)).toBeCloseTo(fin(none) - fin(cost), 0);
    // The proceeds land in that year's income line (a spike), not spending.
    const band = sale.bands.find(b => b.age === 41)!;
    expect(band.income).toBeGreaterThanOrEqual(100000);
    expect(band.spending).toBe(none.bands.find(b => b.age === 41)!.spending);
  });

  it('grows a rated manual asset steadily, on top of the investment pools', () => {
    // A $50k holding at a fixed 4% sits alongside the 100k taxable pool (5%, no
    // volatility). Net worth is the sum of both closed-form trajectories, and the
    // deterministic rate means no spread across runs.
    const { bands } = runForecastSim(baseInput({ manualAssets: [{ value: 50000, rate: 0.04 }] }));
    const last = bands[bands.length - 1];
    expect(last.p50).toBeCloseTo(100000 * Math.pow(1.05, 6) + 50000 * Math.pow(1.04, 6), 2);
    expect(last.band).toBe(0);
  });

  it('compounds a manual liability (negative value) as growing debt', () => {
    // A −$10k debt at 6% drags net worth down by more each year than a flat one.
    const debt = runForecastSim(baseInput({ manualAssets: [{ value: -10000, rate: 0.06 }] }));
    const none = runForecastSim(baseInput());
    const last = (r: typeof none) => r.bands[r.bands.length - 1].p50;
    expect(last(debt)).toBeCloseTo(last(none) - 10000 * Math.pow(1.06, 6), 2);
    expect(last(debt)).toBeLessThan(last(none) - 10000); // grew beyond the original balance
  });

  it('spends down a manual asset to cover a retirement shortfall, lifting solvency', () => {
    // Retired, a tiny liquid pool, spending far above it — but a large cash-like
    // manual asset is available and gets drawn first, so the plan survives.
    const over = {
      pools0: { taxable: 5000, pretax: 0, roth: 0, hsa: 0, college: 0 },
      A: { ...baseInput().A, annualSpending: 80000, volatility: 0 },
    };
    const without = runForecastSim(baseInput(over));
    const withManual = runForecastSim(baseInput({ ...over, manualAssets: [{ value: 500000, rate: 0 }] }));
    expect(without.successPct).toBe(0);
    expect(withManual.successPct).toBe(100);
    // And the drawdown shows up: final wealth is below the un-spent starting balance.
    expect(withManual.bands[withManual.bands.length - 1].p50).toBeLessThan(505000);
  });

  it('leaves the forecast unchanged when no manual assets are supplied', () => {
    const input = baseInput({ A: { ...baseInput().A, volatility: 0.12 } });
    expect(runForecastSim({ ...input, manualAssets: [] })).toEqual(runForecastSim(input));
  });

  describe('backcastHistory', () => {
    it('returns nothing when there are no preceding years to show', () => {
      expect(backcastHistory(baseInput(), 40)).toEqual([]); // startAge == currentAge0
      expect(backcastHistory(baseInput(), 45)).toEqual([]); // startAge > currentAge0
    });

    it('produces one collapsed (band-free) point per preceding year, oldest first', () => {
      const past = backcastHistory(baseInput(), 35); // ages 35..39
      expect(past.map(b => b.age)).toEqual([35, 36, 37, 38, 39]);
      past.forEach(b => { expect(b.band).toBe(0); expect(b.p10).toBe(b.p50); });
    });

    it('back-projects a saver to lower past wealth than today', () => {
      // A working earner saving each year → investable was smaller in the past.
      const input = baseInput({
        earners: [{ currentAge: 40, income: 120000, retireAge: 70, raisePct: 0, ssEnabled: false, ssClaimAge: 67, ssAnnual: 0, enabled: true }],
        A: { ...baseInput().A, annualSpending: 50000 },
      });
      const past = backcastHistory(input, 36);
      const today = input.pools0.taxable; // 100000
      // The newest point anchors at today's balances (end-of-year values, so
      // the line meets the forward bands without a two-year gap at "Today")…
      expect(past[past.length - 1].invP50).toBeCloseTo(today);
      // …and a saver's earlier years sit below it, rising monotonically toward today.
      expect(past[0].invP50).toBeLessThan(today);
      for (let i = 1; i < past.length; i++) expect(past[i].invP50).toBeGreaterThanOrEqual(past[i - 1].invP50);
    });
  });

  describe('employer match', () => {
    const earner = { currentAge: 40, income: 100000, retireAge: 70, raisePct: 0, ssEnabled: false, ssClaimAge: 67, ssAnnual: 0, enabled: true };

    it('adds the match to pre-tax wealth without charging cash or taxes', () => {
      // Identical household, ±match. The whole difference must be the match
      // itself compounding — nothing else (cash, taxes, spending) may move.
      const A = { ...baseInput().A, effTaxRate: 0.3, annualSpending: 60000 };
      const withMatch = runForecastSim(baseInput({ earners: [{ ...earner, employerMatch: 10000 }], A }));
      const without = runForecastSim(baseInput({ earners: [earner], A }));
      // Match lands after each year's growth: year i's 10k compounds 5−i years.
      const expectedDiff = [0, 1, 2, 3, 4, 5].reduce((s, i) => s + 10000 * Math.pow(1.05, 5 - i), 0);
      const diff = withMatch.bands[5].p50 - without.bands[5].p50;
      expect(diff).toBeCloseTo(expectedDiff, 0);
      // And the cash-flow lines are untouched — the match is not income or spending.
      expect(withMatch.bands[0].income).toBe(without.bands[0].income);
      expect(withMatch.bands[0].spending).toBe(without.bands[0].spending);
    });

    it('is worth more than the same dollars contributed by the employee', () => {
      // Employee dollars come out of the household's cash (minus the deduction);
      // the match is free money on top — so the match run must end wealthier.
      const A = { ...baseInput().A, effTaxRate: 0.3, annualSpending: 60000 };
      const match = runForecastSim(baseInput({ earners: [{ ...earner, employerMatch: 10000 }], A }));
      const employee = runForecastSim(baseInput({
        earners: [earner], A,
        contribByBucket: { taxable: 0, pretax: 10000, roth: 0, hsa: 0, college: 0 },
      }));
      expect(match.bands[5].p50).toBeGreaterThan(employee.bands[5].p50);
    });

    it('backcasts a matched saver to lower past wealth (the match explains part of today)', () => {
      const A = { ...baseInput().A, annualSpending: 50000 };
      const withMatch = backcastHistory(baseInput({ earners: [{ ...earner, employerMatch: 10000 }], A }), 36);
      const without = backcastHistory(baseInput({ earners: [earner], A }), 36);
      expect(withMatch[0].invP50).toBeLessThan(without[0].invP50);
      // Both still anchor the newest point at today's balances.
      expect(withMatch[withMatch.length - 1].invP50).toBeCloseTo(100000);
    });
  });

  it('rewards pre-tax contributions via tax deferral (lower tax → higher wealth)', () => {
    // Same wages and tax rate; the only difference is a deductible pre-tax
    // contribution, which shrinks taxable income and the tax bill — so the saver
    // ends up ahead. (A *taxable* contribution would be net-neutral.)
    const earner = { currentAge: 40, income: 200000, retireAge: 70, raisePct: 0, ssEnabled: false, ssClaimAge: 67, ssAnnual: 0, enabled: true };
    const taxed = { ...baseInput().A, effTaxRate: 0.3 };
    const withPretax = runForecastSim(baseInput({
      earners: [earner], A: taxed,
      contribByBucket: { taxable: 0, pretax: 20000, roth: 0, hsa: 0, college: 0 },
    }));
    const without = runForecastSim(baseInput({ earners: [earner], A: taxed }));
    const a = withPretax.bands[withPretax.bands.length - 1].p50;
    const b = without.bands[without.bands.length - 1].p50;
    expect(a).toBeGreaterThan(b);
  });

  describe('band timing (END-of-year convention)', () => {
    // Zero volatility, 100k, 10% return, no flows, no inflation: every run is identical.
    const A = { ...baseInput().A, investReturn: 0.10, endAge: 65 };
    const input = baseInput({ A });

    it('labels band X with the balance at the END of age X', () => {
      const { bands } = runForecastSim(input);
      // age 40 is the first projected year → one full year of growth already applied.
      expect(bands[0].age).toBe(40);
      expect(bands[0].p50).toBeCloseTo(110000, 2);
      expect(bands[25].age).toBe(65);
      expect(bands[25].p50).toBeCloseTo(100000 * Math.pow(1.1, 26), 2);
    });

    it('reads the balance ON REACHING an age from the band one year earlier', () => {
      const { bands } = runForecastSim(input);
      // Retire at 65 → balance on the 65th birthday = end of age 64 = 100k·1.1^25,
      // NOT the age-65 band (which already holds a year of retirement draws/growth).
      const b = bandOnReaching(bands, 40, 65)!;
      expect(b.age).toBe(64);
      expect(b.p50).toBeCloseTo(100000 * Math.pow(1.1, 25), 2);
      // Retiring at/before today → today's balances (null = caller uses currentNW).
      expect(bandOnReaching(bands, 40, 40)).toBeNull();
      expect(bandOnReaching(bands, 40, 30)).toBeNull();
      // Retiring next year → end of this year (band 40).
      expect(bandOnReaching(bands, 40, 41)!.age).toBe(40);
      // Beyond the horizon → the final band (caller deflates by ITS age).
      expect(bandOnReaching(bands, 40, 80)!.age).toBe(65);
    });

    it('prices balances (end of year) one year further out than flows (start of year)', () => {
      expect(balanceYearsOut(40, 40)).toBe(1);   // first band: 1 year out
      expect(balanceYearsOut(39, 40)).toBe(0);   // newest backcast point = today
      expect(flowYearsOut(40, 40)).toBe(0);      // year-0 flows are in today's dollars
      // 3% inflation: the age-40 balance 110k is worth 110k/1.03 today, not 110k.
      expect(110000 / Math.pow(1.03, balanceYearsOut(40, 40))).toBeCloseTo(106796.12, 2);
    });
  });

  describe('today\'s-dollars helpers', () => {
    it('deflates a balance by its years out at the given inflation', () => {
      expect(deflateReal(110000, balanceYearsOut(40, 40), 0.03)).toBeCloseTo(106796.12, 2);
      expect(deflateReal(5000, 0, 0.03)).toBe(5000);
      expect(deflateReal(-250000, 10, 0)).toBe(-250000);
    });

    it('compares a baseline at the same age, deflating both sides alike', () => {
      const baseline = { bands: [{ age: 60, p50: 800000 }, { age: 65, p50: 1000000 }], futureNW: 1000000 };
      expect(baselineMedianAt(baseline, 60)).toBe(800000);
      // Horizon moved past the pin's last band → its final median.
      expect(baselineMedianAt(baseline, 70)).toBe(1000000);
      // Delta in today's $ (30 years out at 3%) shrinks by the same factor as each side.
      const yrs = balanceYearsOut(65, 40);
      const nowNom = 1300000;
      const d = deflateReal(nowNom, yrs, 0.03) - deflateReal(baselineMedianAt(baseline, 65), yrs, 0.03);
      expect(d).toBeCloseTo(deflateReal(nowNom - 1000000, yrs, 0.03), 6);
    });
  });

  describe('income events', () => {
    const earner = { currentAge: 40, income: 100000, retireAge: 70, raisePct: 0.02, ssEnabled: false, ssClaimAge: 67, ssAnnual: 0, enabled: true };

    it('clamps a large negative dollar income event so wages never go below zero', () => {
      const input = baseInput({ earners: [earner], events: [{ type: 'income', age: 40, amount: -500000 }] });
      const { bands } = runForecastSim(input);
      bands.forEach(b => expect(b.income).toBeGreaterThanOrEqual(0));
      expect(bands[0].income).toBe(0);
      // And the back-projection mirrors it.
      backcastHistory(input, 35).forEach(b => expect(b.income).toBeGreaterThanOrEqual(0));
    });

    it('scales a dollar income event with earner 0\'s raise (not flat nominal)', () => {
      const input = baseInput({ earners: [earner], events: [{ type: 'income', age: 40, amount: -40000 }] });
      const { bands } = runForecastSim(input);
      // wage = (100k − 40k) · 1.02^i  (endAge 45 → 6 bands)
      expect(bands[0].income).toBe(60000);
      expect(bands[5].income).toBe(Math.round(60000 * Math.pow(1.02, 5)));
    });
  });

  describe('contributions when earners retire at different times', () => {
    const e0 = { currentAge: 40, income: 100000, retireAge: 45, raisePct: 0, ssEnabled: false, ssClaimAge: 67, ssAnnual: 0, enabled: true };
    const e1 = { currentAge: 40, income: 100000, retireAge: 60, raisePct: 0, ssEnabled: false, ssClaimAge: 67, ssAnnual: 0, enabled: true };
    const A = { ...baseInput().A, investReturn: 0, endAge: 50 };
    const contrib = { taxable: 20000, pretax: 0, roth: 0, hsa: 0, college: 0 };

    it('tapers contributions to the share of income still earned', () => {
      // 0% return, no spending, 30% tax. A deductible pre-tax contribution P adds 0.3·P
      // of wealth (the tax it saves) and is otherwise neutral, so the with/without gap
      // reads out the effective contribution. Ages 40–44 both earners work (full 20k/yr);
      // ages 45–49 only e1 works → half the base income → 10k/yr.
      const taxed = { ...A, effTaxRate: 0.3 };
      const withC = runForecastSim(baseInput({ A: taxed, earners: [e0, e1], contribByBucket: { ...contrib, taxable: 0, pretax: 20000 } }));
      const without = runForecastSim(baseInput({ A: taxed, earners: [e0, e1] }));
      expect(withC.bands[4].p50 - without.bands[4].p50).toBeCloseTo(0.3 * 5 * 20000, 2);
      expect(withC.bands[9].p50 - without.bands[9].p50).toBeCloseTo(0.3 * (5 * 20000 + 5 * 10000), 2);
    });

    it('stops the employer match when THAT earner stops working', () => {
      const m0 = { ...e0, employerMatch: 10000 }, m1 = { ...e1, employerMatch: 0 };
      const withM = runForecastSim(baseInput({ A, earners: [m0, m1] }));
      const without = runForecastSim(baseInput({ A, earners: [e0, e1] }));
      // 5 working years (ages 40–44) of 10k each at 0% return, then nothing more.
      expect(withM.bands[4].p50 - without.bands[4].p50).toBeCloseTo(50000, 2);
      expect(withM.bands[9].p50 - without.bands[9].p50).toBeCloseTo(50000, 2);
    });
  });

  describe('RMD divisors', () => {
    it('is zero before 73 and follows the IRS Uniform Lifetime Table after', () => {
      expect(rmdFactor(72)).toBe(0);
      expect(rmdFactor(73)).toBeCloseTo(1 / 26.5, 10);
      expect(rmdFactor(75)).toBeCloseTo(1 / 24.6, 10);
      expect(rmdFactor(90)).toBeCloseTo(1 / 12.2, 10);
      expect(rmdFactor(100)).toBeCloseTo(1 / 6.4, 10);
      expect(rmdFactor(120)).toBeCloseTo(1 / 2.0, 10);
      expect(rmdFactor(130)).toBeCloseTo(1 / 2.0, 10); // clamped
    });
  });

  describe('per-run seeding', () => {
    it('gives every run its own seed', () => {
      const seeds = new Set(Array.from({ length: 2000 }, (_, s) => runSeed(s)));
      expect(seeds.size).toBe(2000);
    });

    it('does not produce shifted copies of one stream', () => {
      // mulberry32 advances its state by a constant; seed + s·const would make run s+1's
      // stream run s's stream shifted by one draw. Hashed seeds must not do that.
      const a = mulberry32(runSeed(0)), b = mulberry32(runSeed(1));
      const da = [a(), a(), a(), a()], db = [b(), b(), b(), b()];
      expect(db.slice(0, 3)).not.toEqual(da.slice(1));
    });

    it('keeps a year\'s draws fixed when the horizon changes', () => {
      const A = { ...baseInput().A, volatility: 0.15, endAge: 45 };
      const short = runForecastSim(baseInput({ A }));
      const long = runForecastSim(baseInput({ A: { ...A, endAge: 70 } }));
      for (let i = 0; i < short.bands.length; i++) {
        expect(long.bands[i].p10).toBeCloseTo(short.bands[i].p10, 6);
        expect(long.bands[i].p50).toBeCloseTo(short.bands[i].p50, 6);
      }
    });
  });
});

// --- Bracket tax model (opt-in) ------------------------------------------------
// Expected values are worked by hand from the 2026 / 2027 IRS tables (see
// taxCalc.test.ts for the table arithmetic). Zero volatility and zero return make
// every run identical, so the median path is that one deterministic path.
describe('bracket tax model', () => {
  const det = (over: Partial<SimInput['A']> = {}) => ({ ...baseInput().A, investReturn: 0, volatility: 0, ...over });
  const retiree = (age: number, extra: Partial<SimInput['earners'][number]> = {}) =>
    ({ currentAge: age, income: 0, retireAge: age, raisePct: 0, ssEnabled: false, ssClaimAge: 67, ssAnnual: 0, enabled: true, ...extra });
  const brackets = (over: Partial<NonNullable<SimInput['tax']>> = {}): NonNullable<SimInput['tax']> =>
    ({ mode: 'brackets', filing: 'single', stateRate: 0, conversions: null, ...over });

  it('leaves every number unchanged in flat mode (the default)', () => {
    const over: Partial<SimInput> = {
      A: { ...baseInput().A, volatility: 0.15, annualSpending: 30000, endAge: 80 },
      pools0: { taxable: 200000, pretax: 400000, roth: 50000, hsa: 10000, college: 0 },
    };
    const plain = runForecastSim(baseInput(over));
    const flat = runForecastSim(baseInput({ ...over, tax: { mode: 'flat', filing: 'joint', stateRate: 0.05, conversions: { startAge: 60, endAge: 70, bracketRate: 0.22, irmaaCap: true } } }));
    expect(flat).toEqual(plain);
    expect(flat.tax).toBeUndefined();
  });

  it('grosses up a pre-tax withdrawal so spending is met after federal tax', () => {
    // Single, 66, spends 50,000 from a 401(k). Deduction 16,100 + 2,050 + 6,000 (senior) = 24,150.
    // X − [1,240 + 12% × (X − 24,150 − 12,400)] = 50,000 → 0.88X = 46,854 → X = 53,243.18; tax 3,243.18.
    const r = runForecastSim(baseInput({
      currentAge0: 66, earners: [retiree(66)],
      A: det({ endAge: 66, annualSpending: 50000 }),
      pools0: { taxable: 0, pretax: 1_000_000, roth: 0, hsa: 0, college: 0 },
      tax: brackets(),
    }));
    const y = r.tax!.medianPath[0];
    expect(y.pretaxDraw).toBeCloseTo(53243.18, 1);
    expect(y.fedTax).toBeCloseTo(3243.18, 1);
    expect(r.bands[0].invP50).toBeCloseTo(1_000_000 - 53243.18, 1);
    expect(r.successPct).toBe(100);
  });

  it('taxes realised gains on taxable withdrawals at 0% inside the 0% zone', () => {
    // 100,000 withdrawn, half gain: AGI 50,000, taxable 33,900 — all under 49,450 → no tax.
    const r = runForecastSim(baseInput({
      currentAge0: 50, earners: [retiree(50)],
      A: det({ endAge: 50, annualSpending: 100000 }),
      pools0: { taxable: 1_000_000, pretax: 0, roth: 0, hsa: 0, college: 0 },
      tax: brackets(),
    }));
    expect(r.tax!.medianPath[0].gains).toBeCloseTo(50000, 2);
    expect(r.tax!.medianPath[0].fedTax).toBeCloseTo(0, 6);
    expect(r.bands[0].invP50).toBeCloseTo(900000, 2);
  });

  it('grosses up a taxable withdrawal whose gains spill into the 15% zone', () => {
    // W − 15% × (0.5W − 16,100 − 49,450) = 200,000 → 0.925W = 190,167.50 → W = 205,586.49.
    const r = runForecastSim(baseInput({
      currentAge0: 50, earners: [retiree(50)],
      A: det({ endAge: 50, annualSpending: 200000 }),
      pools0: { taxable: 1_000_000, pretax: 0, roth: 0, hsa: 0, college: 0 },
      tax: brackets(),
    }));
    expect(r.bands[0].invP50).toBeCloseTo(1_000_000 - 205586.49, 1);
    expect(r.tax!.medianPath[0].fedTax).toBeCloseTo(5586.49, 1);
  });

  it('charges federal, payroll and flat state tax on wages', () => {
    // Wages 100,000: federal on 83,900 = 5,800 + 22% × 33,500 = 13,170; payroll 7.65% = 7,650;
    // state 5% × 83,900 = 4,195. Saved: 100,000 − 25,015 = 74,985.
    const r = runForecastSim(baseInput({
      earners: [{ currentAge: 40, income: 100000, retireAge: 65, raisePct: 0, ssEnabled: false, ssClaimAge: 67, ssAnnual: 0, enabled: true }],
      A: det({ endAge: 40 }),
      pools0: { taxable: 0, pretax: 0, roth: 0, hsa: 0, college: 0 },
      tax: brackets({ stateRate: 0.05 }),
    }));
    const y = r.tax!.medianPath[0];
    expect(y.fedTax).toBeCloseTo(13170, 6);
    expect(y.payroll).toBeCloseTo(7650, 6);
    expect(y.stateTax).toBeCloseTo(4195, 6);
    expect(r.bands[0].invP50).toBeCloseTo(74985, 4);
  });

  it('converts to the top of the chosen bracket and pays the tax from the taxable account', () => {
    // 2029 at 0% inflation = the 2027 table; no senior deduction after 2028.
    // Single 66: deduction 16,600 + 2,100 = 18,700; 12% top 52,025 → X = 70,725.
    // Tax 1,280 + 12% × 39,225 = 5,987; paid from taxable whose half-gain sits in the 15% zone:
    // w = 5,987 + 15% × 0.5w → w = 6,472.43.
    const r = runForecastSim(baseInput({
      currentAge0: 66, earners: [retiree(66)], yearNow: 2029,
      A: det({ endAge: 66 }),
      pools0: { taxable: 500000, pretax: 1_000_000, roth: 0, hsa: 0, college: 0 },
      tax: brackets({ conversions: { startAge: 60, endAge: 75, bracketRate: 0.12, irmaaCap: false } }),
    }));
    const y = r.tax!.medianPath[0];
    expect(Math.abs(y.conversion - 70725)).toBeLessThan(1.5);
    expect(y.fedTax).toBeCloseTo(5987 + 0.15 * 0.5 * 6472.43, -1);
    expect(Math.abs(r.bands[0].invP50 - (1_500_000 - 6472.43))).toBeLessThan(1);
  });

  it('shrinks the conversion when the taxable account cannot cover its tax', () => {
    const r = runForecastSim(baseInput({
      currentAge0: 66, earners: [retiree(66)], yearNow: 2029,
      A: det({ endAge: 66 }),
      pools0: { taxable: 3000, pretax: 1_000_000, roth: 0, hsa: 0, college: 0 },
      tax: brackets({ conversions: { startAge: 60, endAge: 75, bracketRate: 0.12, irmaaCap: false } }),
    }));
    const y = r.tax!.medianPath[0];
    expect(y.conversion).toBeGreaterThan(18700); // more than the free deduction room
    expect(y.conversion).toBeLessThan(70725);
    // Total wealth only falls by the tax, which used up (almost) all of the 3,000.
    expect(r.bands[0].invP50).toBeGreaterThan(1_003_000 - 3000 - 0.5);
    expect(r.bands[0].invP50).toBeLessThan(1_003_000 - 3000 + 2);
  });

  it('still converts the tax-free deduction room with no taxable account to pay tax from', () => {
    // 2029 single 66: deduction 18,700 — converting that much owes nothing.
    const r = runForecastSim(baseInput({
      currentAge0: 66, earners: [retiree(66)], yearNow: 2029,
      A: det({ endAge: 66 }),
      pools0: { taxable: 0, pretax: 1_000_000, roth: 0, hsa: 0, college: 0 },
      tax: brackets({ conversions: { startAge: 60, endAge: 75, bracketRate: 0.22, irmaaCap: false } }),
    }));
    const y = r.tax!.medianPath[0];
    expect(Math.abs(y.conversion - 18700)).toBeLessThan(1.5);
    expect(y.fedTax).toBeLessThan(0.5);
    expect(r.bands[0].invP50).toBeCloseTo(1_000_000, 0);
  });

  it('does not convert outside the age window', () => {
    const r = runForecastSim(baseInput({
      currentAge0: 66, earners: [retiree(66)], yearNow: 2029,
      A: det({ endAge: 66 }),
      pools0: { taxable: 500000, pretax: 1_000_000, roth: 0, hsa: 0, college: 0 },
      tax: brackets({ conversions: { startAge: 67, endAge: 75, bracketRate: 0.12, irmaaCap: false } }),
    }));
    expect(r.tax!.medianPath[0].conversion).toBe(0);
    expect(r.bands[0].invP50).toBeCloseTo(1_500_000, 6);
  });

  it('can stop a conversion before the next Medicare surcharge tier', () => {
    const input = (irmaaCap: boolean) => baseInput({
      currentAge0: 66, earners: [retiree(66)], yearNow: 2029,
      A: det({ endAge: 66 }),
      pools0: { taxable: 1_000_000, pretax: 2_000_000, roth: 0, hsa: 0, college: 0 },
      tax: brackets({ conversions: { startAge: 60, endAge: 75, bracketRate: 0.24, irmaaCap } }),
    });
    const free = runForecastSim(input(false)).tax!.medianPath[0];
    const capped = runForecastSim(input(true)).tax!.medianPath[0];
    // Uncapped: to the 24% top (where 32% starts), 208,325 + 18,700 = 227,025 — well past 112,000.
    expect(Math.abs(free.conversion - 227025)).toBeLessThan(1.5);
    // Capped: MAGI (conversion + gains realised paying its tax) stays at or under 112,000.
    expect(capped.magi).toBeLessThanOrEqual(112000 + 0.05);
    expect(capped.magi).toBeGreaterThan(112000 - 2);
    expect(capped.conversion).toBeLessThan(free.conversion);
  });

  it('charges Medicare surcharges from MAGI two years back', () => {
    // Age 75, 5M pre-tax → RMD ≈ 203k, plus SS 100k (85% taxable): MAGI ≈ 288k, tier 4
    // (over 212,000, under 500,000). 2029 premiums use the 2027 table at 0% inflation:
    // (460.60 + 88.30) × 12 = 6,586.80. Years 0 and 1 have no look-back income.
    const r = runForecastSim(baseInput({
      currentAge0: 75, earners: [retiree(65, { currentAge: 75, ssEnabled: true, ssAnnual: 100000 })], yearNow: 2027,
      A: det({ endAge: 77 }),
      pools0: { taxable: 1_000_000, pretax: 5_000_000, roth: 0, hsa: 0, college: 0 },
      tax: brackets(),
    }));
    const p = r.tax!.medianPath;
    expect(p.length).toBe(3);
    expect(p[0].irmaaCost).toBe(0);
    expect(p[1].irmaaCost).toBe(0);
    expect(p[0].magi).toBeGreaterThan(212000);
    expect(p[2].irmaaCost).toBeCloseTo(6586.8, 6);
    expect(p[0].rmd).toBeCloseTo(5_000_000 / 24.6, 4);
  });

  it('reports lifetime federal tax and stays finite under volatility and inflation', () => {
    const r = runForecastSim(baseInput({
      currentAge0: 60, earners: [{ currentAge: 60, income: 150000, retireAge: 65, raisePct: 0.02, ssEnabled: true, ssClaimAge: 67, ssAnnual: 30000, enabled: true }],
      A: { ...baseInput().A, endAge: 90, volatility: 0.15, investReturn: 0.06, annualSpending: 80000 },
      infl: 0.03,
      pools0: { taxable: 300000, pretax: 900000, roth: 100000, hsa: 0, college: 0 },
      tax: brackets({ filing: 'single', stateRate: 0.04, conversions: { startAge: 65, endAge: 72, bracketRate: 0.22, irmaaCap: true } }),
    }));
    expect(r.tax!.medianPath.length).toBe(31);
    expect(r.tax!.lifetimeFedTax).toBeGreaterThan(0);
    expect(r.tax!.lifetimeFedTaxReal).toBeLessThan(r.tax!.lifetimeFedTax);
    for (const y of r.tax!.medianPath) {
      for (const v of [y.fedTax, y.stateTax, y.payroll, y.magi, y.conversion, y.gains, y.irmaaCost]) expect(Number.isFinite(v)).toBe(true);
    }
    for (const b of r.bands) expect(Number.isFinite(b.p50) && Number.isFinite(b.p10)).toBe(true);
    // Reproducible like the flat model.
    expect(runForecastSim(baseInput({
      currentAge0: 60, earners: [{ currentAge: 60, income: 150000, retireAge: 65, raisePct: 0.02, ssEnabled: true, ssClaimAge: 67, ssAnnual: 30000, enabled: true }],
      A: { ...baseInput().A, endAge: 90, volatility: 0.15, investReturn: 0.06, annualSpending: 80000 },
      infl: 0.03,
      pools0: { taxable: 300000, pretax: 900000, roth: 100000, hsa: 0, college: 0 },
      tax: brackets({ filing: 'single', stateRate: 0.04, conversions: { startAge: 65, endAge: 72, bracketRate: 0.22, irmaaCap: true } }),
    }))).toEqual(r);
  });

  it('reports 0% success, not NaN, when spending cannot be met', () => {
    const r = runForecastSim(baseInput({
      A: det({ annualSpending: 500000 }),
      tax: brackets(),
    }));
    expect(r.successPct).toBe(0);
    expect(r.bands.every(b => Number.isFinite(b.p50))).toBe(true);
  });

  it('leaves HSA payroll contributions out of payroll tax (but not 401(k) deferrals)', () => {
    // 100,000 wage, 8,000 HSA through payroll: FICA wages 92,000 → 7.65% = 7,038 (not 7,650).
    const hsa = runForecastSim(baseInput({
      earners: [{ currentAge: 40, income: 100000, retireAge: 65, raisePct: 0, ssEnabled: false, ssClaimAge: 67, ssAnnual: 0, enabled: true }],
      A: det({ endAge: 40 }), pools0: { taxable: 0, pretax: 0, roth: 0, hsa: 0, college: 0 },
      contribByBucket: { taxable: 0, pretax: 0, roth: 0, hsa: 8000, college: 0 },
      tax: brackets(),
    })).tax!.medianPath[0];
    expect(hsa.wages).toBeCloseTo(92000, 6);
    expect(hsa.payroll).toBeCloseTo(7038, 6);
    expect(hsa.grossWages).toEqual([100000]);
    // A 401(k) deferral of the same size still pays payroll tax on the full wage.
    const k401 = runForecastSim(baseInput({
      earners: [{ currentAge: 40, income: 100000, retireAge: 65, raisePct: 0, ssEnabled: false, ssClaimAge: 67, ssAnnual: 0, enabled: true }],
      A: det({ endAge: 40 }), pools0: { taxable: 0, pretax: 0, roth: 0, hsa: 0, college: 0 },
      contribByBucket: { taxable: 0, pretax: 8000, roth: 0, hsa: 0, college: 0 },
      tax: brackets(),
    })).tax!.medianPath[0];
    expect(k401.payroll).toBeCloseTo(7650, 6);
    // Two earners (60k + 40k) share an 8,000 HSA by wage: FICA wages 55,200 + 36,800.
    const two = runForecastSim(baseInput({
      earners: [
        { currentAge: 40, income: 60000, retireAge: 65, raisePct: 0, ssEnabled: false, ssClaimAge: 67, ssAnnual: 0, enabled: true },
        { currentAge: 40, income: 40000, retireAge: 65, raisePct: 0, ssEnabled: false, ssClaimAge: 67, ssAnnual: 0, enabled: true },
      ],
      A: det({ endAge: 40 }), pools0: { taxable: 0, pretax: 0, roth: 0, hsa: 0, college: 0 },
      contribByBucket: { taxable: 0, pretax: 0, roth: 0, hsa: 8000, college: 0 },
      tax: brackets({ filing: 'joint' }),
    })).tax!.medianPath[0];
    expect(two.payroll).toBeCloseTo(0.0765 * 92000, 6);
  });

  it('puts at most one 65+ person on a single return', () => {
    const r = runForecastSim(baseInput({
      currentAge0: 70, earners: [retiree(70), retiree(68)],
      A: det({ endAge: 70 }), tax: brackets({ filing: 'single' }),
    })).tax!.medianPath[0];
    expect(r.age65Count).toBe(1);
    expect(r.medicareCount).toBe(2); // both still pay Medicare premiums
    const j = runForecastSim(baseInput({
      currentAge0: 70, earners: [retiree(70), retiree(68)],
      A: det({ endAge: 70 }), tax: brackets({ filing: 'joint' }),
    })).tax!.medianPath[0];
    expect(j.age65Count).toBe(2);
  });

  it('records each year\'s price level, equal to plan inflation in Monte Carlo', () => {
    const r = runForecastSim(baseInput({
      currentAge0: 60, earners: [retiree(60)], infl: 0.03,
      A: det({ endAge: 64, annualSpending: 20000 }), tax: brackets(),
    }));
    r.tax!.medianPath.forEach((y, i) => expect(y.priceLevel).toBe(Math.pow(1.03, i)));
    expect(r.tax!.medianStartYear).toBeUndefined();
    // restateFlow is then exactly the plain plan-inflation deflator, and a no-op in future dollars.
    const y = r.tax!.medianPath[4];
    expect(restateFlow(y.fedTax, y.priceLevel, 4, 0.03, true)).toBe(deflateReal(y.fedTax, 4, 0.03));
    expect(restateFlow(y.fedTax, y.priceLevel, 4, 0.03, false)).toBe(y.fedTax);
  });
});

// Historical replay with the bracket model: each replayed tax year is the plan's year
// scaled by the path's price ratio, and its record is stored in plan dollars, so the
// page's deflator (restateFlow with the record's priceLevel) gives today's dollars.
describe('bracket tax model on a replayed historical path', () => {
  const hy = (year: number, inflation: number) => ({ year, stocks: 0, bonds: 0, bills: 0, inflation });
  // 10% inflation every replayed year against a 2% plan; one 30-year start (1960).
  const run = () => runForecastSim(baseInput({
    currentAge0: 40, infl: 0.02,
    earners: [{ currentAge: 40, income: 100000, retireAge: 65, raisePct: 0, ssEnabled: false, ssClaimAge: 67, ssAnnual: 0, enabled: true }],
    A: { ...baseInput().A, endAge: 69, investReturn: 0, volatility: 0, annualSpending: 50000 },
    pools0: { taxable: 100000, pretax: 0, roth: 0, hsa: 0, college: 0 },
    tax: { mode: 'brackets', filing: 'single', stateRate: 0, conversions: null },
    returnModel: 'historical', historicalData: Array.from({ length: 30 }, (_, k) => hy(1960 + k, 0.10)),
  }));

  it('keeps today\'s-dollar wages at the plan\'s buying power and matches the lifetime figure', () => {
    const r = run();
    expect(r.historical!.starts.length).toBe(1);
    expect(r.tax!.medianStartYear).toBe(1960);
    const p = r.tax!.medianPath;
    // Year 10: the replayed price level is 1.1^11 / 1.02 (see makeYears), so nominal
    // wages are 100,000 × that / 1.02^10. The record holds them in plan dollars
    // (100,000, raise 0) at the plan's price level 1.02^10, so today's dollars are
    // 100,000 / 1.02^10 = 82,034.83 (a plan-inflation deflator on the nominal figure
    // would have shown about 174,551).
    expect(p[10].priceLevel).toBe(Math.pow(1.02, 10));
    expect(p[10].wages).toBeCloseTo(100000, 4);
    expect(restateFlow(p[10].wages, p[10].priceLevel, 10, 0.02, true)).toBeCloseTo(100000 / Math.pow(1.02, 10), 4);
    // The per-year figures, deflated the same way, add up to the card's lifetime figure.
    const sumReal = p.reduce((t, y, i) => t + restateFlow(y.fedTax, y.priceLevel, i, 0.02, true), 0);
    expect(sumReal).toBeCloseTo(r.tax!.lifetimeFedTaxReal, 6);
    // Future dollars restate at the plan's inflation, like the bands: the plan-dollar records summed.
    const sumPlan = p.reduce((t, y) => t + y.fedTax, 0);
    expect(r.tax!.lifetimeFedTax).toBeCloseTo(sumPlan, 4);
    expect(restateFlow(p[10].wages, p[10].priceLevel, 10, 0.02, false)).toBeCloseTo(100000, 4);
  });
});

// --- Historical backtest and spending rules -----------------------------------
describe('historical backtest', () => {
  const hy = (year: number, stocks: number, bonds = 0, inflation = 0) => ({ year, stocks, bonds, bills: 0, inflation });

  it('lists only starting years with a complete run of data', () => {
    const data = [hy(2000, 0), hy(2001, 0), hy(2002, 0)];
    expect(completeHistoricalStarts(2, data)).toEqual([2000, 2001]);
    expect(completeHistoricalStarts(3, data)).toEqual([2000]);
    expect(completeHistoricalStarts(4, data)).toEqual([]);
    expect(completeHistoricalStarts(0, data)).toEqual([]);
    expect(completeHistoricalStarts(2, [hy(2000, 0), hy(2001, 0), hy(2003, 0), hy(2004, 0)])).toEqual([2000, 2003]); // gap at 2002
    // The real series: a 51-year plan fits starts 1928…1975.
    const real = completeHistoricalStarts(51);
    expect(real[0]).toBe(1928);
    expect(real[real.length - 1]).toBe(1975);
    expect(real.length).toBe(48);
  });

  it('replays each starting year\'s actual returns in order (one deterministic path each)', () => {
    const data = [hy(2000, 0.10), hy(2001, -0.5), hy(2002, 0.2)];
    const r = runForecastSim(baseInput({ A: { ...baseInput().A, endAge: 41 }, returnModel: 'historical', historicalData: data }));
    // Start 2000: 100k × 1.1 × 0.5 = 55,000. Start 2001: 100k × 0.5 × 1.2 = 60,000.
    expect(r.historical?.starts.map(s => s.startYear)).toEqual([2000, 2001]);
    expect(r.historical?.starts[0].endInvReal).toBeCloseTo(55000, 6);
    expect(r.historical?.starts[1].endInvReal).toBeCloseTo(60000, 6);
    expect(r.historical?.fallback).toBe(false);
    expect(r.successPct).toBe(100);
    expect(r.bands[1].p50).toBeCloseTo(55000, 6); // lower middle of two paths
    expect(r.paths?.length).toBe(2);
  });

  it('mixes stocks and bonds by the stock share when the glide path is off', () => {
    const data = [hy(2000, 0.10, 0.02)];
    const r = runForecastSim(baseInput({ A: { ...baseInput().A, endAge: 40 }, returnModel: 'historical', historicalData: data, historicalStockShare: 0.5 }));
    expect(r.historical?.starts[0].endInvReal).toBeCloseTo(106000, 6); // 0.5×10% + 0.5×2% = 6%
  });

  it('follows the glide path when it is on (90% stocks today)', () => {
    const data = [hy(2000, 0.10, 0.0)];
    const r = runForecastSim(baseInput({
      A: { ...baseInput().A, endAge: 40 }, returnModel: 'historical', historicalData: data, glidePath: true,
      earners: [{ ...baseInput().earners[0], retireAge: 65 }],
    }));
    expect(r.historical?.starts[0].endInvReal).toBeCloseTo(109000, 6);
  });

  it('prices spending with the replayed inflation and reports today\'s dollars', () => {
    const data = [hy(2000, 0, 0, 0.10), hy(2001, 0, 0, 0.10)];
    const r = runForecastSim(baseInput({ A: { ...baseInput().A, endAge: 41, annualSpending: 10000 }, returnModel: 'historical', historicalData: data }));
    const s = r.historical!.starts[0];
    // Each year's spending is paid after that year's 10% inflation (plan inflation 0):
    // 100k − 11,000 − 12,100 = 76,900 nominal; ÷ 1.1² = 63,553.72 today. In real terms
    // each year the cash loses 1/11 of its buying power and then exactly 10,000 is spent:
    // (100,000 / 1.1 − 10,000) / 1.1 − 10,000.
    // (Before the BT-1 fix this test expected 100k − 10,000 − 11,000 = 79,000 nominal,
    // which made each year's spending 1/1.1 of its real size.)
    expect(s.endInvReal).toBeCloseTo(76900 / 1.21, 6);
    expect(s.endInvReal).toBeCloseTo((100000 / 1.1 - 10000) / 1.1 - 10000, 6);
    expect(s.lowestSpendReal).toBeCloseTo(10000, 6);
    // Bands are restated at the plan's inflation (0 here), so they show the real value.
    expect(r.bands[1].invP50).toBeCloseTo(76900 / 1.21, 6);
  });

  it('records the age at which money ran out', () => {
    const data = [hy(2000, 0), hy(2001, 0), hy(2002, 0)];
    const r = runForecastSim(baseInput({ A: { ...baseInput().A, endAge: 42, annualSpending: 60000 }, returnModel: 'historical', historicalData: data }));
    expect(r.historical?.starts[0].ranOutAge).toBe(41); // 100k → 40k → short in the second year
    expect(r.successPct).toBe(0);
  });

  it('runs only the requested starting years (for chunked runs)', () => {
    const data = [hy(2000, 0), hy(2001, 0.1), hy(2002, 0)];
    const r = runForecastSim(baseInput({ A: { ...baseInput().A, endAge: 41 }, returnModel: 'historical', historicalData: data, historicalStarts: [2001, 1990] }));
    expect(r.historical?.starts.map(s => s.startYear)).toEqual([2001]);
    expect(r.historical?.completeStarts).toEqual([2000, 2001]);
    const none = runForecastSim(baseInput({ A: { ...baseInput().A, endAge: 41 }, returnModel: 'historical', historicalData: data, historicalStarts: [1990] }));
    expect(none.historical?.starts).toEqual([]);
    expect(none.bands.every(b => Number.isFinite(b.p50) && Number.isFinite(b.invBand))).toBe(true);
  });

  it('falls back to Monte Carlo (flagged) when no starting year fits the horizon', () => {
    const data = [hy(2000, 0.1)];
    const input = baseInput({ A: { ...baseInput().A, volatility: 0.1 } });
    const r = runForecastSim({ ...input, returnModel: 'historical', historicalData: data });
    expect(r.historical?.fallback).toBe(true);
    expect(r.historical?.starts).toEqual([]);
    expect(r.bands).toEqual(runForecastSim(input).bands);
  });

  it('runs on the real series with no NaN anywhere', () => {
    const r = runForecastSim(baseInput({
      A: { ...baseInput().A, endAge: 90, annualSpending: 40000, investReturn: 0.07, volatility: 0.15 },
      infl: 0.03, returnModel: 'historical', pools0: { taxable: 1_000_000, pretax: 0, roth: 0, hsa: 0, college: 0 },
    }));
    expect(r.historical?.starts.length).toBe(48);
    for (const s of r.historical!.starts) {
      expect(Number.isFinite(s.endInvReal)).toBe(true);
      expect(s.lowestSpendReal == null || Number.isFinite(s.lowestSpendReal)).toBe(true);
    }
    expect(r.bands.every(b => Number.isFinite(b.p10) && Number.isFinite(b.p50) && Number.isFinite(b.band))).toBe(true);
    // A 4% start held steady in real terms over 51 years: some, not all, historical starts fail.
    expect(r.successPct).toBeGreaterThan(0);
    expect(r.successPct).toBeLessThanOrEqual(100);
  });
});

describe('retirement spending rules in the simulation', () => {
  const hy = (year: number, stocks: number) => ({ year, stocks, bonds: 0, bills: 0, inflation: 0 });
  const guardrails = { kind: 'guardrails' as const, guardrails: { upper: 0.2, lower: 0.2, cut: 0.1, raise: 0.1 }, percent: { rate: 0.04, floor: null, ceiling: null } };
  const share = (rate: number) => ({ kind: 'percentOfPortfolio' as const, guardrails: guardrails.guardrails, percent: { rate, floor: null, ceiling: null } });

  it('guardrails trim spending after a crash and track the deepest cut', () => {
    const data = [hy(2000, 0), hy(2001, -0.5), hy(2002, 0)];
    const input = baseInput({ A: { ...baseInput().A, endAge: 42, annualSpending: 5000 }, returnModel: 'historical', historicalData: data });
    const r = runForecastSim({ ...input, withdrawal: guardrails });
    // Year 1: start rate 5%, spend 5,000 → 95,000. Year 2: halves to 47,500, rate 10.5% > 6% → spend 4,500 → 43,000.
    // Year 3: 4,500 / 43,000 = 10.5% → spend 4,050 → 38,950.
    const s = r.historical!.starts[0];
    expect(s.endInvReal).toBeCloseTo(38950, 6);
    expect(s.deepestCut).toBeCloseTo(0.19, 12);
    expect(s.lowestSpendReal).toBeCloseTo(4050, 6);
    // The steady rule spends the plan: 100k → 95k → 42.5k → 37.5k.
    const fixed = runForecastSim(input).historical!.starts[0];
    expect(fixed.endInvReal).toBeCloseTo(37500, 6);
    expect(fixed.deepestCut).toBe(0);
  });

  it('never cuts the cost of kids who are dependent today', () => {
    // 6,000 spending of which 2,000 is one dependent kid → only 4,000 flexes. The rule
    // reads savings after the year's growth: 1% of 105,000 = 1,050.
    const r = runForecastSim(baseInput({
      A: { ...baseInput().A, endAge: 40, annualSpending: 6000 }, costPerKid: 2000, kidAges: [10], kidIndependentAge: 18,
      withdrawal: share(0.01),
    }));
    // Volatility 0 and a 5% return: 105,000 − (2,000 + 1,050) = 101,950.
    expect(r.bands[0].invP50).toBeCloseTo(101950, 6);
    expect(r.paths?.[0].deepestCut).toBeCloseTo(1 - 1050 / 4000, 12);
  });

  it('leaves spending alone while anyone is still working', () => {
    const r = runForecastSim(baseInput({
      A: { ...baseInput().A, endAge: 40, annualSpending: 5000 }, withdrawal: share(0.01),
      earners: [{ ...baseInput().earners[0], retireAge: 65 }],
    }));
    expect(r.bands[0].invP50).toBeCloseTo(100000, 6); // 105,000 − 5,000 as planned
    expect(r.paths?.[0].lowestSpendReal).toBeNull();
  });

  it('works with the bracket tax model and keeps results finite', () => {
    const base = baseInput({
      A: { ...baseInput().A, endAge: 70, annualSpending: 60000, volatility: 0.15 }, currentAge0: 60,
      earners: [{ ...baseInput().earners[0], currentAge: 60, retireAge: 60 }],
      pools0: { taxable: 200000, pretax: 600000, roth: 0, hsa: 0, college: 0 },
      tax: { mode: 'brackets', filing: 'single', stateRate: 0.03, conversions: null },
    });
    const fixed = runForecastSim(base);
    const flex = runForecastSim({ ...base, withdrawal: guardrails });
    expect(flex.bands.every(b => Number.isFinite(b.p50))).toBe(true);
    expect(flex.paths?.length).toBe(50);
    expect(flex.successPct).toBeGreaterThanOrEqual(fixed.successPct);
  });

  it('adds no extra output with the default settings', () => {
    const r = runForecastSim(baseInput());
    expect(r.paths).toBeUndefined();
    expect(r.historical).toBeUndefined();
    expect(runForecastSim(baseInput({ withdrawal: { ...guardrails, kind: 'fixed' } }))).toEqual(r);
  });
});

// --- Historical replay: inflation neutrality (BT-1 / XR-2, BT-2 / XR-3) ---------
// Spending, income and Social Security keep their planned buying power, so two
// replays with the SAME real returns must give the same real outcome whatever
// inflation they had. Each replayed year's flows are priced at F[i+1] / (1 + infl),
// which charges a year's real spending exactly as Monte Carlo does.
describe('historical replay is neutral to the replayed inflation', () => {
  const flat = (over: Partial<SimInput> = {}) => baseInput({
    A: { ...baseInput().A, endAge: 49, annualSpending: 10000 },
    pools0: { taxable: 100000, pretax: 0, roth: 0, hsa: 0, college: 0 },
    returnModel: 'historical', ...over,
  });
  // `n` years of a constant real return and constant inflation.
  const series = (n: number, real: number, inflation: number): HistoricalYear[] => Array.from({ length: n }, (_, k) => {
    const nominal = (1 + real) * (1 + inflation) - 1;
    return { year: 2000 + k, stocks: nominal, bonds: nominal, bills: nominal, inflation };
  });

  it('a zero-real-return, constant-inflation history: real savings fall by exactly real spending each year', () => {
    // Plan inflation 0, so a year's real spending is 10,000 in end-of-year dollars.
    // 6% inflation, 6% nominal return: the real balance is 100k, 90k, 80k, … 0 after 10 years.
    const r = runForecastSim(flat({ historicalData: series(10, 0, 0.06) }));
    expect(r.historical!.starts.length).toBe(1);
    r.bands.forEach((b, i) => expect(b.invP50).toBeCloseTo(100000 - 10000 * (i + 1), 4));
    const s = r.historical!.starts[0];
    expect(s.endInvReal).toBeCloseTo(0, 4);
    expect(s.lowestSpendReal).toBeCloseTo(10000, 6);
    expect(s.ranOutAge).toBeNull();
  });

  it('one hand-worked year: 100k, +10% stocks, 10% inflation, 10k spending → 90k real', () => {
    // 110,000 − 11,000 (10k at end-of-year prices) = 99,000 nominal = 90,000 real.
    // The old start-of-year pricing gave (110,000 − 10,000) / 1.1 = 90,909.09.
    const r = runForecastSim(flat({ A: { ...flat().A, endAge: 40 }, historicalData: [{ year: 2000, stocks: 0.10, bonds: 0, bills: 0, inflation: 0.10 }] }));
    expect(r.historical!.starts[0].endInvReal).toBeCloseTo(90000, 6);
  });

  it('gives the same real outcome at 2% and 10% replayed inflation (plan at 3%)', () => {
    const lo = runForecastSim(flat({ infl: 0.03, historicalData: series(10, 0.01, 0.02) }));
    const hi = runForecastSim(flat({ infl: 0.03, historicalData: series(10, 0.01, 0.10) }));
    // Hand-worked: B ← B × 1.01 − 10,000 / 1.03 (the plan's own timing), ten times.
    let B = 100000;
    for (let k = 0; k < 10; k++) B = B * 1.01 - 10000 / 1.03;
    expect(lo.historical!.starts[0].endInvReal).toBeCloseTo(B, 4);
    expect(hi.historical!.starts[0].endInvReal).toBeCloseTo(B, 4);
    // Bands (restated at the plan's inflation) match too.
    hi.bands.forEach((b, i) => expect(b.invP50).toBeCloseTo(lo.bands[i].invP50, 4));
  });

  it('matches a zero-volatility Monte Carlo exactly when history had the plan\'s inflation', () => {
    const mc = baseInput({ A: { ...flat().A, investReturn: 0.05, volatility: 0 }, infl: 0.03, pools0: flat().pools0 });
    const hist = runForecastSim({ ...mc, returnModel: 'historical', historicalData: series(10, 1.05 / 1.03 - 1, 0.03) });
    const ref = runForecastSim(mc);
    hist.bands.forEach((b, i) => expect(b.invP50).toBeCloseTo(ref.bands[i].invP50, 4));
  });

  it('the real 1928+ series and the same real returns at a flat 2.5% CPI agree (4.5% on $1M, 60/40)', () => {
    const PLAN = 0.025;
    const neutral = HISTORICAL_RETURNS.map(h => ({
      ...h,
      stocks: (1 + h.stocks) / (1 + h.inflation) * (1 + PLAN) - 1,
      bonds: (1 + h.bonds) / (1 + h.inflation) * (1 + PLAN) - 1,
      inflation: PLAN,
    }));
    const input = baseInput({
      A: { ...baseInput().A, endAge: 94, annualSpending: 45000 }, currentAge0: 65, infl: PLAN,
      earners: [{ currentAge: 65, income: 0, retireAge: 65, raisePct: 0, ssEnabled: false, ssClaimAge: 65, ssAnnual: 0, enabled: true }],
      pools0: { taxable: 1_000_000, pretax: 0, roth: 0, hsa: 0, college: 0 },
      returnModel: 'historical', historicalStockShare: 0.6,
    });
    const actual = runForecastSim(input);
    const flatCpi = runForecastSim({ ...input, historicalData: neutral });
    expect(actual.successPct).toBe(flatCpi.successPct);
    const f = new Map(flatCpi.historical!.starts.map(s => [s.startYear, s]));
    for (const a of actual.historical!.starts) {
      const b = f.get(a.startYear)!;
      expect(a.ranOutAge).toBe(b.ranOutAge);
      expect(a.endInvReal).toBeCloseTo(b.endInvReal, 2);
    }
  });

  it('bracket model: real federal tax on the same real wage does not creep with inflation', () => {
    // 100k wage with raises equal to the plan's 2.5%, so pay is flat in real terms.
    const worker = (inflation: number) => runForecastSim(baseInput({
      A: { ...baseInput().A, endAge: 55, investReturn: 0.06, volatility: 0 }, currentAge0: 40, infl: 0.025,
      earners: [{ currentAge: 40, income: 100000, retireAge: 65, raisePct: 0.025, ssEnabled: false, ssClaimAge: 67, ssAnnual: 0, enabled: true }],
      tax: { mode: 'brackets', filing: 'single', stateRate: 0, conversions: null },
      returnModel: 'historical', historicalData: series(16, 0, inflation),
    }));
    const lo = worker(0.025), hi = worker(0.08);
    const real = (r: ReturnType<typeof worker>, field: 'wages' | 'fedTax') => {
      const y = r.tax!.medianPath[15];
      return restateFlow(y[field], y.priceLevel, 15, 0.025, true);
    };
    // Real wage at 55: 100,000 × 1.025^15 / 1.025^15 = 100,000 in both.
    expect(real(lo, 'wages')).toBeCloseTo(100000, 4);
    expect(real(hi, 'wages')).toBeCloseTo(100000, 4);
    // Same real tax: the 2026 single tables on 100,000 of wages, in both (it was 44% higher at 8%).
    expect(real(hi, 'fedTax')).toBeCloseTo(real(lo, 'fedTax'), 4);
    expect(hi.tax!.lifetimeFedTaxReal).toBeCloseTo(lo.tax!.lifetimeFedTaxReal, 4);
  });

  it('bracket model: a retiree with Social Security and RMDs pays the same real tax and ends equally well off', () => {
    const retiree = (inflation: number) => runForecastSim(baseInput({
      A: { ...baseInput().A, endAge: 89, annualSpending: 70000 }, currentAge0: 65, infl: 0.03,
      earners: [{ currentAge: 65, income: 0, retireAge: 65, raisePct: 0, ssEnabled: true, ssClaimAge: 67, ssAnnual: 30000, enabled: true }],
      pools0: { taxable: 0, pretax: 1_600_000, roth: 0, hsa: 0, college: 0 },
      tax: { mode: 'brackets', filing: 'single', stateRate: 0.04, conversions: { startAge: 65, endAge: 72, bracketRate: 0.22, irmaaCap: true } },
      returnModel: 'historical', historicalData: series(25, 0.04, inflation),
    }));
    const lo = retiree(0.03), hi = retiree(0.09);
    // (Before the fix: 327,033 against 540,113 of real federal tax.)
    expect(hi.tax!.lifetimeFedTaxReal / lo.tax!.lifetimeFedTaxReal).toBeCloseTo(1, 6);
    expect(hi.historical!.starts[0].endInvReal / lo.historical!.starts[0].endInvReal).toBeCloseTo(1, 6);
    // The records are in plan dollars, so the two runs' year-by-year records match.
    hi.tax!.medianPath.forEach((y, i) => {
      const x = lo.tax!.medianPath[i];
      expect(y.priceLevel).toBe(x.priceLevel);
      expect(y.fedTax).toBeCloseTo(x.fedTax, 2);
      expect(y.irmaaCost).toBeCloseTo(x.irmaaCost, 2);
      expect(y.conversion).toBeCloseTo(x.conversion, 2);
    });
  });

  it('a replayed year rebuilt from the published tables (Tax picture) matches the tax the run charged', () => {
    const r = runForecastSim(baseInput({
      A: { ...baseInput().A, endAge: 80, annualSpending: 60000 }, currentAge0: 66, infl: 0.025,
      earners: [{ currentAge: 66, income: 0, retireAge: 66, raisePct: 0, ssEnabled: true, ssClaimAge: 67, ssAnnual: 28000, enabled: true }],
      pools0: { taxable: 300000, pretax: 900000, roth: 0, hsa: 0, college: 0 },
      tax: { mode: 'brackets', filing: 'single', stateRate: 0, conversions: null },
      returnModel: 'historical', historicalData: HISTORICAL_RETURNS.filter(h => h.year >= 1966 && h.year < 1981),
    }));
    expect(r.historical!.starts.map(s => s.startYear)).toEqual([1966]);
    for (const y of r.tax!.medianPath) expect(taxYearDetail(y, 0.025).result.total).toBeCloseTo(y.fedTax, 6);
  });
});

describe('spending-rule cut bookkeeping', () => {
  it('counts one default 10% guardrail trim as exactly a 10% cut', () => {
    // 50k on 1M (5% start, upper rail 6%). Year 1: 0% → 950k. Year 2: −30% → 665k;
    // 50k / 665k = 7.5% > 6% → spend 45,000, one 10% trim (1 − 0.9 in floating point
    // is 0.09999999999999998, which read as "under 10%").
    const r = runForecastSim(baseInput({
      A: { ...baseInput().A, endAge: 66, annualSpending: 50000 }, currentAge0: 65,
      earners: [{ currentAge: 65, income: 0, retireAge: 65, raisePct: 0, ssEnabled: false, ssClaimAge: 67, ssAnnual: 0, enabled: true }],
      pools0: { taxable: 1_000_000, pretax: 0, roth: 0, hsa: 0, college: 0 },
      returnModel: 'historical',
      historicalData: [{ year: 2000, stocks: 0, bonds: 0, bills: 0, inflation: 0 }, { year: 2001, stocks: -0.3, bonds: 0, bills: 0, inflation: 0 }],
      withdrawal: { kind: 'guardrails', guardrails: { upper: 0.2, lower: 0.2, cut: 0.1, raise: 0.1 }, percent: { rate: 0.04, floor: null, ceiling: null } },
    }));
    const s = r.historical!.starts[0];
    expect(s.deepestCut).toBe(0.1);
    expect(s.deepestCut >= 0.1).toBe(true);
    expect(s.endInvReal).toBeCloseTo(665000 - 45000, 6);
  });
});
