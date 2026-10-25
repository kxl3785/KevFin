// Pure SVG/number builders for the quarterly report. No I/O, no dependencies —
// every label is escaped here so callers can pass raw strings, and every chart
// carries role="img" plus an aria-label spelling out the actual values.

export const esc = (s: string) =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export const C = {
  paper: '#fbfbf8', ink: '#1d2420', muted: '#5f6862', rule: '#d9ddd5',
  pine: '#2c4a3e', sage: '#7fa38b', sand: '#c9a35a', slate: '#6d7f96',
  up: '#2f7d4f', down: '#b0473c', shade: '#e7eee8', grey: '#9aa69e',
};
// Categorical ramp for donut / stacked bar. Neighbours differ in lightness as
// well as hue (dark pine → mid sage → light sand → mid slate → pale slate → grey).
export const RAMP = [C.pine, C.sage, C.sand, C.slate, '#b7c3d1', '#8f9189'];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const fmtMoney = (n: number) => (n < 0 ? '−' : '') + '$' + Math.abs(Math.round(n)).toLocaleString('en-US');
export const fmtSigned = (n: number) => (n < 0 ? '−' : '+') + '$' + Math.abs(Math.round(n)).toLocaleString('en-US');
// Compact: $620k, $1.2M, $850.
export function fmtK(n: number): string {
  const a = Math.abs(n), sign = n < 0 ? '−' : '';
  if (a >= 1_000_000) return `${sign}$${(a / 1_000_000).toFixed(a >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (a >= 1000) return `${sign}$${(a / 1000).toFixed(a >= 100_000 ? 0 : 1).replace(/\.0$/, '')}k`;
  return `${sign}$${Math.round(a)}`;
}
const r1 = (n: number) => Math.round(n * 10) / 10;

// US-style dates, matching client/src/lib/format.ts. ISO strings are read as
// calendar dates (no timezone math). "Jun 30, 2026", or "Jun 30" with year=false.
export function fmtDateUS(iso: string, year = true): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}${year ? `, ${y}` : ''}`;
}
// "Apr 1 – Jun 30, 2026" (year on the start too when the range spans years).
export function fmtRangeUS(startIso: string, endIso: string): string {
  const sameYear = startIso.slice(0, 4) === endIso.slice(0, 4);
  return `${fmtDateUS(startIso, !sameYear)} – ${fmtDateUS(endIso)}`;
}

// 'YYYY-MM' → "Sep ’26" (long=true) or "Sep".
export function monthLabel(key: string, long = false): string {
  const [y, m] = key.split('-').map(Number);
  return long ? `${MONTHS[m - 1]} ’${String(y).slice(2)}` : MONTHS[m - 1];
}

// --- change attribution --------------------------------------------------------

export interface Attribution {
  start: number; end: number;       // whole dollars
  saved: number; home: number;      // whole dollars
  market: number;                   // remainder, whole dollars
}

// Splits (end − start) into saved + home-equity change + remainder. Everything is
// rounded to whole dollars FIRST and the remainder is derived from the rounded
// parts, so start + saved + home + market === end exactly as printed.
export function attributeChange(a: { start: number; end: number; saved: number; homeEquityDelta: number }): Attribution {
  const start = Math.round(a.start), end = Math.round(a.end);
  const saved = Math.round(a.saved), home = Math.round(a.homeEquityDelta);
  return { start, end, saved, home, market: end - start - saved - home };
}

// --- month-end series ----------------------------------------------------------

export interface MonthPoint { key: string; value: number }

// Month-end net worth for the `count` months ending at `endKey` (YYYY-MM): for
// each month, the last snapshot dated in that month. Months with no snapshot are
// skipped (so a short history just yields fewer points). `history` ascending.
export function monthEndSeries(history: { date: string; net_worth: number }[], endKey: string, count = 12): MonthPoint[] {
  const [ey, em] = endKey.split('-').map(Number);
  const keys: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(ey, em - 1 - i, 1));
    keys.push(d.toISOString().slice(0, 7));
  }
  const last = new Map<string, number>();
  for (const s of history) last.set(s.date.slice(0, 7), s.net_worth);
  return keys.filter(k => last.has(k)).map(k => ({ key: k, value: last.get(k)! }));
}

