import { type ReactNode, useId } from 'react';
import styles from './NotFoundNotice.module.css';

/**
 * What a missing page or record shows (functional-10 T6): a heading that says what was not
 * found, one sentence, and a way back. The heading is the page's h1 outside the app shell and an
 * h2 under the shell's own h1.
 */
export const NotFoundNotice = ({
  title,
  level = 2,
  children,
  action,
}: {
  title: string;
  level?: 1 | 2;
  children: ReactNode;
  action: ReactNode;
}) => {
  const heading = useId();
  const Heading = level === 1 ? 'h1' : 'h2';
  return (
    <section className={styles.notice} aria-labelledby={heading}>
      <Heading id={heading} className={styles.title}>
        {title}
      </Heading>
      <p className={styles.text}>{children}</p>
      <p className={styles.action}>{action}</p>
    </section>
  );
};
