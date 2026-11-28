// Colour themes (Setup → Appearance). The tokens themselves live in index.css
// under :root[data-theme="…"]; this module only names the themes, applies one to
// <html>, and carries a few preview colours for the picker. "midnight" is the
// original look and is the bare :root, so it removes the attribute.

export type ThemeId = 'midnight' | 'mist' | 'ember';

export interface ThemeInfo {
  id: ThemeId;
  label: string;
  hint: string;
  // Picker preview only — keep in sync with the --bg / --surface / --accent /
  // --accent-2 values in index.css. The swatch has to show a theme's colours
  // while a *different* theme is active, so it can't read the live tokens.
  preview: { bg: string; surface: string; accent: string; accent2: string };
}

export const THEMES: ThemeInfo[] = [
  { id: 'midnight', label: 'Midnight', hint: 'Original dark blue',
    preview: { bg: '#0f1117', surface: '#1a1d27', accent: '#6c8fff', accent2: '#a78bfa' } },
  { id: 'mist', label: 'Mist', hint: 'Cool light gray with cyan',
    preview: { bg: '#eef2f6', surface: '#ffffff', accent: '#0e728e', accent2: '#2563eb' } },
  { id: 'ember', label: 'Ember', hint: 'Warm cream with burnt orange',
    preview: { bg: '#fbf6ea', surface: '#ffffff', accent: '#b93d0b', accent2: '#2563eb' } },
];

export const DEFAULT_THEME: ThemeId = 'midnight';

// Retired theme ids and the theme that took each one's place. A saved value is
// mapped on every read (here, and in index.html's pre-paint script), so a
// device or a restored backup that still says "paper" opens in Ember. The
// server also rewrites the stored preference once (db migration 8).
export const RETIRED_THEMES: Readonly<Record<string, ThemeId>> = { paper: 'ember' };

// Persisted under the same `mon.` prefix as the other UI preferences, so it
// travels with backups and syncs across browsers via the server prefs store.
// index.html reads this key before first paint — keep the two in step.
export const THEME_KEY = 'mon.theme';

export function isThemeId(v: unknown): v is ThemeId {
  return THEMES.some(t => t.id === v);
}

// The theme a stored value stands for: itself, its replacement if it was
// retired, or the default for anything unknown (a newer build's theme, junk).
export function resolveTheme(v: unknown): ThemeId {
  if (isThemeId(v)) return v;
  if (typeof v === 'string' && Object.prototype.hasOwnProperty.call(RETIRED_THEMES, v)) return RETIRED_THEMES[v];
  return DEFAULT_THEME;
}

export function applyTheme(id: ThemeId) {
  const root = document.documentElement;
  if (id === DEFAULT_THEME) root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', id);
}
