import { stepMonth, monthLong } from '../../lib/budgetView.ts';

// The Budget tab's one period control: ◂ June 2026 ▸. The arrows step through
// the months that have data; the month name is a native select (so it opens the
// platform's own list, a wheel on a phone) of every month on record.
export default function MonthPicker({ months, value, onChange }: {
  months: string[]; // newest first
  value: string;
  onChange: (ym: string) => void;
}) {
  const prev = stepMonth(months, value, -1);
  const next = stepMonth(months, value, 1);
  return (
    <div className="bud-period" role="group" aria-label="Month">
      <button type="button" onClick={() => prev && onChange(prev)} disabled={!prev}
        aria-label={prev ? `Previous month, ${monthLong(prev)}` : 'No earlier month'} title={prev ? monthLong(prev) : undefined}>◂</button>
      <select value={value} onChange={e => onChange(e.target.value)} aria-label="Choose a month">
        {(months.includes(value) ? months : [value, ...months]).map(m => <option key={m} value={m}>{monthLong(m)}</option>)}
      </select>
      <button type="button" onClick={() => next && onChange(next)} disabled={!next}
        aria-label={next ? `Next month, ${monthLong(next)}` : 'No later month'} title={next ? monthLong(next) : undefined}>▸</button>
    </div>
  );
}
