import styles from './Skeleton.module.css';

/**
 * Placeholder lines shaped like the content that is loading, so the layout does not jump when
 * it arrives. Decorative: the caller announces the loading state in words.
 */
export const Skeleton = ({ lines = 3 }: { lines?: number }) => (
  <span className={styles.stack} aria-hidden="true">
    {Array.from({ length: lines }, (_, index) => (
      <span key={index} className={styles.line} />
    ))}
  </span>
);
