import { useEffect } from 'react';
import { usePersistentState } from './usePersistentState.ts';
import { applyTheme, resolveTheme, DEFAULT_THEME, THEME_KEY, type ThemeId } from '../lib/theme.ts';

// The selected colour theme, persisted like every other preference (localStorage
// for instant reads + the server as source of truth). Mounted once in App so the
// <html> attribute follows the setting; the Setup picker binds the same key and
// stays in sync through usePersistentState's shared broadcast.
export function useTheme(): [ThemeId, (id: ThemeId) => void] {
  const [stored, setStored] = usePersistentState<string>(THEME_KEY, DEFAULT_THEME);
  // A retired theme ("paper") opens as the one that replaced it; a value from a
  // newer/older build that names an unknown theme falls back to the default
  // instead of leaving the page half-styled. The stored value is left as it is
  // here: rewriting it before the server's copy has loaded would mark the hook
  // dirty and overwrite a theme picked on another device. The server rewrites
  // "paper" itself (db migration 8), and the next hydration brings that down.
  const theme = resolveTheme(stored);
  useEffect(() => { applyTheme(theme); }, [theme]);
  return [theme, setStored];
}
