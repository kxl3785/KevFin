import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Contrast floors for the theme tokens in index.css, read straight from the CSS
// so a later edit to a token can't quietly drop text below WCAG AA. Ember is held
// to the full set its palette was built to; Midnight and Mist to the pairs they
// already meet (a regression guard, not a redesign).
const css = readFileSync(fileURLToPath(new URL('../index.css', import.meta.url)), 'utf8');

function block(selector: string): Record<string, string> {
  const body = css.split(`${selector} {`)[1]?.split('\n}')[0];
  if (!body) throw new Error(`no ${selector} block in index.css`);
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}
const root = block(':root');
const theme = (id: string) => (id === 'midnight' ? root : { ...root, ...block(`:root[data-theme="${id}"]`) });

type Rgb = [number, number, number];
function rgb(tokens: Record<string, string>, value: string): Rgb {
  const v = value.match(/^var\(--([\w-]+)\)$/) ? tokens[value.slice(6, -1)] : value;
  let h = v.replace('#', '');
  if (h.length === 3) h = [...h].map(c => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(h)) throw new Error(`not a hex colour: ${value}`);
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)) as Rgb;
}
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
    return rgb(t, t[name]);
  };
  const misses = pairs
    .map(([fg, bg, min]) => ({ fg, bg, min, got: contrast(rgb(t, t[fg]), surface(bg)) }))
    .filter(p => p.got < p.min)
    .map(p => `${p.fg} on ${p.bg}: ${p.got.toFixed(2)} < ${p.min}`);
  expect(misses).toEqual([]);
}

const TEXT_ON = (fg: string, surfaces: string[], min = 4.5) => surfaces.map(s => [fg, s, min] as [string, string, number]);

describe('theme contrast', () => {
  it('Ember: body and muted text on every surface, semantics and accent as text, white on the accent', () => {
    const all = ['bg', 'surface', 'surface-2', 'accent-dim/card', 'accent-dim/bg'];
    check('ember', [
      ...TEXT_ON('text', all), ...TEXT_ON('muted', all),
      ...['accent', 'green', 'red', 'amber', 'imported', 'spend'].flatMap(k => TEXT_ON(k, ['bg', 'surface', 'surface-2'])),
      ['on-accent', 'accent', 4.5], ['on-accent', 'accent-hover', 4.5],
      // Chart lines and fills against the card and the ground.
      ...['cf-spend', 'accent-2', 'teal', 'scn-1', 'scn-2', 'scn-3', 'scn-4'].flatMap(k => TEXT_ON(k, ['bg', 'surface'], 3)),
    ]);
  });

  it('Mist keeps the pairs it meets today', () => {
    check('mist', [
      ...TEXT_ON('text', ['bg', 'surface', 'surface-2']), ...TEXT_ON('muted', ['bg', 'surface']),
      ...['accent', 'green', 'red', 'amber'].flatMap(k => TEXT_ON(k, ['surface'])),
      ['on-accent', 'accent', 4.5],
    ]);
  });

  it('Midnight keeps the pairs it meets today', () => {
    check('midnight', [
      ...TEXT_ON('text', ['bg', 'surface', 'surface-2']), ...TEXT_ON('muted', ['bg', 'surface', 'surface-2']),
      ...['accent', 'green', 'red', 'amber'].flatMap(k => TEXT_ON(k, ['bg', 'surface', 'surface-2'])),
    ]);
  });
});
