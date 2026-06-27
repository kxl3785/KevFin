/**
 * Remaining principal on a fixed-rate, fully-amortizing loan as of `asOf`,
 * using a standard monthly amortization schedule (e.g. a 30-year mortgage):
 *
 *   monthly payment  M = P · i(1+i)^N / ((1+i)^N − 1)
 *   balance after k   B_k = P(1+i)^k − M·((1+i)^k − 1)/i
 *
 * where i = monthly rate, N = total payments, k = payments already made.
 *
 * @param principal      original loan amount
 * @param annualRatePct  nominal annual interest rate, e.g. 6.5 for 6.5%
 * @param startISO       origination / first-payment month, 'YYYY-MM-DD'
 * @param termYears      amortization term in years (30 for a standard mortgage)
 * @param asOf           date to evaluate the balance at (defaults to now)
 */
export function remainingMortgageBalance(
  principal: number,
  annualRatePct: number,
  startISO: string,
  termYears = 30,
  asOf: Date = new Date(),
): number {
  if (!principal || principal <= 0 || !startISO || termYears <= 0) return 0;

  const start = new Date(startISO + 'T00:00:00');
  if (isNaN(start.getTime())) return 0;

  const N = Math.round(termYears * 12);

  // Payments elapsed between origination and `asOf` (whole months).
  let k = (asOf.getFullYear() - start.getFullYear()) * 12 + (asOf.getMonth() - start.getMonth());
  if (asOf.getDate() < start.getDate()) k -= 1; // this month's payment isn't due yet
  k = Math.max(0, Math.min(k, N));
  if (k >= N) return 0; // loan fully paid off

  const i = annualRatePct / 100 / 12;
  let balance: number;
  if (i === 0) {
    balance = principal * (1 - k / N); // interest-free → linear paydown
  } else {
    const g = Math.pow(1 + i, N);
    const gk = Math.pow(1 + i, k);
    const payment = (principal * (i * g)) / (g - 1);
    balance = principal * gk - (payment * (gk - 1)) / i;
  }
  return Math.max(0, Math.round(balance * 100) / 100);
}

/**
 * Level monthly principal-and-interest payment on a fully-amortizing loan,
 * M = P · i(1+i)^N / ((1+i)^N − 1). Unrounded so callers that iterate the
 * schedule (interest/principal split) don't accumulate rounding drift; round at
 * the display boundary instead.
 */
export function monthlyMortgagePayment(principal: number, annualRatePct: number, termYears = 30): number {
  if (!principal || principal <= 0 || termYears <= 0) return 0;
  const N = Math.round(termYears * 12);
  const i = annualRatePct / 100 / 12;
  if (i === 0) return principal / N; // interest-free → equal principal slices
  const g = Math.pow(1 + i, N);
  return (principal * i * g) / (g - 1);
}

export interface MortgageSplit {
  payment: number;          // level monthly P&I (rounded to cents)
  balance: number;          // remaining principal as of `asOf`
  monthInterest: number;    // interest portion of the next scheduled payment
  monthPrincipal: number;   // principal portion of the next scheduled payment
  annualInterest: number;   // interest paid over the next 12 months (or until payoff)
  annualPrincipal: number;  // principal paid over the next 12 months (or until payoff)
  payoffISO: string;        // scheduled payoff month, 'YYYY-MM-DD' (start + term)
  monthsRemaining: number;  // scheduled payments left as of `asOf`
}

/**
 * Decompose a mortgage into its cost (interest) vs equity-building (principal)
 * parts as of `asOf`, plus payoff timing. The split is forward-looking from the
 * current balance: the next payment's interest is balance·i and the rest is
 * principal; the annual figures iterate that recurrence for 12 months (stopping
 * early at payoff). All inputs mirror `remainingMortgageBalance`.
 */
export function mortgageSplit(
  principal: number,
  annualRatePct: number,
  startISO: string,
  termYears = 30,
  asOf: Date = new Date(),
): MortgageSplit {
  const empty: MortgageSplit = {
    payment: 0, balance: 0, monthInterest: 0, monthPrincipal: 0,
    annualInterest: 0, annualPrincipal: 0, payoffISO: '', monthsRemaining: 0,
  };
  if (!principal || principal <= 0 || !startISO || termYears <= 0) return empty;
  const start = new Date(startISO + 'T00:00:00');
  if (isNaN(start.getTime())) return empty;

  const N = Math.round(termYears * 12);
  const i = annualRatePct / 100 / 12;
  const rawPayment = monthlyMortgagePayment(principal, annualRatePct, termYears);
  const balance = remainingMortgageBalance(principal, annualRatePct, startISO, termYears, asOf);

  // Payments elapsed (same convention as remainingMortgageBalance) → remaining.
  let k = (asOf.getFullYear() - start.getFullYear()) * 12 + (asOf.getMonth() - start.getMonth());
  if (asOf.getDate() < start.getDate()) k -= 1;
  k = Math.max(0, Math.min(k, N));
  const monthsRemaining = Math.max(0, N - k);

  // Iterate the recurrence forward from the current balance for up to 12 months.
  let bal = balance, annualInterest = 0, annualPrincipal = 0;
  for (let m = 0; m < 12 && bal > 0; m++) {
    const interest = bal * i;
    let principalPaid = rawPayment - interest;
    if (principalPaid > bal) principalPaid = bal; // final payment trims to the balance
    annualInterest += interest;
    annualPrincipal += principalPaid;
    bal -= principalPaid;
  }
  const monthInterest = balance * i;

  const payoff = new Date(start);
  payoff.setMonth(payoff.getMonth() + N);

  const c2 = (n: number) => Math.round(n * 100) / 100;
  return {
    payment: c2(rawPayment),
    balance,
    monthInterest: c2(monthInterest),
    monthPrincipal: c2(rawPayment - monthInterest),
    annualInterest: c2(annualInterest),
    annualPrincipal: c2(annualPrincipal),
    payoffISO: payoff.toISOString().slice(0, 10),
    monthsRemaining,
  };
}
