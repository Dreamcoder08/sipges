import { type ComponentProps, type RefObject, useRef } from 'react';
import { useScrollHints } from '../lib/scroll-hints.ts';
import styles from './ScrollCues.module.css';

/**
 * A sideways scroller that shadows an edge while more content lies that way (functional-10 T14:
 * the alert heat map and the actor map on phones scrolled with no sign that they did). The hook
 * lives here, so it observes the scroller from the moment it mounts, also when it appears after
 * its data loads. `ref` lets the owner reach the scroller too (the actor map centres it).
 */
export const ScrollCues = ({
  className,
  children,
  ref,
  ...rest
}: Omit<ComponentProps<'div'>, 'ref'> & { ref?: RefObject<HTMLDivElement | null> }) => {
  const own = useRef<HTMLDivElement>(null);
  const scroller = ref ?? own;
  useScrollHints(scroller, { always: true });
  return (
    <div {...rest} ref={scroller} className={`${styles.cues} ${className ?? ''}`}>
      <span className={styles.edge} aria-hidden="true" />
      {children}
      <span className={styles.edge} aria-hidden="true" />
    </div>
  );
};
