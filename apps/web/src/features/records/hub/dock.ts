import { useSyncExternalStore } from 'react';

/** From 1280 px the record sheet docks beside the list; below it stays a modal sheet. */
const DOCK_QUERY = '(min-width: 80rem)';

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
