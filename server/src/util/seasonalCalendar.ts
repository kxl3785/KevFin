// Seasonal, date-driven considerations for the quarterly report: what is coming
// up in the months after the statement is generated (tax deadlines, enrollment
// windows, year-end cut-offs), filtered by the kinds of account the user holds.
//
// Pure and deterministic, so the section appears with or without the assistant
// and can be unit-tested for any date. Deliberately conservative:
//   - U.S. federal calendar only, and only rules that recur every year.
//   - No dollar limits or thresholds — those change annually and would go stale.
//   - Dates are the nominal ones. The IRS moves a deadline that lands on a weekend
//     or holiday to the next business day; the report says so rather than guess.
// All date math is in UTC, like the rest of the report (util/reportWindow.ts).

// Which tax buckets hold a balance (keys from util/taxBucket.ts).
export interface SeasonalHoldings {
  taxable?: boolean; pretax?: boolean; roth?: boolean; hsa?: boolean; college?: boolean;
}

export interface SeasonalItem {
  when: string;    // "By Apr 15", "Oct – Dec"
  title: string;
  detail: string;
}

// How far past the report date the calendar looks. A quarter plus a month, so a
// statement generated on Jan 1 still reaches the mid-April filing deadline.
export const SEASONAL_HORIZON_DAYS = 120;
// A window (open enrollment, the year-end stretch) is listed once it is open or
// about to open, not a full quarter early: July's statement should not be mostly
// about December.
export const SEASONAL_LEAD_DAYS = 30;
// Enough to be useful, short enough to read; lowest-priority items drop first.
export const SEASONAL_MAX_ITEMS = 8;

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

type MD = [month0: number, day: number];

interface Entry {
  end: MD;                 // the deadline, or the last day of a window
  start?: MD;              // first day of a window (same calendar year as `end`)
  when?: string;           // label for a window; a bare deadline reads "By <date>"
  priority: number;        // 1 = keep first when the list is capped
  applies?: (h: SeasonalHoldings) => boolean;
  // `year` is the calendar year the entry falls in.
  title: (year: number, h: SeasonalHoldings) => string;
  detail: (year: number, h: SeasonalHoldings) => string;
}

const hasRetirement = (h: SeasonalHoldings) => !!(h.pretax || h.roth);

const estimated = (label: string, end: MD, incomeYear: (y: number) => number): Entry => ({
  end, priority: 2, applies: h => !!h.taxable,
  title: () => `${label} estimated tax payment`,
  detail: y => `For ${incomeYear(y)} income that has no withholding, such as capital gains, dividends, interest or self-employment income. Skip it if withholding already covers your tax.`,
});

