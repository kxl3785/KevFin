import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Dialogs and pop-ups take their backdrop and shadow from theme tokens
// (--scrim, --shadow-modal, --shadow-pop in index.css), because a black
// backdrop or shadow that is right on Midnight turns a light theme's page
// near-black behind a dialog and gives its cards a sooty halo. This keeps a new
// hard-coded black rgba(0,0,0,…) from creeping back into a component or rule.
const src = fileURLToPath(new URL('..', import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(tsx?|css)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

// Deliberate exceptions, matched by file and an exact snippet. Each is a 1–4px
// contact shadow under a small knob on a control, not a backdrop or a floating
// surface; a faint black edge there reads correctly on light and dark alike.
const ALLOWED: { file: string; contains: string; why: string }[] = [
  { file: 'components/Setup.tsx', contains: "boxShadow: '0 1px 2px rgba(0,0,0,0.3)'", why: 'switch knob' },
  { file: 'components/RiskQuestionnaire.tsx', contains: "boxShadow: '0 1px 4px rgba(0,0,0,0.5)'", why: 'risk meter thumb' },
];

const BLACK = /rgba\(\s*0\s*,\s*0\s*,\s*0\s*,/;
// The tokens' own Midnight values are the one place black belongs.
const TOKEN_DEF = /^\s*--(scrim|shadow-modal|shadow-pop):/;

describe('dialog and pop-up colours come from theme tokens', () => {
  it('no hard-coded black backdrop or shadow outside the allow-list', () => {
    const found: string[] = [];
    for (const f of files(src)) {
      const rel = relative(src, f).split('\\').join('/');
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (!BLACK.test(line) || TOKEN_DEF.test(line)) return;
        if (ALLOWED.some(a => a.file === rel && line.includes(a.contains))) return;
        found.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(found).toEqual([]);
  });

  it('every allow-listed exception still exists (drop it when it goes)', () => {
    for (const a of ALLOWED) {
      expect(readFileSync(join(src, a.file), 'utf8'), `${a.file} (${a.why})`).toContain(a.contains);
    }
  });

  it('each theme defines all three overlay tokens', () => {
    const css = readFileSync(join(src, 'index.css'), 'utf8');
    for (const sel of [':root', ':root[data-theme="mist"]', ':root[data-theme="ember"]']) {
      const body = css.split(`${sel} {`)[1]?.split('\n}')[0] ?? '';
      for (const t of ['--scrim', '--shadow-modal', '--shadow-pop']) {
        expect(body, `${sel} ${t}`).toMatch(new RegExp(`${t}:\\s*[^;]+;`));
      }
    }
  });
});
