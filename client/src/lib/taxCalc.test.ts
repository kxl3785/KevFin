import { describe, it, expect } from 'vitest';
import {
  federalTax, bracketTax, bracketIndex, bracketTop, roomToBracketTop, bracketFill, taxableSocialSecurity,
  marginalRate, ordinaryRoomToRate, ordinaryRoomToMagi, irmaaTier, payrollTax, ZERO_INCOME, type TaxIncome,
} from './taxCalc.ts';
import { taxParamsFor, irmaaTiersFor, tableYearFor } from './taxTables.ts';

// Every expected value below is worked by hand from the published tables
// (Rev. Proc. 2025-32 for 2026, Rev. Proc. 2026-35 for 2027, Pub. 915 Worksheet 1,
// Schedule 1-A Part V, the CMS IRMAA fact sheets). The arithmetic is in comments.

const inc = (over: Partial<TaxIncome>): TaxIncome => ({ ...ZERO_INCOME, ...over });
const S26 = taxParamsFor(2026, 'single', 0.03);
const J26 = taxParamsFor(2026, 'joint', 0.03);
const single = { status: 'single' as const, age65Count: 0 };
const joint = { status: 'joint' as const, age65Count: 0 };

describe('taxParamsFor', () => {
  it('uses the published tables as-is for 2026 and 2027', () => {
    expect(S26.standardDeduction).toBe(16100);
    expect(J26.brackets[2]).toEqual({ rate: 0.22, from: 100800 });
    const s27 = taxParamsFor(2027, 'single', 0.03);
    expect(s27.growth).toBe(1);
    expect(s27.standardDeduction).toBe(16600);
    expect(s27.brackets[6].from).toBe(661375);
    expect(s27.ltcgZeroMax).toBe(51050);
    expect(tableYearFor(2040)).toBe(2027);
  });

  it('grows indexed thresholds with inflation past the last table, but not the fixed ones', () => {
    // 2029 = 2027 table × 1.03².
    const p = taxParamsFor(2029, 'joint', 0.03);
    expect(p.standardDeduction).toBeCloseTo(33200 * 1.0609, 6);
    expect(p.brackets[1].from).toBeCloseTo(25600 * 1.0609, 6);
    expect(p.ltcgFifteenMax).toBeCloseTo(633600 * 1.0609, 6);
    // Not indexed by law: NIIT, Social Security base amounts.
    expect(p.niitThreshold).toBe(250000);
    expect(p.ssBase).toBe(32000);
    expect(p.ssSecond).toBe(44000);
    // Senior deduction ends after 2028.
    expect(p.senior).toBeNull();
    expect(taxParamsFor(2028, 'joint', 0.03).senior).not.toBeNull();
  });

  it('never produces NaN from a junk inflation rate', () => {
    const p = taxParamsFor(2035, 'single', NaN);
    expect(p.standardDeduction).toBe(16600);
    expect(Number.isFinite(taxParamsFor(2035, 'single', -5).brackets[3].from)).toBe(true);
  });

  it('uses the first table for years before it', () => {
    expect(taxParamsFor(2020, 'single', 0.03).standardDeduction).toBe(16100);
  });
});

