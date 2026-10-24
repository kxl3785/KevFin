import { describe, it, expect } from 'vitest';
import {
  runForecastSim, backcastHistory, rmdFactor, runSeed, mulberry32, bandOnReaching, balanceYearsOut, flowYearsOut, deflateReal, baselineMedianAt,
  type SimInput, type SimRealEstate,
} from './forecastSim.ts';
import { monthlyMortgagePayment, amortizeYear } from './mortgage.ts';

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
