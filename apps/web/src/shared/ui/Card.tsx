import type { ReactNode } from 'react';
import styles from './Card.module.css';

/** Titled panel; the eyebrow is a short uppercase label above the heading. */
export const Card = ({
  eyebrow,
  title,
  action,
  children,
}: {
  eyebrow?: string;
  title?: string;
  action?: ReactNode;
  children: ReactNode;
}) => (
  <section className={styles.card}>
    {eyebrow || title || action ? (
      <header className={styles.header}>
        <div>
          {eyebrow ? <p className={styles.eyebrow}>{eyebrow}</p> : null}
          {title ? <h3 className={styles.title}>{title}</h3> : null}
        </div>
        {action}
      </header>
    ) : null}
    {children}
  </section>
);
