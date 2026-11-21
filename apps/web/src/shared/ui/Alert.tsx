import type { ReactNode, Ref } from 'react';
import styles from './Alert.module.css';

/**
 * Inline message; errors are announced immediately, other tones politely. `announce={false}` drops
 * the live role where a container already reads it out (the analyst's conversation log). `ref`
 * lets a form move focus to the message after a failed submit; the alert is then focusable.
 */
export const Alert = ({
  tone,
  announce = true,
  ref,
  children,
}: {
  tone: 'error' | 'warning' | 'info' | 'success';
  announce?: boolean;
  ref?: Ref<HTMLDivElement> | undefined;
  children: ReactNode;
}) => (
  <div
    ref={ref}
    {...(ref ? { tabIndex: -1 } : {})}
    className={`${styles.alert} ${styles[tone]}`}
    role={announce ? (tone === 'error' ? 'alert' : 'status') : undefined}
  >
    {children}
  </div>
);
