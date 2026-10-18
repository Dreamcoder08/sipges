import type { ReactNode } from 'react';
import styles from './ChipRow.module.css';

/**
 * A row of filter or view toggles. It wraps on wide screens and becomes one swipeable line on
 * phones, so three long labels never stack into a wall of buttons.
 */
export const ChipRow = ({ label, children }: { label: string; children: ReactNode }) => (
  <div role="group" aria-label={label} className={styles.row}>
    {children}
  </div>
);
