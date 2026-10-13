import type { ReactNode } from 'react';
import styles from './BarList.module.css';

export type Bar = { key: string; label: ReactNode; value: number; tone?: string };

/**
 * Horizontal bars as a description list; the numbers stay in the text, the bar is decoration.
 * Widths are set through React's style prop (CSSOM), which the strict CSP allows.
 */
export const BarList = ({ bars, empty }: { bars: readonly Bar[]; empty: string }) => {
  if (!bars.length) return <p className={styles.empty}>{empty}</p>;
  const max = Math.max(1, ...bars.map((b) => b.value));
  return (
    <dl className={styles.list}>
      {bars.map((bar) => (
        <div key={bar.key} className={styles.row}>
          <dt>{bar.label}</dt>
          <dd>
            <span className={styles.track} aria-hidden="true">
              <span
                className={`${styles.fill} ${bar.tone ? (styles[bar.tone] ?? '') : ''}`}
                style={{ width: `${(bar.value / max) * 100}%` }}
              />
            </span>
            <b>{bar.value}</b>
          </dd>
        </div>
      ))}
    </dl>
  );
};