describe('bracket helpers', () => {
  it('matches the published "plus X% of the excess" lines', () => {
    // Rev. Proc. 2025-32 Table 3: over $256,225 → $58,448 plus 35%.
    expect(bracketTax(256225, S26.brackets)).toBeCloseTo(58448, 6);
    // Over $640,600 → $192,979.25 plus 37%.
    expect(bracketTax(640600, S26.brackets)).toBeCloseTo(192979.25, 6);
    // Joint over $768,700 → $206,583.50.
    expect(bracketTax(768700, J26.brackets)).toBeCloseTo(206583.5, 6);
    expect(bracketTax(0, S26.brackets)).toBe(0);
    expect(bracketTax(-500, S26.brackets)).toBe(0);
  });

  it('keeps income exactly at a boundary in the lower bracket with no room left', () => {
    expect(bracketIndex(50400, S26.brackets)).toBe(1);   // 12%
    expect(bracketIndex(50400.01, S26.brackets)).toBe(2); // 22%
    expect(bracketIndex(0, S26.brackets)).toBe(0);
    expect(roomToBracketTop(50400, S26.brackets, 0.12)).toBe(0);
    expect(roomToBracketTop(43900, S26.brackets, 0.12)).toBe(6500);
    expect(roomToBracketTop(43900, S26.brackets, 0.22)).toBe(61800);
    expect(roomToBracketTop(43900, S26.brackets, 0.37)).toBeNull();
    expect(bracketTop(S26.brackets, 0.5)).toBeNull();
  });

  it('splits ordinary taxable income into filled and open room per bracket', () => {
    const f = bracketFill(43900, S26.brackets);
    expect(f[0]).toMatchObject({ rate: 0.10, filled: 12400, open: 0, tax: 1240 });
    expect(f[1]).toMatchObject({ rate: 0.12, filled: 31500, open: 6500 });
    expect(f[2]).toMatchObject({ filled: 0, open: 55300 });
    expect(f[6]).toMatchObject({ filled: 0, open: null, to: null });
    expect(f.reduce((t, s) => t + s.tax, 0)).toBeCloseTo(5020, 6);
  });
});

