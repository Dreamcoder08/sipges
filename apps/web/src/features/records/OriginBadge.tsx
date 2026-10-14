import { recordOrigin } from '@mascli/contracts';
import styles from './Records.module.css';

/** Marks synthetic demo records; real records carry no badge. */
export const OriginBadge = ({ record }: { record: Readonly<Record<string, unknown>> }) =>
  recordOrigin(record) === 'demo' ? (
    <span className={styles.demoBadge} title="Dato sintético del caso académico">
      Demostración
    </span>
  ) : null;
