import type { ModuleRecord } from '@sipges/contracts';
import { StatusBadge, type StatusTone } from '../../shared/ui/Badges.tsx';
import { fieldValue, isCompactField } from './model.ts';
import type { RecordField, RecordModule } from './modules.ts';
import styles from './Records.module.css';
import { formatPercent } from '../../shared/lib/format.ts';
import { DateText } from '../../shared/ui/DateText.tsx';
import { dimensionLabel, isDimension } from '../../shared/lib/text.ts';

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
const TONES: Readonly<Record<string, StatusTone>> = {
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
/** Fields that hold a SIPGES dimension; one stored as its letter alone is shown with its name. */
const DIMENSION_FIELDS = new Set(['Dimension_Principal', 'Dimension']);

/** «N» → «N · Narrativas» (functional-10 T14, F10); any other value is shown as stored. */
const dimensionText = (value: string) => {
  const code = value.trim().toUpperCase();
  return isDimension(code) ? dimensionLabel(code) : value;
};

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
        <span>{formatPercent(progress, 0)}</span>
      </span>
    );
  }
  const value = fieldValue(row, field);
  if (!value) return <>—</>;
  if (PILL_FIELDS.has(field.key))
    return <StatusBadge tone={TONES[value] ?? 'neutral'}>{value}</StatusBadge>;
  if (field.type === 'date') return <DateText value={value} />;
  if (DIMENSION_FIELDS.has(field.key)) return <>{dimensionText(value)}</>;
  return <>{value}</>;
};

export const isCompactCell = (module: RecordModule, field: RecordField) =>
  (module === 'demandas' && field.key === 'Avance') || isCompactField(field);
