import type { ReactNode } from 'react';
import styles from './Alert.module.css';

/** Inline message; errors are announced immediately, other tones politely. */
export const Alert = ({
  tone,
  children,
}: {
  tone: 'error' | 'info' | 'success';
  children: ReactNode;
}) => (
  <div className={`${styles.alert} ${styles[tone]}`} role={tone === 'error' ? 'alert' : 'status'}>
    {children}
  </div>
);
