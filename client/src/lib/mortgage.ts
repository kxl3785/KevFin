// Client-side mirror of server/src/util/amortization.ts. The two packages can't
// share modules, so the math is duplicated and each side is covered by tests.
// Used by the dashboard (live balance preview) and the Forecast simulation
// (amortizing the mortgage forward year by year).

/** Remaining principal on a fixed-rate, fully-amortizing loan as of `asOf`. */
export function remainingMortgageBalance(
  principal: number, ratePct: number, startISO: string, termYears = 30, asOf: Date = new Date(),
): number {
  if (!principal || principal <= 0 || !startISO || termYears <= 0) return 0;
  const start = new Date(startISO + 'T00:00:00');
  if (isNaN(start.getTime())) return 0;
  const N = Math.round(termYears * 12);
  let k = (asOf.getFullYear() - start.getFullYear()) * 12 + (asOf.getMonth() - start.getMonth());
  if (asOf.getDate() < start.getDate()) k -= 1;
  k = Math.max(0, Math.min(k, N));
  if (k >= N) return 0;
  const i = ratePct / 100 / 12;
  if (i === 0) return Math.max(0, principal * (1 - k / N));
  const g = Math.pow(1 + i, N), gk = Math.pow(1 + i, k);
  const pay = (principal * (i * g)) / (g - 1);
  return Math.max(0, principal * gk - (pay * (gk - 1)) / i);
}

/** Level monthly principal-and-interest payment (unrounded). */
export function monthlyMortgagePayment(principal: number, ratePct: number, termYears = 30): number {
  if (!principal || principal <= 0 || termYears <= 0) return 0;
  const N = Math.round(termYears * 12);
  const i = ratePct / 100 / 12;
  if (i === 0) return principal / N;
  const g = Math.pow(1 + i, N);
  return (principal * i * g) / (g - 1);
}

/** Whole + fractional years until the loan is scheduled to be paid off, from `asOf`. */
export function payoffYearsFromNow(startISO: string, termYears = 30, asOf: Date = new Date()): number {
  if (!startISO || termYears <= 0) return 0;
  const start = new Date(startISO + 'T00:00:00');
  if (isNaN(start.getTime())) return 0;
  const N = Math.round(termYears * 12);
  let k = (asOf.getFullYear() - start.getFullYear()) * 12 + (asOf.getMonth() - start.getMonth());
  if (asOf.getDate() < start.getDate()) k -= 1;
  k = Math.max(0, Math.min(k, N));
  return Math.max(0, (N - k) / 12);
}

/**
 * Step a mortgage forward 12 months from `balance`, paying the fixed monthly
 * `payment`. Returns the year-end balance and the interest (cost) vs principal
 * (equity) split. Stops paying once the balance hits zero — so the model frees
 * up that cash flow at payoff. A zero/empty balance is a no-op.
 */
export function amortizeYear(balance: number, ratePct: number, payment: number):
  { endBalance: number; interest: number; principal: number } {
  if (balance <= 0 || payment <= 0) return { endBalance: Math.max(0, balance), interest: 0, principal: 0 };
  const i = ratePct / 100 / 12;
  let bal = balance, interest = 0, principal = 0;
  for (let m = 0; m < 12 && bal > 0; m++) {
    const int = bal * i;
    let prin = payment - int;
    if (prin <= 0) { prin = 0; } // payment doesn't cover interest (degenerate) → no paydown
    if (prin > bal) prin = bal;  // final payment trims to the balance
    interest += int;
    principal += prin;
    bal -= prin;
  }
  return { endBalance: Math.max(0, bal), interest, principal };
}
