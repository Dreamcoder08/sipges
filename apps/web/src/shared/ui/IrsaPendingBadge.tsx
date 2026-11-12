import styles from './IrsaPendingBadge.module.css';

/** IRSA configuration status while the weights and thresholds lack expert validation. */
export const IRSA_PENDING_STATUS = 'PENDIENTE_DE_VALIDACION_METODOLOGICA';

/** The one text every IRSA reading shows while that status holds (irsa-insufficient-data S3). */
export const IRSA_PENDING_LABEL = 'Metodología pendiente de validación';

export const isIrsaPending = (status: string | undefined) => status === IRSA_PENDING_STATUS;

/** Neutral badge next to the IRSA value; nothing once the methodology is validated. */
export const IrsaPendingBadge = ({ status }: { status: string | undefined }) =>
  isIrsaPending(status) ? <span className={styles.pending}>{IRSA_PENDING_LABEL}</span> : null;
