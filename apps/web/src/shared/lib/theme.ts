import { useSyncExternalStore } from 'react';

/**
 * Appearance preference (docs/adr/0018). «system» leaves the theme to prefers-color-scheme in
 * tokens.css; «light» and «dark» pin it through data-theme on <html>. The choice is a
 * per-device convenience in localStorage, so it never reaches the server.
 */
export type ThemePreference = 'system' | 'light' | 'dark';

export const THEME_OPTIONS: readonly { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'Sistema' },
  { value: 'light', label: 'Claro' },
  { value: 'dark', label: 'Oscuro' },
];

const KEY = 'mascli.theme';
const CHROME = { light: '#ffffff', dark: '#12171e' } as const;
const listeners = new Set<() => void>();

const isPreference = (value: unknown): value is ThemePreference =>
  value === 'system' || value === 'light' || value === 'dark';

export const readTheme = (): ThemePreference => {
  try {
    const stored = window.localStorage.getItem(KEY);
    return isPreference(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
};

/**
 * Mirrors the preference on <html> and in the browser chrome colour. index.html carries one
 * theme-color per colour scheme; a pinned theme gives both the same colour.
 */
export const applyTheme = (preference: ThemePreference = readTheme()) => {
  const root = document.documentElement;
  if (preference === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', preference);
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const scheme = meta.media.includes('dark') ? 'dark' : 'light';
    meta.content = CHROME[preference === 'system' ? scheme : preference];
  }
};

export const setTheme = (preference: ThemePreference) => {
  try {
    if (preference === 'system') window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, preference);
  } catch {
    // Private mode or blocked storage: the choice still applies to this page.
  }
  applyTheme(preference);
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useThemePreference = () => useSyncExternalStore(subscribe, readTheme, readTheme);