const ENTRIES: Entry[] = [
  // --- January to April: last year's taxes --------------------------------
  estimated('Fourth-quarter', [0, 15], y => y - 1),
  {
    start: [0, 1], end: [1, 15], when: 'January', priority: 2,
    applies: h => hasRetirement(h) || !!h.hsa,
    title: () => 'Reset contributions for the new year',
    detail: (_y, h) => `Contribution limits for ${[hasRetirement(h) && 'retirement accounts', h.hsa && 'HSAs'].filter(Boolean).join(' and ')} usually change each January. Update payroll deferrals and automatic transfers to match what you intend to put in this year.`,
  },
  {
    start: [0, 15], end: [1, 28], when: 'Late Jan – Feb', priority: 3,
    title: () => 'Tax forms arrive',
    detail: (y, h) => `W-2s and most 1099s for ${y - 1} are issued by the end of January` +
      (h.taxable ? '; brokerage 1099s often follow by mid-February and are sometimes corrected later' : '') +
      '. Wait until you have them all before filing.',
  },
  {
    end: [3, 15], priority: 1,
    title: y => `${y - 1} tax return due`,
    detail: () => 'File the federal return or request an extension. An extension gives more time to file, not more time to pay.',
  },
  {
    end: [3, 15], priority: 1,
    title: (y, h) => `Last day for ${y - 1} IRA${h.hsa ? ' and HSA' : ''} contributions`,
    detail: (y, h) => `Contributions can still be counted toward ${y - 1} until the filing deadline, if you had room left. ` +
      (h.roth || h.pretax ? 'Tell the custodian which year the deposit is for.' : 'An extension to file does not extend this date.'),
  },
  estimated('First-quarter', [3, 15], y => y),
  {
    start: [3, 15], end: [5, 30], when: 'After filing', priority: 2,
    title: () => 'Adjust withholding',
    detail: () => 'If the return showed a large balance due or a large refund, update your W-4 or estimated payments now so the rest of the year lands closer.',
  },

  // --- May to September: mid-year ------------------------------------------
  estimated('Second-quarter', [5, 15], y => y),
  {
    start: [5, 15], end: [7, 31], when: 'Mid-year', priority: 2,
    title: () => 'Mid-year check',
    detail: (_y, h) => (hasRetirement(h) ? 'Check that retirement contributions are on pace for the year, and that ' : 'Check that ') +
      'tax withholding matches your income so far. A change made now has half a year to take effect.',
  },
  estimated('Third-quarter', [8, 15], y => y),

  // --- October to December: year-end ---------------------------------------
  {
    end: [9, 15], priority: 3,
    title: y => `Extended ${y - 1} tax returns due`,
    detail: () => 'Only if you filed for an extension in April.',
  },
  {
    start: [9, 1], end: [11, 31], when: 'From Oct 1', priority: 3, applies: h => !!h.college,
    title: () => 'Financial aid applications open',
    detail: () => 'The FAFSA for the next school year normally opens around October 1. Filing early helps with aid that is awarded first come, first served.',
  },
  {
    start: [9, 15], end: [11, 15], when: 'Oct – Dec', priority: 1,
    title: () => 'Health-plan open enrollment',
    detail: (_y, h) => 'Employer plans usually enroll in the fall, Medicare runs October 15 to December 7, and the ACA marketplace opens November 1. ' +
      `It is the one time to change coverage${h.hsa ? ' and to set next year’s HSA contribution' : ''}.`,
  },
  {
    start: [9, 1], end: [11, 31], priority: 1, applies: h => !!h.taxable,
    title: () => 'Tax-loss harvesting and gains planning',
    detail: y => `A sale counts for ${y} only if it is made by December 31. When replacing a holding sold at a loss, mind the 30-day wash-sale rule.`,
  },
  {
    start: [9, 1], end: [11, 31], priority: 1, applies: h => hasRetirement(h),
    title: () => 'Workplace retirement contributions',
    detail: y => `401(k) and similar deferrals have to come out of ${y} paychecks, so any change needs to reach payroll before the last pay date of the year.`,
  },
  {
    start: [9, 1], end: [11, 31], priority: 2, applies: h => !!h.pretax,
    title: () => 'Roth conversions and required distributions',
    detail: y => `A conversion counts for ${y} only if completed by December 31 and cannot be undone. If you are of RMD age or hold an inherited IRA, the year’s required distribution is generally due by the same date.`,
  },
  {
    start: [9, 1], end: [11, 31], priority: 2,
    title: () => 'Charitable gifts',
    detail: (y, h) => `Gifts must be made by December 31 to count for ${y}.` +
      (h.taxable ? ' Giving appreciated shares from a taxable account instead of cash avoids the capital gain.' : ''),
  },
  {
    start: [9, 1], end: [11, 31], priority: 3, applies: h => !!h.college,
    title: () => 'Education savings contributions',
    detail: () => 'If you use a 529 plan, many states allow a deduction only for contributions made by December 31.',
  },
  {
    start: [9, 1], end: [11, 31], priority: 4,
    title: () => 'Use up health FSA money',
    detail: () => 'If you have a health flexible spending account, unspent money is usually forfeited at the plan’s deadline, often December 31.',
  },
];

const DAY = 86400_000;
const utc = (y: number, [m, d]: MD) => Date.UTC(y, m, d);

interface Hit { entry: Entry; year: number; startMs: number; endMs: number }

// Items for the months after the report date, soonest deadline first: anything
// due within SEASONAL_HORIZON_DAYS, plus windows that are open now or open within
// SEASONAL_LEAD_DAYS.
export function seasonalItems(now: Date, holdings: SeasonalHoldings = {}): SeasonalItem[] {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const limit = today + SEASONAL_HORIZON_DAYS * DAY;
  const soon = today + SEASONAL_LEAD_DAYS * DAY;
  const hits: Hit[] = [];
  for (const entry of ENTRIES) {
    if (entry.applies && !entry.applies(holdings)) continue;
    for (const year of [now.getUTCFullYear(), now.getUTCFullYear() + 1]) {
      const endMs = utc(year, entry.end);
      const startMs = entry.start ? utc(year, entry.start) : endMs;
      if (endMs >= today && (endMs <= limit || startMs <= soon)) { hits.push({ entry, year, startMs, endMs }); break; }
    }
  }
  // Cap by priority first, then present in date order (ENTRIES order breaks ties).
  // A labelled window sits where it opens (or today, if already open); a deadline
  // sits on its date.
  const at = (h: Hit) => (h.entry.when ? Math.max(h.startMs, today) : h.endMs);
  const kept = hits
    .map((h, i) => ({ h, i }))
    .sort((a, b) => a.h.entry.priority - b.h.entry.priority || a.h.endMs - b.h.endMs || a.i - b.i)
    .slice(0, SEASONAL_MAX_ITEMS)
    .sort((a, b) => at(a.h) - at(b.h) || a.i - b.i)
    .map(x => x.h);
  return kept.map(({ entry, year }) => ({
    when: entry.when ?? `By ${MON[entry.end[0]]} ${entry.end[1]}`,
    title: entry.title(year, holdings),
    detail: entry.detail(year, holdings),
  }));
}

// "Nov 2026 – Mar 2027": the months the calendar above covers.
export function seasonalRangeLabel(now: Date): string {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + SEASONAL_HORIZON_DAYS * DAY);
  const a = `${MON[now.getUTCMonth()]} ${now.getUTCFullYear()}`;
  const b = `${MON[end.getUTCMonth()]} ${end.getUTCFullYear()}`;
  return now.getUTCFullYear() === end.getUTCFullYear() ? `${MON[now.getUTCMonth()]} – ${b}` : `${a} – ${b}`;
}