// --- trend line ----------------------------------------------------------------

export function trendSvg(points: MonthPoint[], shadeKeys: string[], shadeLabel: string): string {
  if (points.length < 2) return '';
  const W = 340, H = 130, x0 = 10, x1 = 318, top = 28, bot = 108;
  const vals = points.map(p => p.value);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const xAt = (i: number) => x0 + (i * (x1 - x0)) / (points.length - 1);
  const yAt = (v: number) => (hi === lo ? (top + bot) / 2 : bot - ((v - lo) / (hi - lo)) * (bot - top));
  const pts = points.map((p, i) => `${r1(xAt(i))},${r1(yAt(p.value))}`).join(' ');
  const firstShaded = points.findIndex(p => shadeKeys.includes(p.key));
  let shade = '';
  if (firstShaded >= 0) {
    const sx = firstShaded > 0 ? xAt(firstShaded - 1) : 4;
    shade = `<rect x="${r1(sx)}" y="4" width="${r1(330 - sx)}" height="112" fill="${C.shade}"></rect>` +
      `<text x="${r1((sx + 330) / 2)}" y="16" text-anchor="middle" font-size="11" fill="${C.pine}">${esc(shadeLabel)}</text>`;
  }
  const first = points[0], lastP = points[points.length - 1];
  const aria = `Net worth over the last ${points.length} months, from ${fmtMoney(first.value)} in ${monthLabel(first.key, true)} to ${fmtMoney(lastP.value)} in ${monthLabel(lastP.key, true)}`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(aria)}">` +
    shade +
    `<line x1="10" y1="116" x2="330" y2="116" stroke="${C.rule}"></line>` +
    `<polyline fill="none" stroke="${C.pine}" stroke-width="2.5" stroke-linejoin="round" points="${pts}"></polyline>` +
    `<circle cx="${r1(xAt(points.length - 1))}" cy="${r1(yAt(lastP.value))}" r="4" fill="${C.pine}"></circle>` +
    `<text x="10" y="128" font-size="11" fill="${C.muted}">${esc(monthLabel(first.key, true))}</text>` +
    `<text x="330" y="128" font-size="11" fill="${C.muted}" text-anchor="end">${esc(monthLabel(lastP.key, true))}</text></svg>`;
}

// --- waterfall -----------------------------------------------------------------

// Axis for the waterfall. When the steps are small next to the totals (span under
// 25% of the top level) a zero-based axis flattens them, so start at a round number
// just below the lowest level instead. `truncated` drives the subtitle.
export function waterfallAxis(levels: number[]): { lo: number; hi: number; truncated: boolean } {
  const min = Math.min(...levels), max = Math.max(...levels);
  const span = max - min;
  if (min <= 0 || span <= 0 || span / max >= 0.25) return { lo: Math.min(0, min), hi: max, truncated: false };
  const step = Math.pow(10, Math.floor(Math.log10(span)));
  const lo = Math.floor((min - 0.6 * span) / step) * step;
  return lo > 0 ? { lo, hi: max, truncated: true } : { lo: 0, hi: max, truncated: false };
}

export interface WaterfallInput {
  startLabel: string; endLabel: string;
  start: number; end: number;
  steps: { label: string; sublabel?: string; amount: number; title?: string }[];
}

// Greedy word-wrap for the compact (phone) variant, where each bar has ~65px.
function wrapWords(text: string, max: number): string[] {
  const out: string[] = [];
  for (const word of text.split(' ')) {
    const last = out[out.length - 1];
    if (last !== undefined && (last + ' ' + word).length <= max) out[out.length - 1] = last + ' ' + word;
    else out.push(word);
  }
  return out;
}

