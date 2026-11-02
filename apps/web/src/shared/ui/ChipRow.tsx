import { type ReactNode, useEffect, useLayoutEffect, useRef } from 'react';
import styles from './ChipRow.module.css';

/** Scrolls `row` so `chip` starts at its left edge, unless the chip is already fully visible. */
const reveal = (row: HTMLElement, chip: Element) => {
  const box = row.getBoundingClientRect();
  const rect = chip.getBoundingClientRect();
  if (rect.left >= box.left && rect.right <= box.right) return;
  row.scrollLeft += rect.left - box.left;
};

/**
 * A row of filter or view toggles. It wraps on wide screens and becomes one swipeable line on
 * phones, so three long labels never stack into a wall of buttons. When the chosen chip
 * (`aria-pressed="true"`) changes and lies outside the row, the row scrolls it to its start, so a
 * tab opened from a link is not left cut off at the right edge.
 */
export const ChipRow = ({ label, children }: { label: string; children: ReactNode }) => {
  const row = useRef<HTMLDivElement>(null);
  const shown = useRef<Element | null>(null);
  useLayoutEffect(() => {
    const element = row.current;
    const pressed = element?.querySelector(':scope > [aria-pressed="true"]');
    // Only a newly chosen chip moves the row: never fight a person swiping through it.
    if (!element || !pressed || pressed === shown.current) return;
    shown.current = pressed;
    reveal(element, pressed);
  });
  useEffect(() => {
    const element = row.current;
    if (!element || typeof ResizeObserver !== 'function') return;
    // Counts that arrive later widen the chips before the chosen one; a swipe never resizes.
    const observer = new ResizeObserver(() => {
      if (shown.current) reveal(element, shown.current);
    });
    for (const chip of element.children) observer.observe(chip);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={row} role="group" aria-label={label} className={styles.row}>
      {children}
    </div>
  );
};
