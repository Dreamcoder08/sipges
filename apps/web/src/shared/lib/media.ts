import { useSyncExternalStore } from 'react';

/** Phones and tablets get the bottom bar and sheets (docs/adr/0015); matches AppShell.module.css. */
export const COMPACT_QUERY = '(max-width: 60rem)';

/**
 * Whether a media query matches, kept in sync with the viewport. Without `matchMedia` (jsdom,
 * very old browsers) it reports false, so the desktop layout renders.
 */
export const useMediaQuery = (query: string): boolean =>
  useSyncExternalStore(
    (notify) => {
      const list = window.matchMedia?.(query);
      list?.addEventListener('change', notify);
      return () => list?.removeEventListener('change', notify);
    },
    () => window.matchMedia?.(query).matches ?? false,
    () => false,
  );
