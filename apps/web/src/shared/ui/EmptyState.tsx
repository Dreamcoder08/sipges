import type { ReactNode } from 'react';
import styles from './EmptyState.module.css';

/** Friendly placeholder for a list with nothing to show, with an optional next step. */
export const EmptyState = ({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) => (
  <div className={styles.empty}>
    <p className={styles.title}>{title}</p>
    {children ? <p className={styles.text}>{children}</p> : null}
    {action}
  </div>
);
