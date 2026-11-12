import { StatusBadge, type StatusTone } from '../../../shared/ui/Badges.tsx';
import styles from './Hub.module.css';
import type { VerificationLetter } from './summary.ts';

/** A = most confident, E = least; the letter always carries the meaning, colour only helps. */
export const VerificationChip = ({ letter }: { letter: VerificationLetter | null }) =>
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

const VALIDATION_TONES: Readonly<Record<string, StatusTone>> = {
  Validado: 'positive',
  'En revisión': 'warning',
};

/** The status text is the meaning; the tone only helps. Unknown wordings stay neutral. */
export const ValidationChip = ({ state }: { state: string }) =>
  state ? (
    <StatusBadge tone={VALIDATION_TONES[state]}>{state}</StatusBadge>
  ) : (
    <span className={styles.muted}>—</span>
  );