// `compact` draws the same chart on a narrow canvas (≈ phone card width) with
// larger relative type, wrapped labels and a taller viewBox, so nothing is scaled
// below ~10px on a phone. The template ships both and CSS picks one.
export function waterfallSvg(w: WaterfallInput, opts: { compact?: boolean } = {}): { svg: string; truncated: boolean; axisFloor: number } {
  const compact = !!opts.compact;
  const levels = [w.start];
  for (const s of w.steps) levels.push(levels[levels.length - 1] + s.amount);
  levels.push(w.end);
  const { lo, hi, truncated } = waterfallAxis(levels);
  const W = compact ? 340 : 720, top = 36, bot = 186;
  const x0 = compact ? 4 : 20, span = compact ? 332 : 680;
  const n = w.steps.length + 2;
  const slot = span / n, bw = Math.min(compact ? 54 : 90, slot * (compact ? 0.8 : 0.64));
  const fsVal = compact ? 12.5 : 13, fsLab = compact ? 12 : 12, fsSub = compact ? 11 : 12, lh = 14;
  // Tallest label stack decides the canvas height.
  const lines = (label: string, sublabel?: string) => compact
    ? [...wrapWords(label, 10).map(t => ({ t, sub: false })), ...(sublabel ? wrapWords(sublabel, 10).map(t => ({ t, sub: true })) : [])]
    : [{ t: label, sub: false }, ...(sublabel ? [{ t: sublabel, sub: true }] : [])];
  const stacks = [lines(w.startLabel), ...w.steps.map(s => lines(s.label, s.sublabel)), lines(w.endLabel)];
  const H = bot + 9 + Math.max(...stacks.map(l => l.length)) * lh + 6;
  const yAt = (v: number) => (hi === lo ? bot : bot - ((v - lo) / (hi - lo)) * (bot - top));
  const xAt = (i: number) => x0 + slot * i + (slot - bw) / 2;
  let g = `<line x1="${x0}" y1="${bot}" x2="${x0 + span}" y2="${bot}" stroke="${C.rule}"></line>`;
  const bar = (i: number, from: number, to: number, fill: string, label: string, labelFill: string, stack: { t: string; sub: boolean }[], title?: string) => {
    const yTop = yAt(Math.max(from, to)), yBot = yAt(Math.min(from, to));
    const h = Math.max(1.5, yBot - yTop);
    const cx = xAt(i) + bw / 2;
    g += `<rect x="${r1(xAt(i))}" y="${r1(yTop)}" width="${r1(bw)}" height="${r1(h)}" fill="${fill}">${title ? `<title>${esc(title)}</title>` : ''}</rect>`;
    g += `<text x="${r1(cx)}" y="${r1(yTop - 8)}" text-anchor="middle" font-size="${fsVal}" font-weight="700" fill="${labelFill}">${esc(label)}</text>`;
    stack.forEach((l, k) => {
      g += `<text x="${r1(cx)}" y="${bot + 20 + k * lh + (l.sub ? 3 : 0)}" text-anchor="middle" font-size="${l.sub ? fsSub : fsLab}"${l.sub ? ' font-style="italic"' : ''} fill="${C.muted}">${esc(l.t)}</text>`;
    });
  };
  bar(0, lo, w.start, C.grey, fmtMoney(w.start), C.ink, stacks[0]);
  w.steps.forEach((s, i) => {
    const from = levels[i], to = levels[i + 1];
    bar(i + 1, from, to, s.amount < 0 ? C.down : C.sage, fmtSigned(s.amount), s.amount < 0 ? C.down : C.up, stacks[i + 1], s.title);
  });
  bar(n - 1, lo, w.end, C.pine, fmtMoney(w.end), C.ink, stacks[n - 1]);
  // Dashed connectors at the running level between neighbouring bars.
  for (let i = 0; i < n - 1; i++) {
    const y = r1(yAt(levels[i]));
    g += `<line x1="${r1(xAt(i) + bw)}" y1="${y}" x2="${r1(xAt(i + 1))}" y2="${y}" stroke="${C.grey}" stroke-dasharray="3 3"></line>`;
  }
  const aria = `Waterfall: start ${fmtMoney(w.start)}` +
    w.steps.map(s => `, ${s.amount < 0 ? 'minus' : 'plus'} ${fmtMoney(Math.abs(s.amount))} ${s.label.toLowerCase()}`).join('') +
    `, end ${fmtMoney(w.end)}`;
  return {
    svg: `<svg class="chart${compact ? ' wf-compact' : ' wf-wide'}" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(aria)}">${g}</svg>`,
    truncated, axisFloor: lo,
  };
}

