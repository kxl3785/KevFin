// Colour themes (Setup → Appearance). The tokens themselves live in index.css
// under :root[data-theme="…"]; this module only names the themes, applies one to
// <html>, and carries a few preview colours for the picker. "midnight" is the
// original look and is the bare :root, so it removes the attribute.

export type ThemeId = 'midnight' | 'mist' | 'paper';

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
    preview: { bg: '#eef2f6', surface: '#ffffff', accent: '#0e7490', accent2: '#2563eb' } },
  { id: 'paper', label: 'Paper', hint: 'Light with ink blue',
    preview: { bg: '#f6f4ef', surface: '#ffffff', accent: '#2c5aa0', accent2: '#c08a2e' } },
];

export const DEFAULT_THEME: ThemeId = 'midnight';

// Persisted under the same `mon.` prefix as the other UI preferences, so it
// travels with backups and syncs across browsers via the server prefs store.
// index.html reads this key before first paint — keep the two in step.
export const THEME_KEY = 'mon.theme';

export function isThemeId(v: unknown): v is ThemeId {
  return THEMES.some(t => t.id === v);
}

export function applyTheme(id: ThemeId) {
  const root = document.documentElement;
  if (id === DEFAULT_THEME) root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', id);
}
