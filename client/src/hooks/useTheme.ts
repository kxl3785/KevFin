import { useEffect } from 'react';
import { usePersistentState } from './usePersistentState.ts';
import { applyTheme, isThemeId, DEFAULT_THEME, THEME_KEY, type ThemeId } from '../lib/theme.ts';

// The selected colour theme, persisted like every other preference (localStorage
// for instant reads + the server as source of truth). Mounted once in App so the
// <html> attribute follows the setting; the Setup picker binds the same key and
// stays in sync through usePersistentState's shared broadcast.
export function useTheme(): [ThemeId, (id: ThemeId) => void] {
  const [stored, setStored] = usePersistentState<string>(THEME_KEY, DEFAULT_THEME);
  // A stored value from a newer/older build that names an unknown theme falls
  // back to the default instead of leaving the page half-styled.
  const theme = isThemeId(stored) ? stored : DEFAULT_THEME;
  useEffect(() => { applyTheme(theme); }, [theme]);
  return [theme, setStored];
}
