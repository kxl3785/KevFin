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
