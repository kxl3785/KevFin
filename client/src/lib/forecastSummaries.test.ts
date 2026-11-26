import { describe, it, expect } from 'vitest';
import {
  joinAnd, earnerSummary, ssSummary, spendingSummary, savingsSummary, homeSummary, familySummary,
  assumptionsSummary, leverPhrases, whatIfSentence,
  peopleShort, spendingShort, savingsShort, homeFamilyShort, ratesShort,
} from './forecastSummaries.ts';
import { fmtMoney } from './format.ts';
import { fmtMoneyShort } from './forecastDisplay.ts';

const money = (n: number) => fmtMoney(n);
const masked = () => '••••••';

describe('joinAnd', () => {
  it('joins with commas and a final "and"', () => {
    expect(joinAnd([])).toBe('');
    expect(joinAnd(['a'])).toBe('a');
    expect(joinAnd(['a', 'b'])).toBe('a and b');
    expect(joinAnd(['a', 'b', 'c'])).toBe('a, b and c');
  });
});

describe('folded section summaries', () => {
  it('earner: age · pay · retirement', () => {
    expect(earnerSummary({ currentAge: 38, income: 120000, retireAge: 65 }, money)).toBe('38 · $120,000 a year · retires at 65');
  });
  it('masks amounts with the page formatter', () => {
    expect(earnerSummary({ currentAge: 38, income: 120000, retireAge: 65 }, masked)).toBe('38 · •••••• a year · retires at 65');
    expect(spendingSummary({ living: 19392, housing: 86284 }, masked)).toBe('•••••• living + •••••• housing');
  });
  it('social security: shared claim age, separate ages, one or none', () => {
    expect(ssSummary([{ enabled: true, annual: 36000, claimAge: 67 }, { enabled: true, annual: 30000, claimAge: 67 }], money)).toBe('$36,000 + $30,000 from 67');
    expect(ssSummary([{ enabled: true, annual: 36000, claimAge: 67 }, { enabled: true, annual: 30000, claimAge: 70 }], money)).toBe('$36,000 from 67 + $30,000 from 70');
    expect(ssSummary([{ enabled: true, annual: 36000, claimAge: 67 }, { enabled: false, annual: 30000, claimAge: 70 }], money)).toBe('$36,000 a year from 67');
    expect(ssSummary([{ enabled: false, annual: 36000, claimAge: 67 }], money)).toBe('Not included');
  });
  it('spending: living + housing when there is housing, and the rule when not steady', () => {
    expect(spendingSummary({ living: 19392, housing: 86284 }, money)).toBe('$19,392 living + $86,284 housing');
    expect(spendingSummary({ living: 60000, housing: 0 }, money)).toBe('$60,000 a year');
    expect(spendingSummary({ living: 60000, housing: 0 }, money, 'guardrails')).toBe('$60,000 a year · guardrails');
  });
  it('savings: total, buckets and contributions', () => {
    expect(savingsSummary({ total: 358649, buckets: ['taxable', 'Roth'], contribPerYear: 0, connected: true }, money)).toBe('$358,649 in taxable and Roth · $0 a year going in');
    expect(savingsSummary({ total: 500000, buckets: ['taxable', 'pre-tax', 'Roth'], contribPerYear: 23500, connected: true }, money)).toBe('$500,000 in taxable, pre-tax and Roth · +$23,500 a year going in');
    expect(savingsSummary({ total: 0, buckets: [], contribPerYear: 0, connected: false }, money)).toBe('No accounts connected');
  });
  it('home, family and assumptions', () => {
    expect(homeSummary({ count: 2, equity: 525569, sellable: false }, money)).toBe('2 properties · $525,569 equity');
    expect(homeSummary({ count: 1, equity: 100000, sellable: true }, money)).toBe('1 property · $100,000 equity · can fund retirement');
    expect(familySummary({ kids: 0, planned: 0, college: true })).toBe('No kids added');
    expect(familySummary({ kids: 2, planned: 1, college: true })).toBe('2 kids · 1 planned · college on');
    expect(familySummary({ kids: 0, planned: 1, college: false })).toBe('1 planned · college off');
    expect(assumptionsSummary({ investReturn: 0.07, inflation: 0.03, brackets: true, effTaxRate: 0.22, retireTaxRate: 0.15 })).toBe('7% return · 3% inflation · IRS brackets');
    expect(assumptionsSummary({ investReturn: 0.065, inflation: 0.025, brackets: false, effTaxRate: 0.22, retireTaxRate: 0.15 })).toBe('6.5% return · 2.5% inflation · tax 22% → 15%');
  });
});

