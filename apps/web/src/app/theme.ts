/**
 * Theme preference: follow the OS (default) or force light/dark. Colors come from CSS tokens
 * written with light-dark(), so switching only sets color-scheme via data-theme on <html>.
 */
import { useSyncExternalStore } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';

const KEY = 'scope.theme';
const listeners = new Set<() => void>();

function read(): ThemePreference {
  try {
    const value = window.localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(preference: ThemePreference = read()): void {
  const root = document.documentElement;
  if (preference === 'system') delete root.dataset.theme;
  else root.dataset.theme = preference;
}

export function setTheme(preference: ThemePreference): void {
  try {
    if (preference === 'system') window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, preference);
  } catch {
    // storage unavailable (private mode): the choice lasts for this page only
  }
  applyTheme(preference);
  for (const listener of listeners) listener();
}

export function useTheme(): ThemePreference {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    read,
    () => 'system',
  );
}
