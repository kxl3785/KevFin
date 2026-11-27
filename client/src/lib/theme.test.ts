import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { THEMES, DEFAULT_THEME, THEME_KEY, RETIRED_THEMES, isThemeId, resolveTheme } from './theme.ts';

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

  // Runs index.html's pre-paint script against a stored value and returns the
  // data-theme it sets (null when it leaves the default).
  function prePaint(stored: string | null): string | null {
    const src = html.split('<script>').map(c => c.split('</script>')[0]).find(c => c.includes(THEME_KEY));
    if (!src) throw new Error('no pre-paint theme script');
    let set: string | null = null;
    const localStorage = { getItem: () => stored };
    const document = { documentElement: { setAttribute: (_: string, v: string) => { set = v; } } };
    new Function('localStorage', 'document', src)(localStorage, document);
    return set;
  }

  it('pre-paints a saved theme, maps retired Paper to Ember, and ignores unknown values', () => {
    expect(prePaint(JSON.stringify('mist'))).toBe('mist');
    expect(prePaint(JSON.stringify('ember'))).toBe('ember');
    expect(prePaint(JSON.stringify('paper'))).toBe('ember');
    expect(prePaint(JSON.stringify('midnight'))).toBeNull();
    expect(prePaint(JSON.stringify('slate'))).toBeNull();
    expect(prePaint('not json')).toBeNull();
    expect(prePaint(null)).toBeNull();
  });

  it('resolves a stored value to a theme: itself, its replacement, or the default', () => {
    expect(resolveTheme('mist')).toBe('mist');
    expect(resolveTheme('ember')).toBe('ember');
    expect(resolveTheme('paper')).toBe('ember');
    expect(resolveTheme('slate')).toBe(DEFAULT_THEME);
    expect(resolveTheme('toString')).toBe(DEFAULT_THEME); // not fooled by Object.prototype
    expect(resolveTheme(42)).toBe(DEFAULT_THEME);
    for (const to of Object.values(RETIRED_THEMES)) expect(isThemeId(to)).toBe(true);
    expect(isThemeId('paper')).toBe(false); // retired: no longer offered in the picker
  });

  it('validates theme ids', () => {
    expect(isThemeId('mist')).toBe(true);
    expect(isThemeId('slate')).toBe(false); // retired theme → falls back to the default
    expect(isThemeId('purple')).toBe(false);
    expect(isThemeId(null)).toBe(false);
  });
});
