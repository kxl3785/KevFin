// Budget pace for the Budget tab: how a month's spending compares with spending
// the budget evenly across the days of the month, and where the month ends if
// spending carries on at the same rate. Pure, so the Overview's tiles, chart and
// category bars all read the same numbers.
//
// "Even pace" on day d of an n-day month is budget × d / n: the share of the
// budget you'd have used by the end of today if you spent the same every day.
// "At this rate" is a straight-line projection: spent so far ÷ days so far × n.
// Both count today as a day gone (asOfDay is the day of the month through which
// the month is shown, so day 1 already covers one day of spending).

export interface MonthPace {
  inProgress: boolean;   // false for a completed month
  dayFrac: number;       // share of the month gone (1 for a completed month)
  daysLeft: number;      // days still to come, including today (0 for a completed month)
  budget: number;        // total monthly budget (0 = none set)
  spent: number;
  usedFrac: number | null;     // spent / budget; null without a budget
  left: number | null;         // budget − spent (negative when over); null without a budget
  perDay: number | null;       // what's left spread over daysLeft; null when over, done or no budget
  paceToday: number | null;    // the even-pace figure for today; null without a budget
  vsPace: number | null;       // paceToday − spent: positive = under an even pace
  projected: number | null;    // month-end spend at this rate (the actual total for a completed month)
  projectedVsBudget: number | null; // budget − projected: positive = ends under budget
}

export function monthPace(spent: number, budget: number, asOfDay: number | null, daysInMonth: number): MonthPace {
  const inProgress = asOfDay != null && asOfDay > 0;
  const day = inProgress ? Math.min(asOfDay!, daysInMonth) : daysInMonth;
  const dayFrac = daysInMonth > 0 ? day / daysInMonth : 1;
  const daysLeft = inProgress ? daysInMonth - day + 1 : 0;
  const has = budget > 0;
  const left = has ? budget - spent : null;
  const paceToday = has ? budget * dayFrac : null;
  const projected = inProgress ? (day > 0 ? (spent / day) * daysInMonth : spent) : spent;
  return {
    inProgress, dayFrac, daysLeft, budget, spent,
    usedFrac: has ? spent / budget : null,
    left,
    perDay: has && inProgress && left! > 0 && daysLeft > 0 ? left! / daysLeft : null,
    paceToday,
    vsPace: paceToday != null ? paceToday - spent : null,
    projected,
    projectedVsBudget: has ? budget - projected : null,
  };
}

// The dotted "budget pace" series for the cumulative chart: $0 before the month
// starts rising evenly to the full budget on the last day.
export function paceSeries(budget: number, daysInMonth: number): { day: number; pace: number }[] {
  const out: { day: number; pace: number }[] = [];
  for (let d = 1; d <= daysInMonth; d++) out.push({ day: d, pace: Math.round((budget * d) / daysInMonth * 100) / 100 });
  return out;
}

// One category against its budget: what's left, or how far over. Monthly
// budgets are measured against the month; annual ones against the year to date.
export type CatState = 'none' | 'under' | 'near' | 'over';
export function categoryLeft(spent: number, target: number): { state: CatState; left: number; frac: number } {
  if (!(target > 0)) return { state: 'none', left: 0, frac: 0 };
  const frac = spent / target;
  const state: CatState = spent > target + 0.005 ? 'over' : frac > 0.85 ? 'near' : 'under';
  return { state, left: target - spent, frac };
}

// The colour for a budget bar: --budget-open with no budget (the accent, except
// in Ember, where a faint orange bar read as a warning), then green, amber near
// the limit (over 85%), red over it.
export function barColor(spent: number, target: number): string {
  const s = categoryLeft(spent, target).state;
  return s === 'none' ? 'var(--budget-open)' : s === 'over' ? 'var(--red)' : s === 'near' ? 'var(--amber)' : 'var(--green)';
}

// A bill category for the month. Mid-month: paid once the month's charges reach
// (nearly) the usual recurring amount, part-paid when something but less has
// posted (more may still come), due when nothing has. In a completed month the
// bill is settled: any charge means it was paid, just perhaps smaller than usual
// (a low utility bill isn't "part-paid"), and nothing charged reads "not
// charged", since it can no longer come due in that month.
export type BillState = 'paid' | 'partial' | 'due' | 'none';
export function billState(spent: number, expected: number, inProgress: boolean): BillState {
  const charged = spent > 0.005;
  if (!inProgress) return charged ? 'paid' : 'none';
  if (charged && (expected <= 0 || spent >= expected * 0.9)) return 'paid';
  return charged ? 'partial' : 'due';
}
