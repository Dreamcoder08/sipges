import { useSyncExternalStore } from 'react';

const subscribe = (onChange: () => void) => {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
};

/**
 * Whether the browser believes it has a network (`navigator.onLine`), kept current by the
 * `online` and `offline` events. `true` only means a network exists, not that the API answers.
 */
export const useOnline = () =>
  useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );
