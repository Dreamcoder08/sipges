import { DIMENSION_NAMES, type DimensionCode } from '../lib/text.ts';
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

export const LevelPill = ({ level }: { level: string }) => (
  <span className={`${styles.level} ${LEVEL_CLASS[level] ?? ''}`}>{level}</span>
);
