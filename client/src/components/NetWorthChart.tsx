import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend,
} from 'recharts';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { useIsMobile } from '../hooks/useIsMobile.ts';
import { axisScale, fmtAxisMoney, dateTicks } from '../lib/axis.ts';
import { fmtMoney, fmtDate } from '../lib/format.ts';
import {
  measureSpan, direction, fmtSpanChange, fmtSpanDates, fmtPctChange, describeMeasurement,
  type Measurement,
} from '../lib/historyMeasure.ts';

interface ChartPoint {
  date: string;
  accounts_total: number;
  real_estate_total: number;
  net_worth: number;
  index?: number | null;
}

/** The plot area (inside the axes) in px from the chart box's top-left; `right` is the gap to its right edge. */
interface PlotBox { left: number; top: number; right: number; height: number }

/**
 * A drag-to-measure selection: two point indices in drag order (`a` is where the
 * drag started). `key` ties it to what the chart showed when it was made, so a
 * change of range, mode or series drops it without an effect.
 */
interface Selection { key: string; a: number; b: number; plot: PlotBox; dragging: boolean }

// Press-and-hold before a touch starts measuring, and how far a finger may drift
// meanwhile. Moving sooner than that is a scroll, and the page keeps it.
const HOLD_MS = 350;
const HOLD_SLOP_PX = 10;

const MEASURE_NOTE = 'A change in net worth between the two dates. It includes deposits and withdrawals, so it is not an investment return.';
const INDEX_NOTE = "The comparison is the index's own change over the same dates, with dividends reinvested.";