describe('federalTax', () => {
  it('is all zeros on zero income', () => {
    const r = federalTax(ZERO_INCOME, single, S26);
    expect(r.total).toBe(0);
    expect(r.taxableIncome).toBe(0);
    expect(r.effectiveRate).toBe(0);
    expect(r.roomInBracket).toBe(12400);
    expect(marginalRate(ZERO_INCOME, single, S26)).toBe(0); // still inside the deduction
  });

  it('taxes single wages through the brackets', () => {
    // 60,000 − 16,100 = 43,900 taxable → 1,240 + 12% × 31,500 = 5,020.
    const r = federalTax(inc({ wages: 60000 }), single, S26);
    expect(r.taxableIncome).toBe(43900);
    expect(r.ordinaryTax).toBeCloseTo(5020, 6);
    expect(r.total).toBeCloseTo(5020, 6);
    expect(r.bracketRate).toBe(0.12);
    expect(r.roomInBracket).toBe(6500);
    expect(r.effectiveRate).toBeCloseTo(5020 / 60000, 9);
  });

  it('handles income exactly at the top of a bracket', () => {
    // 66,500 − 16,100 = 50,400 = top of 12% → 5,800 (the 22% line's base).
    const r = federalTax(inc({ wages: 66500 }), single, S26);
    expect(r.total).toBeCloseTo(5800, 6);
    expect(r.bracketRate).toBe(0.12);
    expect(r.roomInBracket).toBe(0);
    // The next dollar is taxed at 22%.
    expect(marginalRate(inc({ wages: 66500 }), single, S26)).toBeCloseTo(0.22, 9);
  });

  it('taxes joint wages through the joint brackets', () => {
    // 200,000 − 32,200 = 167,800 → 11,600 + 22% × 67,000 = 26,340.
    expect(federalTax(inc({ wages: 200000 }), joint, J26).total).toBeCloseTo(26340, 6);
  });

  it('stacks gains on top of ordinary income, straddling the 0%/15% line', () => {
    // Wages 40,000 + gains 30,000: taxable 53,900, ordinary 23,900 → 1,240 + 12% × 11,500 = 2,620.
    // Gains fill 23,900–53,900: 0% to 49,450 (25,550), 15% on 4,450 = 667.50.
    const r = federalTax(inc({ wages: 40000, qualified: 30000 }), single, S26);
    expect(r.ordinaryTaxable).toBe(23900);
    expect(r.ordinaryTax).toBeCloseTo(2620, 6);
    expect(r.gainsAt0).toBe(25550);
    expect(r.gainsAt15).toBe(4450);
    expect(r.gainsAt20).toBe(0);
    expect(r.gainsTax).toBeCloseTo(667.5, 6);
    expect(r.total).toBeCloseTo(3287.5, 6);
    expect(r.niit).toBe(0);
  });

  it('lets the deduction absorb ordinary income first, leaving gains in the 0% zone', () => {
    // Gains only, 60,000: taxable 43,900, all under 49,450 → no tax.
    const r = federalTax(inc({ qualified: 60000 }), single, S26);
    expect(r.ordinaryTaxable).toBe(0);
    expect(r.qualifiedTaxable).toBe(43900);
    expect(r.total).toBe(0);
  });

  it('taxes gains at exactly the 0% top at zero', () => {
    // Gains 65,550 − 16,100 = 49,450 = the 0% maximum exactly.
    const r = federalTax(inc({ qualified: 65550 }), single, S26);
    expect(r.gainsAt0).toBe(49450);
    expect(r.gainsTax).toBe(0);
  });

  it('taxes gains above the 15% top at 20%', () => {
    // Wages 600,000 + gains 100,000: taxable 683,900, ordinary 583,900 (past 545,500) → all gains at 20%.
    // Ordinary: 58,448 + 35% × (583,900 − 256,225) = 173,134.25.
    const r = federalTax(inc({ wages: 600000, qualified: 100000 }), single, S26);
    expect(r.gainsAt20).toBe(100000);
    expect(r.gainsTax).toBeCloseTo(20000, 6);
    expect(r.ordinaryTax).toBeCloseTo(173134.25, 6);
    // NIIT: 3.8% × min(100,000 NII, 700,000 − 200,000) = 3,800.
    expect(r.niit).toBeCloseTo(3800, 6);
  });

  it('charges NIIT on the smaller of investment income or MAGI over the threshold', () => {
    // AGI 300,000, NII 50,000 → 3.8% × 50,000 = 1,900.
    expect(federalTax(inc({ wages: 250000, qualified: 50000 }), single, S26).niit).toBeCloseTo(1900, 6);
    // AGI 210,000 → 3.8% × 10,000 = 380.
    expect(federalTax(inc({ wages: 160000, interest: 50000 }), single, S26).niit).toBeCloseTo(380, 6);
    // Exactly at the threshold → none.
    expect(federalTax(inc({ wages: 150000, qualified: 50000 }), single, S26).niit).toBe(0);
  });

  it('adds the 65+ standard deduction and the 2025–2028 senior deduction', () => {
    // Single 65+, IRA 80,000: senior 6,000 − 6% × 5,000 = 5,700; deduction 16,100 + 2,050 + 5,700 = 23,850.
    // Taxable 56,150 → 5,800 + 22% × 5,750 = 7,065.
    const r = federalTax(inc({ pretaxWithdrawals: 80000 }), { status: 'single', age65Count: 1 }, S26);
    expect(r.seniorDeduction).toBeCloseTo(5700, 6);
    expect(r.deduction).toBeCloseTo(23850, 6);
    expect(r.total).toBeCloseTo(7065, 6);
  });

  it('phases the senior deduction fully out and clamps the 65+ count to the return', () => {
    // 6,000 / 6% = 100,000 over the start → gone at MAGI 175,000 single.
    const r = federalTax(inc({ pretaxWithdrawals: 175000 }), { status: 'single', age65Count: 2 }, S26);
    expect(r.seniorDeduction).toBe(0);
    expect(r.deduction).toBe(16100 + 2050); // one person on a single return
    // Joint, both 65+, MAGI 150,000 exactly → full 12,000 and 2 × 1,650.
    const j = federalTax(inc({ pretaxWithdrawals: 150000 }), { status: 'joint', age65Count: 2 }, J26);
    expect(j.seniorDeduction).toBe(12000);
    expect(j.deduction).toBe(32200 + 3300 + 12000);
  });

  it('has no senior deduction after 2028', () => {
    // 2029 at 0% inflation = the 2027 table: 16,600 + 2,100.
    const p = taxParamsFor(2029, 'single', 0);
    const r = federalTax(inc({ pretaxWithdrawals: 50000 }), { status: 'single', age65Count: 1 }, p);
    expect(r.deduction).toBe(18700);
  });
});

