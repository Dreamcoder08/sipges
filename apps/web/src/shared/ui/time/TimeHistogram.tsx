import type { KeyboardEvent, MouseEvent } from 'react';
import { monthLabel } from '../../lib/text.ts';
import styles from './TimeHistogram.module.css';

export type MonthCount = { readonly month: string; readonly count: number };

const WIDTH = 100;
const HEIGHT = 32;

/**
 * Records per month as clickable bars. A click selects that month; Shift+click extends the
 * selection from the current range; clicking the only selected month clears the range.
 */
export const TimeHistogram = ({
  series,
  from,
  to,
  onChange,
  label,
}: {
  series: readonly MonthCount[];
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
  label: string;
}) => {
  if (!series.length) return null;
  const max = Math.max(1, ...series.map((s) => s.count));
  const slot = WIDTH / series.length;
  const selected = (month: string) =>
    Boolean(from || to) && (!from || month >= from) && (!to || month <= to);
  const choose = (month: string, extend: boolean) => {
    if (extend && (from || to)) {
      const anchor = from || to;
      onChange(month < anchor ? month : anchor, month < anchor ? to || anchor : month);
    } else if (from === month && to === month) onChange('', '');
    else onChange(month, month);
  };
  return (
    <figure className={styles.figure}>
      <svg
        className={styles.chart}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        role="group"
        aria-label={label}
      >
        {series.map(({ month, count }, index) => {
          const height = count ? Math.max(1.5, (count / max) * (HEIGHT - 2)) : 0.6;
          const pressed = selected(month);
          return (
            <g
              key={month}
              role="button"
              tabIndex={0}
              aria-label={`${monthLabel(month)}: ${count} registro${count === 1 ? '' : 's'}`}
              aria-pressed={pressed}
              className={pressed ? `${styles.bar} ${styles.selected}` : styles.bar}
              onClick={(event: MouseEvent) => choose(month, event.shiftKey)}
              onKeyDown={(event: KeyboardEvent) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  choose(month, event.shiftKey);
                }
              }}
            >
              <rect x={index * slot} y={0} width={slot} height={HEIGHT} className={styles.hit} />
              <rect
                x={index * slot + slot * 0.12}
                y={HEIGHT - height}
                width={slot * 0.76}
                height={height}
              />
            </g>
          );
        })}
      </svg>
      <figcaption className={styles.axis}>
        <span>{monthLabel(series[0]?.month ?? '')}</span>
        <span>{monthLabel(series.at(-1)?.month ?? '')}</span>
      </figcaption>
    </figure>
  );
};
