import { stepMonth, monthLong } from '../../lib/budgetView.ts';

// One stroked chevron for all three cells, so the arrows and the select's caret
// share a weight and follow the theme (currentColor) instead of mixing ◂ ▸ glyphs
// with the platform's own select arrow.
const CHEVRON = {
  left: 'M10 3.5 5.5 8l4.5 4.5',
  right: 'M6 3.5 10.5 8 6 12.5',
  down: 'M5 6.5l3 3 3-3',
} as const;
function Chevron({ dir }: { dir: keyof typeof CHEVRON }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path d={CHEVRON[dir]} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// The Budget tab's one period control: ◂ June 2026 ▸. The arrows step through
// the months that have data; the month name is a native select (so it opens the
// platform's own list, a wheel on a phone) of every month on record.
//
// The select is laid invisibly over a drawn label (month + caret) in the same
// grid cell. A select is as wide as its longest option, so the cell keeps one
// width as you step between months, while the label keeps the caret right next
// to the name and centres the pair; the select still takes the clicks, the
// keyboard and the screen reader.
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
        aria-label={prev ? `Previous month, ${monthLong(prev)}` : 'No earlier month'} title={prev ? monthLong(prev) : undefined}>
        <Chevron dir="left" />
      </button>
      <span className="bud-period-month">
        <select value={value} onChange={e => onChange(e.target.value)} aria-label="Choose a month">
          {(months.includes(value) ? months : [value, ...months]).map(m => <option key={m} value={m}>{monthLong(m)}</option>)}
        </select>
        <span className="bud-period-label" aria-hidden="true">{monthLong(value)}<Chevron dir="down" /></span>
      </span>
      <button type="button" onClick={() => next && onChange(next)} disabled={!next}
        aria-label={next ? `Next month, ${monthLong(next)}` : 'No later month'} title={next ? monthLong(next) : undefined}>
        <Chevron dir="right" />
      </button>
    </div>
  );
}