describe('Social Security taxation', () => {
  it('taxes nothing at or under the base amount', () => {
    // 15,000 + half of 20,000 = 25,000 = the single base exactly.
    expect(taxableSocialSecurity(20000, 15000, S26)).toEqual({ taxable: 0, provisional: 25000 });
    expect(taxableSocialSecurity(0, 500000, S26).taxable).toBe(0);
  });

  it('phases in through the 50% and 85% tiers (Pub. 915 Worksheet 1)', () => {
    // Single, SS 30,000, other 20,000: provisional 35,000; line10 10,000; line12 1,000;
    // line15 min(15,000, 4,500) = 4,500; + 85% × 1,000 = 5,350 (< 85% × 30,000).
    expect(taxableSocialSecurity(30000, 20000, S26).taxable).toBeCloseTo(5350, 6);
    // Joint, SS 40,000, other 30,000: provisional 50,000; line10 18,000; line12 6,000;
    // line15 6,000; + 5,100 = 11,100.
    expect(taxableSocialSecurity(40000, 30000, J26).taxable).toBeCloseTo(11100, 6);
    // Single, only in the 50% tier: SS 20,000, other 20,000 → provisional 30,000; 50% × 5,000 = 2,500.
    expect(taxableSocialSecurity(20000, 20000, S26).taxable).toBeCloseTo(2500, 6);
  });

  it('caps the taxable share at 85% of benefits', () => {
    expect(taxableSocialSecurity(40000, 100000, S26).taxable).toBeCloseTo(34000, 6);
  });

  it('feeds taxable benefits into AGI and the bracket tax', () => {
    // SS 30,000 + IRA 20,000 single under 65: AGI 25,350, taxable 9,250 → 925.
    const r = federalTax(inc({ socialSecurity: 30000, pretaxWithdrawals: 20000 }), single, S26);
    expect(r.agi).toBeCloseTo(25350, 6);
    expect(r.total).toBeCloseTo(925, 6);
    // Effective rate counts all benefits in gross income: 925 / 50,000.
    expect(r.effectiveRate).toBeCloseTo(925 / 50000, 9);
  });

  it('shows the phase-in "torpedo" in the marginal rate', () => {
    // Taxable 9,250 is in the 10% bracket, and each extra dollar also makes 85 cents
    // of benefits taxable: 10% × 1.85 = 18.5%.
    expect(marginalRate(inc({ socialSecurity: 30000, pretaxWithdrawals: 20000 }), single, S26)).toBeCloseTo(0.185, 6);
    // Further up, in the 12% bracket (IRA 30,000 → taxable 9,250 + 1.85 × 10,000 = 27,750): 12% × 1.85 = 22.2%.
    expect(marginalRate(inc({ socialSecurity: 30000, pretaxWithdrawals: 30000 }), single, S26)).toBeCloseTo(0.222, 6);
  });
});

describe('room to a bracket top and a MAGI cap', () => {
  it('accounts for the Social Security phase-in when filling a bracket', () => {
    // Base: SS 30,000 + IRA 20,000 → taxable 9,250 + 1.85X while benefits phase in.
    // 9,250 + 1.85X = 50,400 → X = 22,243.24.
    const room = ordinaryRoomToRate(inc({ socialSecurity: 30000, pretaxWithdrawals: 20000 }), single, S26, 0.12);
    expect(room).not.toBeNull();
    expect(Math.abs((room as number) - 41150 / 1.85)).toBeLessThan(1);
  });

  it('uses the unused deduction first, then fills the bracket', () => {
    // No income: 16,100 of deduction + 50,400 to the 12% top = 66,500.
    expect(Math.abs((ordinaryRoomToRate(ZERO_INCOME, single, S26, 0.12) as number) - 66500)).toBeLessThan(1);
    // Already past the bracket → 0; top bracket → null.
    expect(ordinaryRoomToRate(inc({ wages: 90000 }), single, S26, 0.12)).toBe(0);
    expect(ordinaryRoomToRate(ZERO_INCOME, single, S26, 0.37)).toBeNull();
  });

  it('finds the room under a MAGI cap', () => {
    expect(Math.abs(ordinaryRoomToMagi(inc({ wages: 60000 }), single, S26, 109000) - 49000)).toBeLessThan(1);
    expect(ordinaryRoomToMagi(inc({ wages: 120000 }), single, S26, 109000)).toBe(0);
  });
});