describe('plan tabs footer', () => {
  it('people: total pay and retirement ages', () => {
    expect(peopleShort([{ income: 71772, retireAge: 65 }], money)).toBe('$71,772 a year, retire at 65');
    expect(peopleShort([{ income: 100000, retireAge: 65 }, { income: 80000, retireAge: 65 }], money)).toBe('$180,000 a year, both retire at 65');
    expect(peopleShort([{ income: 100000, retireAge: 65 }, { income: 80000, retireAge: 63 }], money)).toBe('$180,000 a year, retire at 65 and 63');
    expect(peopleShort([], money)).toBe('');
  });
  it('spending, savings, home and rates in a few words', () => {
    expect(spendingShort(105676, money)).toBe('$105,676 a year');
    expect(savingsShort({ total: 640000, contribPerYear: 36000, connected: true }, money)).toBe('$640,000 + $36,000 a year');
    expect(savingsShort({ total: 640000, contribPerYear: 0, connected: true }, money)).toBe('$640,000');
    expect(savingsShort({ total: 0, contribPerYear: 0, connected: false }, money)).toBe('no accounts');
    expect(homeFamilyShort({ homes: 1, kids: 2 })).toBe('1 home, 2 kids');
    expect(homeFamilyShort({ homes: 0, kids: 0 })).toBe('no home, no kids');
    expect(homeFamilyShort({ homes: 2, kids: 1 })).toBe('2 homes, 1 kid');
    expect(ratesShort({ investReturn: 0.07, inflation: 0.03 })).toBe('7% return, 3% inflation');
  });
  it('masks amounts in privacy mode', () => {
    expect(peopleShort([{ income: 71772, retireAge: 65 }], masked)).toBe('•••••• a year, retire at 65');
    expect(savingsShort({ total: 640000, contribPerYear: 36000, connected: true }, masked)).toBe('•••••• + •••••• a year');
  });
});

describe('what-if', () => {
  it('names each moved slider', () => {
    expect(leverPhrases({ retire: { plan: 65, now: 62 }, spend: { pct: -10, amount: 17453 }, extraSave: 5000, ret: { plan: 0.07, now: 0.06 } }, money))
      .toEqual(['retiring at 62 instead of 65', 'spending 10% less ($17,453 a year)', 'saving $5,000 more a year', 'a 6% return instead of 7%']);
    expect(leverPhrases({ retire: { plan: 65, now: 65 }, spend: { pct: 0, amount: 19392 }, extraSave: 0, ret: null }, money)).toEqual([]);
  });
  it('states the combined effect on chance and retirement value', () => {
    expect(whatIfSentence({
      changes: ['retiring at 62 instead of 65'], chance: { plan: 100, now: 100 },
      retire: { planAge: 65, planValue: 6.37e6, nowAge: 62, nowValue: 5.1e6 }, money: fmtMoneyShort,
    })).toBe('Retiring at 62 instead of 65: chance stays 100%, and you’d have $5.1M at 62 instead of $6.37M at 65.');
    expect(whatIfSentence({
      changes: ['spending 20% more ($23,270 a year)', 'a 6% return instead of 7%'], chance: { plan: 92, now: 81 },
      retire: { planAge: 65, planValue: 6.37e6, nowAge: 65, nowValue: 5.9e6 }, money: fmtMoneyShort,
    })).toBe('Spending 20% more ($23,270 a year) and a 6% return instead of 7%: chance falls from 92% to 81%, and you’d have $5.9M at retirement instead of $6.37M.');
  });
  it('says when the retirement value barely moves', () => {
    expect(whatIfSentence({
      changes: ['saving $1,000 more a year'], chance: { plan: 80, now: 82 },
      retire: { planAge: 65, planValue: 1e6, nowAge: 65, nowValue: 1.002e6 }, money: fmtMoneyShort,
    })).toBe('Saving $1,000 more a year: chance rises from 80% to 82%, and you’d have about the same $1M at retirement.');
  });
  it('is null when nothing is moved', () => {
    expect(whatIfSentence({ changes: [], chance: { plan: 1, now: 1 }, retire: { planAge: 1, planValue: 1, nowAge: 1, nowValue: 1 }, money })).toBeNull();
  });
});