export default function NetWorthChart({
  data,
  mode = 'stacked',
  showAccounts = true,
  showRealEstate = true,
  indexLabel,
  onToggleSeries,
  interactive = true,
  initialSelection,
}: {
  data: ChartPoint[];
  mode?: 'stacked' | 'lines';
  showAccounts?: boolean;
  showRealEstate?: boolean;
  indexLabel?: string;
  onToggleSeries?: (dataKey: string) => void;
  /** False in privacy mode: no measuring, and nothing announced. */
  interactive?: boolean;
  /** For tests: a finished measurement between two point indices. */
  initialSelection?: { a: number; b: number };
}) {
  const sorted = useMemo(() => [...data].sort((a, b) => a.date.localeCompare(b.date)), [data]);
  const stacked = mode === 'stacked';
  // A little shorter on a phone so the chart doesn't dominate the screen.
  const isMobile = useIsMobile();
  const uid = useId();
  const chartId = `nw${uid.replace(/:/g, '')}`;

  // Scale the axis to what is actually drawn. A hidden series is passed in as a
  // column of zeroes (so the stack keeps its height), so it must not drag the
  // zoomed floor down to $0 — skip it here the same way `hide` skips it below.
  const y = useMemo(() => {
    const vals: number[] = [];
    for (const p of sorted) {
      vals.push(p.net_worth);
      if (typeof p.index === 'number' && Number.isFinite(p.index)) vals.push(p.index);
      // In stacked mode the areas sum to net_worth, which is already counted;
      // only the separate lines set their own extents.
      if (!stacked) {
        if (showAccounts) vals.push(p.accounts_total);
        if (showRealEstate) vals.push(p.real_estate_total);
      }
    }
    if (vals.length === 0) return axisScale(0, 0, { zeroBased: true });
    // Stacked areas are read against a $0 baseline; lines mode zooms in so a
    // month of movement is a visible slope rather than a flat thread.
    return axisScale(Math.min(...vals), Math.max(...vals), {
      zeroBased: stacked,
      targetTicks: isMobile ? 4 : 5,
    });
  }, [sorted, stacked, showAccounts, showRealEstate, isMobile]);

  const x = useMemo(() => dateTicks(sorted.map(p => p.date), isMobile ? 4 : 7), [sorted, isMobile]);

  // --- Drag to measure -------------------------------------------------------
  // The guides, wash and dots are drawn in a plain overlay above the chart, not
  // as Recharts reference elements: adding or moving a Recharts child makes it
  // re-derive every series (≈1,800 points × 4 over five years) on each pointer
  // move. The chart element below is memoized, so a drag only re-renders the
  // overlay and the readout.
  const key = `${mode}|${showAccounts}|${showRealEstate}|${indexLabel ?? ''}|${sorted.length}|${sorted[0]?.date}|${sorted[sorted.length - 1]?.date}`;
  const [selState, setSel] = useState<Selection | null>(() =>
    initialSelection ? { key, ...initialSelection, plot: { left: 0, top: 0, right: 0, height: 0 }, dragging: false } : null);
  const sel = interactive && selState && selState.key === key ? selState : null;
  const measurement = useMemo(
    () => (sel ? measureSpan(sorted, sel.a, sel.b, { showAccounts, showRealEstate, hasIndex: !!indexLabel }) : null),
    [sel, sorted, showAccounts, showRealEstate, indexLabel],
  );
  const [announcement, setAnnouncement] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);
  const announceTimer = useRef<ReturnType<typeof setTimeout>>();

  // Native listeners (touch, Escape) read the latest render through this ref.
  const live = useRef({ sorted, key, interactive, sel, measurement, indexLabel });
  live.current = { sorted, key, interactive, sel, measurement, indexLabel };

  // The plot rectangle, read from the clip path Recharts draws around it, so the
  // overlay lines up with the axes exactly at any width and margin.
  function measurePlot(): PlotBox | null {
    const box = boxRef.current;
    const rect = box?.querySelector<SVGRectElement>(`clipPath[id="${chartId}-clip"] rect`);
    const svg = rect?.ownerSVGElement;
    if (!box || !rect || !svg) return null;
    const b = box.getBoundingClientRect(), s = svg.getBoundingClientRect();
    const w = Number(rect.getAttribute('width')), h = Number(rect.getAttribute('height'));
    const left = s.left - b.left + Number(rect.getAttribute('x'));
    const top = s.top - b.top + Number(rect.getAttribute('y'));
    if (!(w > 0) || !(h > 0)) return null;
    return { left, top, right: b.width - left - w, height: h };
  }

  // The data point nearest a viewport x. The date axis is a category axis on a
  // point scale (a ComposedChart with no bars), so the points sit evenly from the
  // plot's left edge to its right; past either edge it snaps to the end point.
  function indexAt(clientX: number, plot: PlotBox): number {
    const box = boxRef.current;
    const n = live.current.sorted.length;
    if (!box || n < 2) return 0;
    const b = box.getBoundingClientRect();
    const w = b.width - plot.left - plot.right;
    const f = Math.min(1, Math.max(0, (clientX - b.left - plot.left) / w));
    return Math.round(f * (n - 1));
  }

  function inPlot(clientX: number, clientY: number, plot: PlotBox): boolean {
    const b = boxRef.current!.getBoundingClientRect();
    const px = clientX - b.left, py = clientY - b.top;
    return px >= plot.left - 4 && px <= b.width - plot.right + 4 && py >= plot.top && py <= plot.top + plot.height;
  }

  // Announce a finished measurement politely; keyboard steps wait for a pause so
  // holding an arrow key doesn't queue a sentence per point.
  function announce(m: Measurement | null, delay = 0) {
    clearTimeout(announceTimer.current);
    const text = m ? describeMeasurement(m, live.current.indexLabel) : '';
    if (delay) announceTimer.current = setTimeout(() => setAnnouncement(text), delay);
    else setAnnouncement(text);
  }

  function measureOf(s: Selection | null): Measurement | null {
    const { sorted: pts } = live.current;
    return s ? measureSpan(pts, s.a, s.b, { showAccounts, showRealEstate, hasIndex: !!indexLabel }) : null;
  }

  function start(clientX: number, plot: PlotBox) {
    const i = indexAt(clientX, plot);
    const next = { key: live.current.key, a: i, b: i, plot, dragging: true };
    live.current.sel = next;
    setSel(next);
  }
  function move(clientX: number) {
    const cur = live.current.sel;
    if (!cur?.dragging) return;
    const i = indexAt(clientX, cur.plot);
    // Only a new point is a new render; most pointer moves stay on one.
    if (i === cur.b) return;
    const next = { ...cur, b: i };
    live.current.sel = next;
    setSel(next);
  }
  function finish() {
    const cur = live.current.sel;
    if (!cur?.dragging) return;
    // A press without a drag (or a drag back to where it began) measures
    // nothing, so it just clears — the same as a plain click.
    const done = cur.a === cur.b ? null : { ...cur, dragging: false };
    live.current.sel = done;
    setSel(done);
    announce(measureOf(done));
  }
  function clear() {
    live.current.sel = null;
    setSel(null);
    announce(null);
  }

  // Mouse and pen: press, drag, release. Touch is handled below (press and hold),
  // so a finger swiping across the chart still scrolls the page.
  const pointerId = useRef<number | null>(null);
  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (!interactive || e.pointerType === 'touch' || e.button !== 0) return;
    const plot = measurePlot();
    if (!plot || sorted.length < 2 || !inPlot(e.clientX, e.clientY, plot)) return;
    pointerId.current = e.pointerId;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    start(e.clientX, plot);
  }
  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.pointerId === pointerId.current) move(e.clientX);
  }
  function onPointerEnd(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.pointerId !== pointerId.current) return;
    pointerId.current = null;
    finish();
  }

  // Touch: hold still for HOLD_MS, then slide. Until the hold completes nothing
  // is prevented, so a swipe (even a sideways one) scrolls as it always has;
  // once it completes, touchmove is cancelled so the slide measures instead.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let armed = false, moved = false, x0 = 0, y0 = 0;
    const reset = () => { clearTimeout(timer); timer = undefined; armed = false; };
    const onStart = (e: TouchEvent) => {
      reset();
      moved = false;
      if (!live.current.interactive || e.touches.length !== 1 || live.current.sorted.length < 2) return;
      const t = e.touches[0];
      const plot = measurePlot();
      if (!plot || !inPlot(t.clientX, t.clientY, plot)) return;
      x0 = t.clientX; y0 = t.clientY;
      timer = setTimeout(() => { armed = true; start(x0, plot); }, HOLD_MS);
    };
    const onMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      if (armed) { e.preventDefault(); move(t.clientX); return; }
      if (Math.hypot(t.clientX - x0, t.clientY - y0) > HOLD_SLOP_PX) { moved = true; clearTimeout(timer); }
    };
    const onEnd = (e: TouchEvent) => {
      const wasArmed = armed, pending = timer !== undefined && !armed;
      reset();
      if (wasArmed) { e.preventDefault(); finish(); }
      // A quick tap clears a measurement, like a click.
      else if (pending && !moved && live.current.sel) clear();
    };
    const onCancel = () => { const wasArmed = armed; reset(); if (wasArmed) finish(); };
    // A long press would otherwise open the browser's menu over the chart.
    const onMenu = (e: Event) => { if (armed || timer !== undefined) e.preventDefault(); };
    box.addEventListener('touchstart', onStart, { passive: true });
    box.addEventListener('touchmove', onMove, { passive: false });
    box.addEventListener('touchend', onEnd);
    box.addEventListener('touchcancel', onCancel);
    box.addEventListener('contextmenu', onMenu);
    return () => {
      reset();
      box.removeEventListener('touchstart', onStart);
      box.removeEventListener('touchmove', onMove);
      box.removeEventListener('touchend', onEnd);
      box.removeEventListener('touchcancel', onCancel);
      box.removeEventListener('contextmenu', onMenu);
    };
    // The handlers read everything that changes through `live`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Escape clears a measurement from anywhere on the page.
  const hasSel = !!sel;
  useEffect(() => {
    if (!hasSel) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') clear(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasSel]);

  // Whatever drops the selection (range, mode, series, privacy) also silences it.
  useEffect(() => { if (!measurement) { clearTimeout(announceTimer.current); setAnnouncement(''); } }, [measurement]);
  useEffect(() => () => clearTimeout(announceTimer.current), []);

  // Keyboard: the first arrow measures the whole range shown; after that the
  // arrows move the later end and Shift + arrows the earlier one, about 1/60 of
  // the range per press (a point at a time on short ranges). Tab leaves as usual.
  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (!interactive || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    const n = sorted.length;
    const plot = measurePlot();
    if (n < 2 || !plot) return;
    e.preventDefault();
    const dir = e.key === 'ArrowRight' ? 1 : -1;
    const step = Math.max(1, Math.round((n - 1) / 60));
    let lo: number, hi: number;
    if (!sel || sel.a === sel.b) { lo = 0; hi = n - 1; }
    else {
      lo = Math.min(sel.a, sel.b); hi = Math.max(sel.a, sel.b);
      if (e.shiftKey) lo = Math.min(hi - 1, Math.max(0, lo + dir * step));
      else hi = Math.max(lo + 1, Math.min(n - 1, hi + dir * step));
    }
    const next = { key, a: lo, b: hi, plot, dragging: false };
    live.current.sel = next;
    setSel(next);
    announce(measureOf(next), 600);
  }

  const chart = useMemo(() => (
    <ResponsiveContainer>
      {/* key={mode} forces a clean remount when switching area↔line so every
          series re-renders (recharts otherwise drops series on type swap). */}
      <ComposedChart key={mode} id={chartId} data={sorted} margin={{ top: 8, right: 16, left: 16, bottom: 0 }}>
        <defs>
          {/* Fills fade toward the baseline so the bands read as layers rather than
              solid blocks; every colour is a theme token, so all themes follow. */}
          <linearGradient id="gRE" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--green)" stopOpacity={0.36} />
            <stop offset="95%" stopColor="var(--green)" stopOpacity={0.06} />
          </linearGradient>
          <linearGradient id="gAcc" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--accent)" stopOpacity={0.42} />
            <stop offset="95%" stopColor="var(--accent)" stopOpacity={0.1} />
          </linearGradient>
        </defs>
        {/* Horizontal rules only — vertical ones just add noise behind a
            date axis whose ticks are already one-per-month. */}
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
        <XAxis
          dataKey="date"
          ticks={x.ticks}
          tick={{ fill: 'var(--muted)', fontSize: 12 }}
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={16}
          tickFormatter={x.label}
        />
        <YAxis
          tick={{ fill: 'var(--muted)', fontSize: 12 }}
          tickLine={false}
          axisLine={false}
          width={isMobile ? 48 : 58}
          domain={y.domain}
          ticks={y.ticks}
          interval={0}
          allowDataOverflow={!stacked}
          tickMargin={6}
          tickFormatter={v => fmtAxisMoney(v, y.step)}
        />
        <Tooltip
          contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.18)', fontSize: 13 }}
          cursor={{ stroke: 'var(--muted)', strokeDasharray: '3 3' }}
          labelStyle={{ color: 'var(--text)', marginBottom: 4 }}
          labelFormatter={(d: string) => fmtDate(d)}
          formatter={(val: number, name: string) => [fmtMoney(val), name]}
        />
        <Legend
          wrapperStyle={{ fontSize: 13, color: 'var(--muted)', cursor: 'pointer' }}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onClick={(e: any) => { const k = e?.dataKey; if (typeof k === 'string') onToggleSeries?.(k); }}
        />

        {stacked ? (
          <>
            {/* Stacked composition: real estate on the bottom, accounts on top. */}
            <Area
              type="monotone" dataKey="real_estate_total" name="Home equity" stackId="nw"
              stroke="var(--green)" fill="url(#gRE)" strokeWidth={1.5} dot={false} hide={!showRealEstate}
            />
            <Area
              type="monotone" dataKey="accounts_total" name="Accounts & assets" stackId="nw"
              stroke="var(--accent)" fill="url(#gAcc)" strokeWidth={1.5} dot={false} hide={!showAccounts}
            />
          </>
        ) : (
          <>
            {/* Trend lines, no fill — readable against a zoomed axis. */}
            <Line
              type="monotone" dataKey="real_estate_total" name="Home equity"
              stroke="var(--green)" strokeWidth={2} dot={false} hide={!showRealEstate}
            />
            <Line
              type="monotone" dataKey="accounts_total" name="Accounts & assets"
              stroke="var(--accent)" strokeWidth={2} dot={false} hide={!showAccounts}
            />
          </>
        )}

        {/* Net worth — the headline line, drawn on top in both modes. */}
        <Line
          type="monotone" dataKey="net_worth" name="Net Worth"
          stroke="var(--text)" strokeWidth={2.25} dot={false}
          activeDot={{ r: 4, fill: 'var(--bg)', stroke: 'var(--text)', strokeWidth: 2 }}
        />

        {indexLabel && (
          <Line
            type="monotone" dataKey="index" name={indexLabel}
            stroke="var(--chart-5)" strokeWidth={2} strokeDasharray="5 4" dot={false} connectNulls
          />
        )}
      </ComposedChart>
    </ResponsiveContainer>
  ), [sorted, mode, chartId, stacked, x, y, isMobile, showAccounts, showRealEstate, indexLabel, onToggleSeries]);

  // Overlay geometry, as percentages of the plot box so it follows a resize.
  const n = sorted.length;
  const xPct = (i: number) => (n > 1 ? (i / (n - 1)) * 100 : 50);
  const [d0, d1] = y.domain as [number, number];
  const yPct = (v: number) => Math.min(100, Math.max(0, ((d1 - v) / (d1 - d0 || 1)) * 100));
  const ends = sel ? [...new Set([sel.a, sel.b])] : [];
  const lo = sel ? Math.min(sel.a, sel.b) : 0, hi = sel ? Math.max(sel.a, sel.b) : 0;

  return (
    <div className="nw-measure-wrap">
      <MeasureReadout measurement={measurement} indexLabel={indexLabel} compact={isMobile} touch={isMobile} />
      <div
        ref={boxRef}
        className={'nw-chart' + (sel?.dragging ? ' nw-measuring' : '')}
        style={{ width: '100%', height: isMobile ? 240 : 320, position: 'relative' }}
        tabIndex={interactive ? 0 : -1}
        role="group"
        aria-label="Net worth history chart"
        aria-describedby={`${chartId}-help`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onLostPointerCapture={onPointerEnd}
        onKeyDown={onKeyDown}
      >
        {chart}
        {sel && sel.plot.height > 0 && (
          <div className="nw-overlay" aria-hidden="true" style={{
            left: sel.plot.left, top: sel.plot.top, right: sel.plot.right, height: sel.plot.height,
          }}>
            {hi > lo && <div className="nw-wash" style={{ left: `${xPct(lo)}%`, width: `${xPct(hi) - xPct(lo)}%` }} />}
            {ends.map(i => (
              <div key={i}>
                <div className="nw-guide" style={{ left: `${xPct(i)}%` }} />
                <div className="nw-dot" style={{ left: `${xPct(i)}%`, top: `${yPct(sorted[i].net_worth)}%` }} />
              </div>
            ))}
          </div>
        )}
      </div>
      <p id={`${chartId}-help`} className="sr-only">
        Drag across the chart to measure the change in net worth between two dates; on a touch screen, press and hold first.
        With the chart focused, the left and right arrow keys measure from the keyboard: the first press measures the whole range,
        then arrows move the later date and Shift with arrows the earlier one. Escape clears.
      </p>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</div>
    </div>
  );
}

