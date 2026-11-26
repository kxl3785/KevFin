import { layoutPins } from '../../lib/forecastDisplay.ts';

// Milestones under the Forecast chart: a lane of numbered pins directly below the
// plot, one per age that has something on it, and a one-line key beneath
// ("1 · 44 🏠 Buy a home"). Life events used to float over the lines as chips,
// and the retirement / Social Security / paid-off labels stacked on top of each
// other around 65–67; here nothing covers the plot and nothing overlaps (pins too
// close together are nudged apart, with a short leader to their true age).
//
// Life-event pins keep the chips' interactions: drag one along the lane to move
// the event to another age, click (or Enter) to edit it, arrow keys move it a year.
// Where several things share an age they share a pin: dragging it moves its first
// life event, and each event has its own button in the key. Pins for the plan's
// own milestones (retirement, Social Security, college, mortgage payoff) open the
// input section where that age is set. Repeat purchases (a car every 8 years) show
// a small dot at each later year, which also opens the editor.

export interface LaneEvent {
  id: string; label: string; icon: string; age: number;
  repeats?: number[]; // later ages of a repeat purchase
}
export interface LaneMark {
  key: string; age: number; icon: string; label: string;
  tone: string;       // CSS colour (a token) for the pin's ring
  section?: string;   // input section that sets it (opened on click)
}

const PIN = 22;     // pin diameter, px
const GAP = PIN + 3; // minimum distance between pin centres

type Member = { kind: 'event'; ev: LaneEvent } | { kind: 'mark'; mark: LaneMark };
interface Group { age: number; members: Member[] }

export default function MilestoneLane({ events, marks, ageToX, left, right, startAge, endAge, editingId, addMode,
  onDragStart, onEdit, onMove, onOpenSection }: {
  events: LaneEvent[];
  marks: LaneMark[];
  ageToX: (age: number) => number;
  left: number; right: number;          // the plot's x range, px
  startAge: number; endAge: number;
  editingId: string | null;
  addMode: boolean;
  onDragStart: (id: string, e: React.PointerEvent) => void;
  onEdit: (id: string) => void;
  onMove: (id: string, age: number) => void;
  onOpenSection: (section: string) => void;
}) {
  // Group everything on the plotted range by age.
  const byAge = new Map<number, Group>();
  const add = (age: number, m: Member) => {
    if (age < startAge || age > endAge) return;
    const g = byAge.get(age) ?? { age, members: [] };
    g.members.push(m);
    byAge.set(age, g);
  };
  for (const ev of events) add(ev.age, { kind: 'event', ev });
  for (const mark of marks) add(mark.age, { kind: 'mark', mark });
  // Within a pin, life events first (the pin drags the first one).
  const groups = [...byAge.values()].sort((a, b) => a.age - b.age)
    .map(g => ({ ...g, members: [...g.members].sort((x, y) => (x.kind === y.kind ? 0 : x.kind === 'event' ? -1 : 1)) }));
  const trueX = groups.map(g => ageToX(g.age));
  const drawX = layoutPins(trueX, GAP, left + PIN / 2 - 4, right - PIN / 2 + 4);

  const iconOf = (m: Member) => (m.kind === 'event' ? m.ev.icon : m.mark.icon);
  const labelOf = (m: Member) => (m.kind === 'event' ? m.ev.label : m.mark.label);
  const firstEvent = (g: Group) => g.members.find(m => m.kind === 'event') as { kind: 'event'; ev: LaneEvent } | undefined;
  const ring = (g: Group) => { const m = g.members[0]; return m.kind === 'event' ? 'var(--accent)' : m.mark.tone; };
  const titleOf = (g: Group) => {
    const names = g.members.map(m => `${iconOf(m)} ${labelOf(m)}`).join(', ');
    const ev = firstEvent(g);
    return `Age ${g.age}: ${names}${ev ? ` — drag to move “${ev.ev.label}”, click to edit` : ' — click to change it'}`;
  };
  const press = (g: Group) => {
    const ev = firstEvent(g);
    if (ev) return;
    const m = g.members[0];
    if (m.kind === 'mark' && m.mark.section) onOpenSection(m.mark.section);
  };

  return (
    <div className="fc-lane-wrap">
      <div className="fc-lane" style={{ pointerEvents: addMode ? 'none' : undefined }}>
        <span className="fc-lane-rule" style={{ left, width: Math.max(0, right - left) }} aria-hidden="true" />
        {/* Leaders from a nudged pin back to its true age. */}
        <svg className="fc-lane-leaders" aria-hidden="true">
          {groups.map((g, i) => (
            <line key={g.age} x1={trueX[i]} y1={1} x2={drawX[i]} y2={11} stroke="var(--muted)" strokeWidth={1} opacity={0.7} />
          ))}
        </svg>
        {/* Later years of repeat purchases. */}
        {events.flatMap(ev => (ev.repeats ?? []).filter(a => a >= startAge && a <= endAge).map(a => (
          <button key={ev.id + '@' + a} type="button" className="fc-lane-dot" style={{ left: ageToX(a) }}
            title={`${ev.icon} ${ev.label} · repeats at age ${a} (click to edit)`} aria-label={`Edit life event: ${ev.label}, repeats at age ${a}`}
            onClick={e => { e.stopPropagation(); onEdit(ev.id); }} />
        )))}
        {groups.map((g, i) => {
          const ev = firstEvent(g);
          const editing = g.members.some(m => m.kind === 'event' && m.ev.id === editingId);
          return (
            <button key={g.age} type="button" className={'fc-pin' + (ev ? ' drag' : '') + (editing ? ' on' : '')}
              style={{ left: drawX[i], borderColor: ring(g) }}
              title={titleOf(g)}
              aria-label={ev ? `Life event ${i + 1}: ${ev.ev.label}, age ${g.age}. Enter to edit, arrow keys to move.` : `Milestone ${i + 1}: ${g.members.map(labelOf).join(', ')}, age ${g.age}`}
              onPointerDown={e => { if (ev) { e.preventDefault(); onDragStart(ev.ev.id, e); } }}
              onClick={() => press(g)}
              onKeyDown={e => {
                if (!ev) return;
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onEdit(ev.ev.id); }
                else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                  e.preventDefault();
                  onMove(ev.ev.id, Math.max(startAge, Math.min(endAge, g.age + (e.key === 'ArrowRight' ? 1 : -1))));
                }
              }}>
              {i + 1}
            </button>
          );
        })}
      </div>
      {groups.length > 0 && (
        <ol className="fc-lane-key">
          {groups.map((g, i) => (
            <li key={g.age}>
              <span className="fc-lane-num" style={{ borderColor: ring(g) }} aria-hidden="true">{i + 1}</span>
              <span className="fc-lane-age">{g.age}</span>
              {g.members.map((m, j) => (
                <span key={j} className="fc-lane-item">
                  {j > 0 && <span aria-hidden="true" className="fc-lane-sep">·</span>}
                  {m.kind === 'event'
                    ? <button type="button" className={'fc-lane-link' + (m.ev.id === editingId ? ' on' : '')} onClick={() => onEdit(m.ev.id)}
                        title={`Edit “${m.ev.label}”`}><span aria-hidden="true">{m.ev.icon}</span> {m.ev.label}</button>
                    : m.mark.section
                      ? <button type="button" className="fc-lane-link quiet" onClick={() => onOpenSection(m.mark.section!)}
                          title="Open the section where this is set"><span aria-hidden="true">{m.mark.icon}</span> {m.mark.label}</button>
                      : <span><span aria-hidden="true">{m.mark.icon}</span> {m.mark.label}</span>}
                </span>
              ))}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
