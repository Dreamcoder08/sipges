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

const KEY = 'sipges.theme';
const CHROME = { light: '#ffffff', dark: '#000000' } as const;
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

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** The theme on screen now: the picked one, else the device's. */
export const resolvedTheme = (): 'light' | 'dark' => {
  const picked = readTheme();
  if (picked !== 'system') return picked;
  return typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches
    ? 'dark'
    : 'light';
};

const subscribeResolved = (listener: () => void) => {
  const media = typeof window.matchMedia === 'function' ? window.matchMedia(DARK_QUERY) : null;
  media?.addEventListener('change', listener);
  const stop = subscribe(listener);
  return () => {
    media?.removeEventListener('change', listener);
    stop();
  };
};

/** For paint that CSS cannot reach (WebGL maps): re-renders when the theme on screen changes. */
export const useResolvedTheme = () =>
  useSyncExternalStore(subscribeResolved, resolvedTheme, () => 'light' as const);
