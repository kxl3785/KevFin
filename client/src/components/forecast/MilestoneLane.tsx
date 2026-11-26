import { useEffect, useRef, useState } from 'react';
import { layoutPins, fitPinSize, foldKey, type KeyEntry } from '../../lib/forecastDisplay.ts';

// Milestones under the Forecast chart: a lane of emoji pins directly below the
// plot, one per age that has something on it, and a key beneath ("44 🏠 Buy a
// home"). The pin itself says what it is, so the key is for names, not for
// decoding. Life events used to float over the lines as chips, and the
// retirement / Social Security / paid-off labels stacked on top of each other
// around 65–67; here nothing covers the plot and nothing overlaps (pins too close
// together are spread around their true ages, with a short leader to each).
//
// Life-event pins keep the chips' interactions: drag one along the lane to move
// the event to another age, click (or Enter) to edit it, arrow keys move it a year.
// Where several things share an age they share a pin: it shows the first one's
// emoji with a "+N" badge, dragging it moves its first life event, and each thing
// has its own entry in the key. Pins for the plan's own milestones (retirement,
// Social Security, college, mortgage payoff) open the input section where that age
// is set. Repeat purchases (a car every 8 years) show a small dot at each later
// year, which also opens the editor.
//
// Repeats of one milestone (three kids starting college) fold into one key entry
// listing every age; each age there is still its own button. Hovering or focusing
// a pin lights up its key entries, and hovering or focusing an entry (or one of
// its ages) lights up its pins.

export interface LaneEvent {
  id: string; label: string; icon: string; age: number;
  repeats?: number[]; // later ages of a repeat purchase
}
export interface LaneMark {
  key: string; age: number; icon: string; label: string;
  plural?: string;    // the key's name when several of these fold into one entry
  tone: string;       // CSS colour (a token) for the pin's ring
  section?: string;   // input section that sets it (opened on click)
}

const PIN_MAX = 30; // pin diameter, px — room for a legible emoji
const PIN_MIN = 22; // smallest a crowded lane (a phone, a busy plan) shrinks it to
const PIN_PAD = 2;  // minimum space between neighbouring pins
const PIN_TOP = 12; // the pins hang this far below the rule; leaders fill the gap

type Member = { kind: 'event'; ev: LaneEvent } | { kind: 'mark'; mark: LaneMark };
interface Group { age: number; members: Member[] }
interface Item { id: string; kind: 'event' | 'mark'; icon: string; label: string; plural?: string; age: number; m: Member }