describe('irmaaTier', () => {
  const t27 = irmaaTiersFor(2027, 'single', 0.03);

  it('keeps MAGI exactly at a threshold in the lower tier', () => {
    const r = irmaaTier(112000, t27);
    expect(r.tier).toBe(0);
    expect(r.annualPerPerson).toBe(0);
    expect(r.roomToNext).toBe(0);
  });

  it('charges the first tier just above it and reports room to the next', () => {
    const r = irmaaTier(112001, t27);
    expect(r.tier).toBe(1);
    expect(r.partB).toBeCloseTo(83.7, 9);
    expect(r.partD).toBeCloseTo(15.4, 9);
    expect(r.annualPerPerson).toBeCloseTo((83.7 + 15.4) * 12, 6); // 1,189.20
    expect(r.roomToNext).toBe(141000 - 112001);
  });

  it('starts the top tier AT its amount', () => {
    expect(irmaaTier(499999, t27)).toMatchObject({ tier: 4, roomToNext: 0, ceiling: 499999 });
    expect(irmaaTier(500000, t27)).toMatchObject({ tier: 5, roomToNext: null, nextOver: null });
  });

  it('uses the joint thresholds and grows them past the last table', () => {
    expect(irmaaTier(224000, irmaaTiersFor(2027, 'joint', 0)).tier).toBe(0);
    expect(irmaaTier(218001, irmaaTiersFor(2026, 'joint', 0)).tier).toBe(1);
    const t29 = irmaaTiersFor(2029, 'single', 0.03);
    expect(t29[1].over).toBeCloseTo(112000 * 1.0609, 6);
    expect(t29[1].partB).toBeCloseTo(83.7 * 1.0609, 6);
  });

  it('treats zero or junk MAGI as no surcharge', () => {
    expect(irmaaTier(0, t27).tier).toBe(0);
    expect(irmaaTier(NaN, t27).tier).toBe(0);
  });
});

describe('payrollTax', () => {
  it('caps Social Security at the wage base and adds Medicare on all wages', () => {
    // 6.2% × 184,500 = 11,439; 1.45% × 200,000 = 2,900; additional 0 at exactly 200,000.
    expect(payrollTax([200000], S26)).toBeCloseTo(14339, 6);
  });

  it('applies the Additional Medicare Tax to household wages over the joint threshold', () => {
    // Two earners at 150,000: 18,600 + 4,350 + 0.9% × 50,000 = 23,400.
    expect(payrollTax([150000, 150000], J26)).toBeCloseTo(23400, 6);
    expect(payrollTax([], J26)).toBe(0);
    expect(payrollTax([0, -10], J26)).toBe(0);
  });

  it('uses the published 2027 Social Security wage base, growing it with inflation only after that', () => {
    // 2027 base $192,300 (SSA, Federal Register 2026-21796), not 184,500 × 1.03 = 190,035.
    const s27 = taxParamsFor(2027, 'single', 0.03);
    expect(s27.payroll.wageBase).toBe(192300);
    // 6.2% × 192,300 = 11,922.60; 1.45% × 200,000 = 2,900 → 14,822.60.
    expect(payrollTax([200000], s27)).toBeCloseTo(14822.6, 6);
    // 2029 = 192,300 × 1.03² = 204,011.07; 2026 stays as published; earlier years use 2026's as-is.
    expect(taxParamsFor(2029, 'single', 0.03).payroll.wageBase).toBeCloseTo(192300 * 1.0609, 6);
    expect(S26.payroll.wageBase).toBe(184500);
    expect(taxParamsFor(2020, 'single', 0.03).payroll.wageBase).toBe(184500);
    // Junk inflation does not go NaN; the Additional Medicare threshold stays nominal.
    expect(taxParamsFor(2030, 'joint', NaN).payroll.wageBase).toBe(192300);
    expect(taxParamsFor(2030, 'joint', 0.03).payroll.addlThreshold).toBe(250000);
  });
});
