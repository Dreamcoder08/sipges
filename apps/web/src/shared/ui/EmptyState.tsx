import type { ReactNode } from 'react';
import { Icon } from './Icon.tsx';
import type { IconName } from './icons.ts';
import styles from './EmptyState.module.css';

/** Friendly placeholder for a list with nothing to show, with an optional next step. */
export const EmptyState = ({
  title,
  icon,
  children,
  action,
}: {
  title: string;
  icon?: IconName;
  children?: ReactNode;
  action?: ReactNode;
}) => (
  <div className={styles.empty}>
    {icon ? (
      <span className={styles.icon}>
        <Icon name={icon} />
      </span>
    ) : null}
    <p className={styles.title}>{title}</p>
    {children ? <p className={styles.text}>{children}</p> : null}
    {action}
  </div>
);
