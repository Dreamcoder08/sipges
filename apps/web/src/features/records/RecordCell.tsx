import type { ModuleRecord } from '@sipges/contracts';
import { fieldValue, isCompactField } from './model.ts';
import type { RecordField, RecordModule } from './modules.ts';
import styles from './Records.module.css';

type Tone = 'negative' | 'warning' | 'info' | 'positive' | 'neutral';

/**
 * A request's progress is derived from its status, never stored, so it cannot drift from it.
 * Unknown statuses (imported values outside the list) have no progress.
 */
const DEMAND_PROGRESS: Readonly<Record<string, number>> = {
  Nueva: 0,
  'En revisión': 25,
  'En diálogo': 50,
  Atendida: 75,
  Cerrada: 100,
};
export const demandProgress = (status: string): number | undefined => DEMAND_PROGRESS[status];

/** Colour of a priority or status pill; the text always carries the meaning. */
const TONES: Readonly<Record<string, Tone>> = {
  Crítica: 'negative',
  Alta: 'warning',
  Media: 'info',
  Baja: 'neutral',
  Nueva: 'info',
  'En revisión': 'warning',
  'En diálogo': 'info',
  Atendida: 'positive',
  Cerrada: 'neutral',
  Pendiente: 'neutral',
  'En proceso': 'info',
  Cumplido: 'positive',
  Incumplido: 'negative',
};
const PILL_FIELDS = new Set(['Prioridad', 'Estado']);

type Props = { module: RecordModule; row: ModuleRecord; field: RecordField };

/** One table cell: progress bars and pills where the tracking view needs them, text elsewhere. */
export const RecordCell = ({ module, row, field }: Props) => {
  if (module === 'demandas' && field.key === 'Avance') {
    const progress = demandProgress(fieldValue(row, { key: 'Estado', label: 'Estado' }));
    if (progress == null) return <>—</>;
    return (
      <span className={styles.progress}>
        <span
          role="progressbar"
          aria-label={field.label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
          className={styles.progressTrack}
        >
          <span className={styles.progressFill} style={{ width: `${progress}%` }} />
        </span>
        <span>{progress}%</span>
      </span>
    );
  }
  const value = fieldValue(row, field);
  if (!value) return <>—</>;
  if (PILL_FIELDS.has(field.key))
    return (
      <span className={styles.pill} data-tone={TONES[value] ?? 'neutral'}>
        {value}
      </span>
    );
  return <>{value}</>;
};

export const isCompactCell = (module: RecordModule, field: RecordField) =>
  (module === 'demandas' && field.key === 'Avance') || isCompactField(field);
