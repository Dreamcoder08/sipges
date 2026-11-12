import { useSyncExternalStore } from 'react';
import { useMediaQuery } from '../../../shared/lib/media.ts';

/** From 1024 px the record sheet docks beside the list; below it stays a modal sheet. */
const DOCK_QUERY = '(min-width: 64rem)';

const query = () =>
  typeof window.matchMedia === 'function' ? window.matchMedia(DOCK_QUERY) : null;

const subscribe = (notify: () => void) => {
  const media = query();
  media?.addEventListener('change', notify);
  return () => media?.removeEventListener('change', notify);
};

export const useDocked = () =>
  useSyncExternalStore(
    subscribe,
    () => query()?.matches ?? false,
    () => false,
  );

/**
 * Below 1024 px the type tabs list two-line rows instead of their table, like Todos. Unlike
 * `useDocked`, an unknown width (no `matchMedia`) keeps the table with its row actions.
 */
export const useTypeRows = () => useMediaQuery('(width < 64rem)');
