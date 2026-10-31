import { useLevelLabel } from '../lib/project-settings.tsx';
import { DIMENSION_NAMES, type DimensionCode, LEVELS, type Level } from '../lib/text.ts';
import styles from './Badges.module.css';

export const DimensionBadge = ({ code }: { code: DimensionCode }) => (
  <abbr className={`${styles.dimension} ${styles[code]}`} title={DIMENSION_NAMES[code]}>
    {code}
  </abbr>
);

const LEVEL_CLASS: Readonly<Record<string, string | undefined>> = {
  Verde: styles.green,
  Amarillo: styles.yellow,
  Naranja: styles.orange,
  Rojo: styles.red,
};

const isLevel = (value: string): value is Level => (LEVELS as readonly string[]).includes(value);

/** The colour and, once the project settings load, its meaning (docs/adr/0020). */
export const LevelPill = ({ level }: { level: string }) => {
  const label = useLevelLabel();
  return (
    <span className={`${styles.level} ${LEVEL_CLASS[level] ?? ''}`}>
      {isLevel(level) ? label(level, level) : level}
    </span>
  );
};
