import { EVIDENCE_HINTS, EVIDENCE_LABELS, type Evidence } from './evidence.ts';
import styles from './TerritorialMap.module.css';

/** Observado / Estimado / Escenario hipotético, with the same marks as the map. */
export const EvidenceTag = ({ state }: { state: Evidence }) => (
  <span
    className={`${styles.evidence} ${styles[`ev_${state}`] ?? ''}`}
    title={EVIDENCE_HINTS[state]}
  >
    <span className={styles.evidenceMark} aria-hidden="true" />
    {EVIDENCE_LABELS[state]}
  </span>
);