// What is lit up: a pin (by age), or a key entry — or one age within it.
type Hot = { from: 'pin'; age: number } | { from: 'key'; entry: string; age?: number } | null;

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
  // Keyboard moves: which event the arrow keys are carrying, and a request to put
  // focus back on its pin after the move. Moving an event onto another event's
  // age merges the two pins (and moving it off splits them), which replaces the
  // focused button; without this, focus fell to the page and the keys stopped.
  const [carried, setCarried] = useState<string | null>(null);
  const [hot, setHot] = useState<Hot>(null);
  const refocus = useRef<string | null>(null);
  const laneRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const id = refocus.current;
    if (!id) return;
    refocus.current = null;
    const pins = laneRef.current?.querySelectorAll<HTMLButtonElement>('button.fc-pin[data-evs]') ?? [];
    for (const b of pins) if ((b.dataset.evs ?? '').split(' ').includes(id)) { b.focus(); break; }
  });

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
  // Within a pin, life events first (the pin drags the first one and shows its emoji).
  const groups = [...byAge.values()].sort((a, b) => a.age - b.age)
    .map(g => ({ ...g, members: [...g.members].sort((x, y) => (x.kind === y.kind ? 0 : x.kind === 'event' ? -1 : 1)) }));
  // Full-size pins when they fit side by side; smaller ones on a crowded lane.
  const pin = fitPinSize(groups.length, right - left + 8, PIN_MAX, PIN_MIN, PIN_PAD);
  const trueX = groups.map(g => ageToX(g.age));
  const drawX = layoutPins(trueX, pin + PIN_PAD, left + pin / 2 - 4, right - pin / 2 + 4);

  // The key: one entry per milestone, repeats folded together.
  const items: Item[] = groups.flatMap(g => g.members.map(m => m.kind === 'event'
    ? { id: 'ev-' + m.ev.id, kind: 'event' as const, icon: m.ev.icon, label: m.ev.label, age: g.age, m }
    : { id: 'mk-' + m.mark.key, kind: 'mark' as const, icon: m.mark.icon, label: m.mark.label, plural: m.mark.plural, age: g.age, m }));
  const entries = foldKey(items);

  const iconOf = (m: Member) => (m.kind === 'event' ? m.ev.icon : m.mark.icon);
  const labelOf = (m: Member) => (m.kind === 'event' ? m.ev.label : m.mark.label);
  const firstEvent = (g: Group) => g.members.find(m => m.kind === 'event') as { kind: 'event'; ev: LaneEvent } | undefined;
  const ring = (g: Group) => { const m = g.members[0]; return m.kind === 'event' ? 'var(--accent)' : m.mark.tone; };
  const toneOf = (m: Member) => (m.kind === 'event' ? 'var(--accent)' : m.mark.tone);
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

  // Linking pins and key entries.
  const pinHot = (age: number) => !!hot && (hot.from === 'pin'
    ? hot.age === age
    : hot.age != null ? hot.age === age : !!entries.find(e => e.key === hot.entry)?.ages.includes(age));
  const entryHot = (e: KeyEntry<Item>) => !!hot && (hot.from === 'key' ? hot.entry === e.key : e.ages.includes(hot.age));
  const ageHot = (e: KeyEntry<Item>, age: number) => !!hot && hot.from === 'key' && hot.entry === e.key && hot.age === age;
  const clearHot = () => setHot(null);
  const lightPin = (age: number) => ({
    onPointerEnter: () => setHot({ from: 'pin', age }), onPointerLeave: clearHot,
  });
  // Hover and focus on a key entry, or on one age inside it. A row that holds
  // several age buttons takes hover only: focus lands on (and is lit by) the ages.
  const lightEntry = (entry: string, age?: number, focus = true) => ({
    onPointerEnter: () => setHot({ from: 'key', entry, age }),
    onPointerLeave: () => setHot(age != null ? { from: 'key', entry } : null),
    ...(focus ? { onFocus: () => setHot({ from: 'key', entry, age }), onBlur: clearHot } : {}),
  });

  const ageList = (e: KeyEntry<Item>) => e.ages.length > 1 ? `ages ${e.ages.slice(0, -1).join(', ')} and ${e.ages[e.ages.length - 1]}` : `age ${e.ages[0]}`;

  // One key entry: age(s) in bold, the emoji, the name. A single life event or a
  // plan milestone is one button (as before); a folded run of life events has a
  // button per age, since each age is a separate event to edit.
  const renderEntry = (e: KeyEntry<Item>) => {
    const tone = toneOf(e.items[0].m);
    const cls = 'fc-lane-entry' + (entryHot(e) ? ' hot' : '');
    const quiet = e.kind === 'mark';
    const name = <><span aria-hidden="true" className="fc-lane-emoji">{e.icon}</span> <span className={quiet ? 'fc-lane-auto' : undefined}>{e.name}</span></>;
    const ages = (wrapAge?: (it: Item, i: number) => React.ReactNode) => (
      <span className="fc-lane-ages">
        {e.items.map((it, i) => (
          <span key={it.id} className="fc-lane-agewrap">
            {i > 0 && <span aria-hidden="true" className="fc-lane-sep">·</span>}
            {wrapAge ? wrapAge(it, i) : <span className="fc-lane-age">{it.age}</span>}
          </span>
        ))}
      </span>
    );
    if (e.kind === 'event' && e.items.length > 1) {
      return (
        <li key={e.key} className={cls} style={{ '--tone': tone } as React.CSSProperties} {...lightEntry(e.key, undefined, false)}>
          {ages(it => {
            const id = (it.m as { kind: 'event'; ev: LaneEvent }).ev.id;
            return (
              <button type="button" className={'fc-lane-link fc-lane-age' + (id === editingId ? ' on' : '') + (ageHot(e, it.age) ? ' hot' : '')}
                {...lightEntry(e.key, it.age)}
                onClick={() => onEdit(id)} title={`Edit “${it.label}” at age ${it.age}`}
                aria-label={`Edit life event: ${it.label}, age ${it.age}`}>{it.age}</button>
            );
          })}
          {name}
        </li>
      );
    }
    if (e.kind === 'event') {
      const id = (e.items[0].m as { kind: 'event'; ev: LaneEvent }).ev.id;
      return (
        <li key={e.key} className={cls} style={{ '--tone': tone } as React.CSSProperties}>
          <button type="button" className={'fc-lane-link' + (id === editingId ? ' on' : '')} {...lightEntry(e.key)}
            onClick={() => onEdit(id)} title={`Edit “${e.name}”`} aria-label={`Edit life event: ${e.name}, age ${e.ages[0]}`}>
            {ages()} {name}
          </button>
        </li>
      );
    }
    const mark = (e.items[0].m as { kind: 'mark'; mark: LaneMark }).mark;
    // Folded ages keep their own wording for a screen reader ("57: 2 kids start college").
    const said = e.items.length > 1 && e.items.some(i => i.label !== e.items[0].label)
      ? e.items.map(i => `${i.label} at ${i.age}`).join(', ')
      : `${e.name}, ${ageList(e)}`;
    return (
      <li key={e.key} className={cls} style={{ '--tone': tone } as React.CSSProperties}>
        {mark.section
          ? <button type="button" className="fc-lane-link" {...lightEntry(e.key)} onClick={() => onOpenSection(mark.section!)}
              title="Open the section where this is set" aria-label={`${said}. Open the section where this is set`}>
              {ages()} {name}
            </button>
          : <span className="fc-lane-link static" {...lightEntry(e.key, undefined, false)}>
              <span className="fc-lane-sr">{said}</span><span aria-hidden="true">{ages()} {name}</span>
            </span>}
      </li>
    );
  };

  return (
    <div className="fc-lane-wrap" ref={laneRef} style={{ '--pin': pin + 'px' } as React.CSSProperties}>
      <div className="fc-lane" style={{ pointerEvents: addMode ? 'none' : undefined }}>
        <span className="fc-lane-rule" style={{ left, width: Math.max(0, right - left) }} aria-hidden="true" />
        {/* Leaders from each pin back to its true age (straight down when it wasn't moved). */}
        <svg className="fc-lane-leaders" aria-hidden="true">
          {groups.map((g, i) => (
            <line key={g.age} x1={trueX[i]} y1={1} x2={drawX[i]} y2={PIN_TOP - 1}
              stroke={pinHot(g.age) ? 'var(--text)' : 'var(--muted)'} strokeWidth={1} opacity={0.7} />
          ))}
        </svg>
        {/* Later years of repeat purchases. */}
        {events.flatMap(ev => (ev.repeats ?? []).filter(a => a >= startAge && a <= endAge).map(a => (
          <button key={ev.id + '@' + a} type="button" className="fc-lane-dot" style={{ left: ageToX(a) }}
            title={`${ev.icon} ${ev.label} · repeats at age ${a} (click to edit)`} aria-label={`Edit life event: ${ev.label}, repeats at age ${a}`}
            onClick={e => { e.stopPropagation(); onEdit(ev.id); }} />
        )))}
        {groups.map((g, i) => {
          // The pin acts on its first event, unless the keyboard is carrying
          // another one that sits on it: that one keeps moving, so an event
          // dropped onto a shared pin can be carried off it again.
          const evs = g.members.filter((m): m is { kind: 'event'; ev: LaneEvent } => m.kind === 'event');
          const ev = evs.find(m => m.ev.id === carried) ?? firstEvent(g);
          const editing = g.members.some(m => m.kind === 'event' && m.ev.id === editingId);
          // The pin shows the emoji of what it acts on (the carried event, else the first).
          const shown = ev ?? g.members[0];
          const more = g.members.length - 1;
          const names = g.members.map(labelOf).join(', ');
          return (
            // Keyed by the event it moves, not by age: a key of the age remounted
            // the button on every arrow-key step, dropping focus after one move.
            <button key={ev ? 'ev-' + ev.ev.id : 'age-' + g.age} type="button"
              className={'fc-pin' + (ev ? ' drag' : '') + (editing ? ' on' : '') + (pinHot(g.age) ? ' hot' : '')}
              data-evs={evs.map(m => m.ev.id).join(' ') || undefined}
              {...lightPin(g.age)}
              onFocus={() => setHot({ from: 'pin', age: g.age })}
              onBlur={() => { if (!refocus.current) { setCarried(null); clearHot(); } }}
              style={{ left: drawX[i], borderColor: ring(g) }}
              title={titleOf(g)}
              aria-label={ev
                ? `Age ${g.age}: ${names}. Life event. Enter to edit ${ev.ev.label}, arrow keys to move it.`
                : `Age ${g.age}: ${names}. Milestone${g.members[0].kind === 'mark' && g.members[0].mark.section ? ', opens the section where it is set' : ''}.`}
              onPointerDown={e => { if (ev) { e.preventDefault(); onDragStart(ev.ev.id, e); } }}
              onClick={() => press(g)}
              onKeyDown={e => {
                if (!ev) return;
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onEdit(ev.ev.id); }
                else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                  e.preventDefault();
                  const to = Math.max(startAge, Math.min(endAge, g.age + (e.key === 'ArrowRight' ? 1 : -1)));
                  setCarried(ev.ev.id);
                  setHot({ from: 'pin', age: to });
                  refocus.current = ev.ev.id;
                  onMove(ev.ev.id, to);
                }
              }}>
              <span className="fc-pin-emoji" aria-hidden="true">{iconOf(shown)}</span>
              {more > 0 && <span className="fc-pin-more" aria-hidden="true">+{more}</span>}
            </button>
          );
        })}
      </div>
      {entries.length > 0 && (
        <ul className="fc-lane-key" aria-label="Milestones by age">
          {entries.map(renderEntry)}
        </ul>
      )}
    </div>
  );
}
