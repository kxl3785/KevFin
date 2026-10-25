// Shared display formats, so money and dates read the same on every page.
//
// Money: whole dollars for totals, cents for individual transactions; negatives use
// a true minus sign before the dollar sign ("−$1,234", never "$-1,234" or "-$1,234").
// Dates: "Oct 24, 2026", or "Oct 24" when the context is already a single year; a
// month alone is "Oct 2026". ISO strings ('YYYY-MM-DD') are read as calendar dates,
// not instants, so they never shift a day in US timezones.

export const MINUS = '−';

export function fmtMoney(n: number, opts: { cents?: boolean; sign?: boolean } = {}): string {
  const abs = Math.abs(n);
  const digits = opts.cents ? 2 : 0;
  const body = abs.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const rounded = Number(abs.toFixed(digits));
  if (n < 0 && rounded !== 0) return `${MINUS}$${body}`;
  return `${opts.sign && rounded !== 0 ? '+' : ''}$${body}`;
}

// Compact money for chart axes and tight spaces: "$950", "$1.2k", "$15k", "$1.3M".
export function fmtMoneyCompact(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 && Math.round(abs) !== 0 ? MINUS : '';
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}k`;
  return `${sign}$${Math.round(abs)}`;
}

function toDate(d: string | Date): Date {
  if (d instanceof Date) return d;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(d);
}

// "Oct 24, 2026"; pass { year: false } where the year is already clear from context.
export function fmtDate(d: string | Date, opts: { year?: boolean } = {}): string {
  return toDate(d).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', ...(opts.year === false ? {} : { year: 'numeric' }),
  });
}

// "Oct 2026".
export function fmtMonth(d: string | Date): string {
  return toDate(d).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}
