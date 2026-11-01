import styles from './Hub.module.css';
import type { VerificationLetter } from './summary.ts';

/** A = most confident, E = least; the letter always carries the meaning, colour only helps. */
export const VerificationChip = ({ letter }: { letter: VerificationLetter | undefined }) =>
  letter ? (
    <span
      className={styles.ver}
      data-verification={letter}
      title="Verificación: A = mayor confianza, E = menor"
    >
      {letter}
    </span>
  ) : (
    <span className={styles.muted}>—</span>
  );
