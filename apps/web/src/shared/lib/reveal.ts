import { useEffect, useRef } from 'react';

/**
 * Brings a detail panel into view when `key` selects something: scrolls its heading to the top
 * and focuses it. Detail panels below long tables were otherwise opened off-screen, so on a
 * phone «Ver …» looked like it did nothing (functional audit error 03). The heading needs
 * `tabIndex={-1}`.
 */
export const useReveal = <T extends HTMLElement = HTMLHeadingElement>(key: string) => {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!key) return;
    ref.current?.focus();
    ref.current?.scrollIntoView?.({ block: 'start' });
  }, [key]);
  return ref;
};
