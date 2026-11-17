import type { ReactNode } from 'react';
import styles from './Alert.module.css';

/**
 * Inline message; errors are announced immediately, other tones politely. `announce={false}` drops
 * the live role where a container already reads it out (the analyst's conversation log).
 */
export const Alert = ({
  tone,
  announce = true,
  children,
}: {
  tone: 'error' | 'warning' | 'info' | 'success';
  announce?: boolean;
  children: ReactNode;
}) => (
  <div
    className={`${styles.alert} ${styles[tone]}`}
    role={announce ? (tone === 'error' ? 'alert' : 'status') : undefined}
  >
    {children}
  </div>
);
