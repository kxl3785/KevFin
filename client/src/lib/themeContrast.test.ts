import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Contrast floors for the theme tokens in index.css, read straight from the CSS
// so a later edit to a token can't quietly drop text below WCAG AA. All three
// themes are held to the same floors: body and muted text 4.5:1 on every surface
// they sit on, accent and semantic colours 4.5:1 as text and 3:1 as chart lines,
// and the text on a filled control (accent or danger, at rest and on hover) 4.5:1.
const css = readFileSync(fileURLToPath(new URL('../index.css', import.meta.url)), 'utf8');

function block(selector: string): Record<string, string> {
  const body = css.split(`${selector} {`)[1]?.split('\n}')[0];
  if (!body) throw new Error(`no ${selector} block in index.css`);
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}
const root = block(':root');
// Midnight is the bare :root plus the few tokens only it overrides (its deeper
// button fills); every other theme layers its own block on :root.
const theme = (id: string) => ({ ...root, ...block(id === 'midnight' ? ':root:not([data-theme])' : `:root[data-theme="${id}"]`) });

type Rgb = [number, number, number];
function rgb(tokens: Record<string, string>, value: string): Rgb {
  let v = value;
  while (/^var\(--[\w-]+\)$/.test(v)) v = tokens[v.slice(6, -1)];
  let h = v.replace('#', '');
  if (h.length === 3) h = [...h].map(c => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(h)) throw new Error(`not a hex colour: ${value}`);
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)) as Rgb;
}
// An opaque colour at `a` over another: color-mix(in srgb, fg a%, transparent)
// over a card, or a button faded by opacity.
const mixed = (fg: Rgb, bg: Rgb, a: number) => fg.map((c, i) => Math.round(c * a + bg[i] * (1 - a))) as Rgb;
// rgba(r, g, b, a) composited over an opaque colour.
function over(rgba: string, bg: Rgb): Rgb {
  const m = rgba.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
  if (!m) throw new Error(`not rgba: ${rgba}`);
  const a = +m[4];
  return [+m[1], +m[2], +m[3]].map((c, i) => Math.round(c * a + bg[i] * (1 - a))) as Rgb;
}
const lum = (c: Rgb) => {
  const [r, g, b] = c.map(v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: Rgb, b: Rgb) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

function check(id: string, pairs: [fg: string, bg: string, min: number][]) {
  const t = theme(id);
  const surface = (name: string): Rgb => {
    if (name === 'accent-dim/card') return over(t['accent-dim'], rgb(t, t.surface));
    if (name === 'accent-dim/bg') return over(t['accent-dim'], rgb(t, t.bg));
    // The change chips (.db-chip.up/.down): 12% of their own colour over a card.
    if (name === 'green-chip' || name === 'red-chip') return mixed(rgb(t, t[name.slice(0, -5)]), rgb(t, t.surface), 0.12);
    // The danger button's hover (.btn-danger:hover is 85% opacity) over a card.
    if (name === 'danger-fill/hover') return mixed(rgb(t, t['danger-fill']), rgb(t, t.surface), 0.85);
    return rgb(t, t[name]);
  };
  const misses = pairs
    .map(([fg, bg, min]) => ({ fg, bg, min, got: contrast(rgb(t, t[fg]), surface(bg)) }))
    .filter(p => p.got < p.min)
    .map(p => `${p.fg} on ${p.bg}: ${p.got.toFixed(2)} < ${p.min}`);
  expect(misses).toEqual([]);
}

const TEXT_ON = (fg: string, surfaces: string[], min = 4.5) => surfaces.map(s => [fg, s, min] as [string, string, number]);

// The one set of floors every theme is held to.
const FLOORS: [fg: string, bg: string, min: number][] = [
  ...['text', 'muted'].flatMap(k => TEXT_ON(k, ['bg', 'surface', 'surface-2', 'accent-dim/card', 'accent-dim/bg'])),
  ...['accent', 'green', 'red', 'amber', 'imported', 'spend'].flatMap(k => TEXT_ON(k, ['bg', 'surface', 'surface-2'])),
  ['accent', 'accent-dim/card', 4.5],
  // A change chip's figure and its muted note, on the chip's own tint.
  ['green', 'green-chip', 4.5], ['red', 'red-chip', 4.5], ...TEXT_ON('muted', ['green-chip', 'red-chip']),
  // Text on a filled control: primary buttons, the active nav tab and segmented
  // control, the chat button (--accent-fill), and the danger button.
  ...TEXT_ON('on-accent', ['accent-fill', 'accent-fill-hover', 'danger-fill', 'danger-fill/hover']),
  // A filled control still stands off the card it sits on.
  ['accent-fill', 'surface', 3], ['accent-fill-hover', 'surface', 3],
  // Chart lines and fills against the card and the ground.
  ...['accent', 'green', 'red', 'amber', 'cf-spend', 'accent-2', 'teal', 'scn-1', 'scn-2', 'scn-3', 'scn-4'].flatMap(k => TEXT_ON(k, ['bg', 'surface'], 3)),
];

describe('theme contrast', () => {
  it.each(['midnight', 'mist', 'ember'])('%s meets every floor', id => check(id, FLOORS));

  it('the button fills follow the accent and the red unless a theme deepens them', () => {
    // Ember and Mist carry white on their own accent, so their primary buttons
    // must stay the accent; Midnight's is too light for white and is overridden.
    for (const id of ['mist', 'ember']) {
      const t = theme(id);
      expect(rgb(t, t['accent-fill'])).toEqual(rgb(t, t.accent));
      expect(rgb(t, t['accent-fill-hover'])).toEqual(rgb(t, t['accent-hover']));
    }
    expect(rgb(theme('ember'), 'var(--danger-fill)')).toEqual(rgb(theme('ember'), 'var(--red)'));
  });
});