/**
 * The line above the chart: a hint while idle, the measurement once there is
 * one. It keeps a fixed height either way, so the chart never shifts under the
 * pointer, and it sits outside the plot, so it never covers the span measured.
 */
export function MeasureReadout({ measurement: m, indexLabel, compact, touch }: {
  measurement: Measurement | null;
  indexLabel?: string;
  compact: boolean;
  touch: boolean;
}) {
  if (!m) {
    return (
      <div className={'nw-readout idle' + (compact ? ' compact' : '')}>
        {touch ? 'Press and hold the chart, then slide, to measure a change' : 'Drag across the chart to measure a change between two dates'}
      </div>
    );
  }
  const dir = direction(m.netWorth.amount);
  const arrow = dir === 'up' ? '↑' : dir === 'down' ? '↓' : '';
  const parts: string[] = [];
  // A lone switched-on part is the net worth itself, so parts show only in pairs.
  if (m.accounts && m.realEstate) {
    parts.push(`Accounts & assets ${fmtSpanChange(m.accounts)}`, `Home equity ${fmtSpanChange(m.realEstate)}`);
  }
  if (indexLabel && m.indexPct != null) parts.push(`${indexLabel} ${fmtPctChange(m.indexPct)}`);
  const note = indexLabel && m.indexPct != null ? `${MEASURE_NOTE} ${INDEX_NOTE}` : MEASURE_NOTE;
  return (
    <div className={'nw-readout' + (compact ? ' compact' : '')} title={note}>
      <div className="nw-readout-main">
        <span className={'nw-readout-change ' + dir}>
          {fmtSpanChange(m.netWorth)}{arrow && <span aria-hidden="true"> {arrow}</span>}
        </span>
        <span className="nw-readout-dates">{fmtSpanDates(m)}</span>
        {/* The visible "Includes deposits…" line says the short version; the tip says why. */}
        <span className="nw-readout-note" aria-hidden="true">ⓘ</span>
      </div>
      <div className="nw-readout-parts">
        {parts.length > 0 && <span>{parts.join(' · ')}</span>}
        <span className="nw-readout-incl">Includes deposits and withdrawals</span>
      </div>
    </div>
  );
}
