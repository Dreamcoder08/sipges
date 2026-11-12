import { Icon } from './Icon.tsx';
import styles from './IrsaPendingBadge.module.css';

/** IRSA configuration status while the weights and thresholds lack expert validation. */
export const IRSA_PENDING_STATUS = 'PENDIENTE_DE_VALIDACION_METODOLOGICA';

/** The one text every IRSA reading shows while that status holds (irsa-insufficient-data S3). */
export const IRSA_PENDING_LABEL = 'Metodología pendiente de validación';

export const isIrsaPending = (status: string | undefined) => status === IRSA_PENDING_STATUS;

/**
 * The one caveat next to the IRSA value, in the warning tone with a dashed edge so it reads as
 * provisional rather than as a status; nothing once the methodology is validated.
 */
export const IrsaPendingBadge = ({ status }: { status: string | undefined }) =>
  isIrsaPending(status) ? (
    <span className={styles.pending}>
      <Icon name="alert" />
      {IRSA_PENDING_LABEL}
    </span>
  ) : null;
