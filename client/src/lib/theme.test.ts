import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { THEMES, DEFAULT_THEME, THEME_KEY, isThemeId } from './theme.ts';

// The theme list is written down in three places — this module, the token blocks
// in index.css, and the pre-paint script in index.html. These checks keep them in
// step so a new theme can't ship half-wired (picker shows it, page ignores it).
const css = readFileSync(fileURLToPath(new URL('../index.css', import.meta.url)), 'utf8');
const html = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8');

describe('themes', () => {
  const others = THEMES.filter(t => t.id !== DEFAULT_THEME);

  it('defines a token block in index.css for every non-default theme', () => {
    for (const t of others) expect(css).toContain(`:root[data-theme="${t.id}"]`);
  });

  it('lets the pre-paint script in index.html apply every non-default theme', () => {
    expect(html).toContain(`localStorage.getItem('${THEME_KEY}')`);
    for (const t of others) expect(html).toContain(`'${t.id}'`);
  });

  it('keeps the picker preview in sync with each theme\'s --accent token', () => {
    for (const t of others) {
      const block = css.split(`:root[data-theme="${t.id}"]`)[1].split('}')[0];
      expect(block).toContain(`--accent: ${t.preview.accent};`);
    }
  });

  it('validates theme ids', () => {
    expect(isThemeId('slate')).toBe(true);
    expect(isThemeId('purple')).toBe(false);
    expect(isThemeId(null)).toBe(false);
  });
});