// --- donut ---------------------------------------------------------------------

export function donutSvg(slices: { label: string; pct: number }[], centerTop: string, centerValue: string): string {
  const total = slices.reduce((s, d) => s + d.pct, 0) || 1;
  const R = 50, CIRC = 2 * Math.PI * R;
  let off = 0;
  const arcs = slices.map((d, i) => {
    const len = (d.pct / total) * CIRC;
    const c = `<circle cx="70" cy="70" r="${R}" stroke="${RAMP[i % RAMP.length]}" stroke-dasharray="${r1(len)} ${r1(CIRC)}"` +
      `${off ? ` stroke-dashoffset="${-r1(off)}"` : ''}></circle>`;
    off += len;
    return c;
  }).join('');
  const aria = `Asset allocation: ${slices.map(d => `${d.label} ${Math.round(d.pct)}%`).join(', ')}`;
  return `<svg class="chart donut" viewBox="0 0 140 140" width="140" height="140" role="img" aria-label="${esc(aria)}">` +
    `<g transform="rotate(-90 70 70)" fill="none" stroke-width="22">${arcs}</g>` +
    `<text x="70" y="66" text-anchor="middle" font-size="12" fill="${C.muted}">${esc(centerTop)}</text>` +
    `<text x="70" y="84" text-anchor="middle" font-size="15" font-weight="700" fill="${C.ink}">${esc(centerValue)}</text></svg>`;
}

// --- grouped bars (income vs spending per month) ---------------------------------

export function groupedBarsSvg(
  groups: { label: string; a: number; b: number }[], aName: string, bName: string,
): string {
  const W = 340, H = 170, base = 140, maxH = 96;
  const max = Math.max(...groups.map(g => Math.max(g.a, g.b)), 1);
  const slot = 310 / groups.length;
  const bw = Math.min(34, slot * 0.34);
  let g = `<line x1="20" y1="${base}" x2="330" y2="${base}" stroke="${C.rule}"></line>`;
  groups.forEach((gr, i) => {
    const cx = 20 + slot * i + slot / 2;
    const ha = (Math.max(gr.a, 0) / max) * maxH, hb = (Math.max(gr.b, 0) / max) * maxH;
    const xa = cx - bw - 2, xb = cx + 2;
    g += `<rect x="${r1(xa)}" y="${r1(base - ha)}" width="${r1(bw)}" height="${r1(ha)}" fill="${C.pine}"></rect>`;
    g += `<rect x="${r1(xb)}" y="${r1(base - hb)}" width="${r1(bw)}" height="${r1(hb)}" fill="${C.sand}"></rect>`;
    g += `<text x="${r1(xa + bw / 2)}" y="${r1(base - ha - 4)}" text-anchor="middle" font-size="11" fill="${C.ink}">${esc(fmtK(gr.a))}</text>`;
    g += `<text x="${r1(xb + bw / 2)}" y="${r1(base - hb - 4)}" text-anchor="middle" font-size="11" fill="${C.ink}">${esc(fmtK(gr.b))}</text>`;
    g += `<text x="${r1(cx)}" y="158" text-anchor="middle" font-size="12" fill="${C.muted}">${esc(gr.label)}</text>`;
  });
  g += `<rect x="40" y="6" width="10" height="10" fill="${C.pine}"></rect><text x="56" y="15" font-size="12" fill="${C.ink}">${esc(aName)}</text>`;
  g += `<rect x="120" y="6" width="10" height="10" fill="${C.sand}"></rect><text x="136" y="15" font-size="12" fill="${C.ink}">${esc(bName)}</text>`;
  const aria = `Monthly ${aName.toLowerCase()} and ${bName.toLowerCase()}: ` +
    groups.map(x => `${x.label} ${fmtMoney(x.a)} and ${fmtMoney(x.b)}`).join('; ');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(aria)}">${g}</svg>`;
}
