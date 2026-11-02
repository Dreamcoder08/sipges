import type { ModuleRecord } from '@sipges/contracts';
import { type TrendWindow, narrativeTrend } from '../lib/narrative-trend.ts';
import { BarList } from './BarList.tsx';
import { MultiLineChart } from './charts/Charts.tsx';
import styles from './NarrativeCharts.module.css';

const DAY = new Intl.DateTimeFormat('es-PE', { day: '2-digit', month: 'short', timeZone: 'UTC' });
const dayLabel = (day: string) => DAY.format(new Date(`${day}T12:00:00Z`)).replace('.', '');

/**
 * Narratives per day and category (one line per category) and their totals per category, from
 * the same model in Registros › Narrativas and Análisis. With fewer than two dated days the
 * trend cannot draw a line, so the totals per category take its place.
 */
export const NarrativeCharts = ({
  rows,
  window,
  compact = false,
}: {
  rows: readonly ModuleRecord[];
  window: TrendWindow;
  /** Shows the totals per category above the trend instead of only as its fallback. */
  compact?: boolean;
}) => {
  const trend = narrativeTrend(rows, window);
  const hasTrend = trend.datedDays >= 2;
  const categories = (
    <BarList
      empty="Aún no hay narrativas registradas."
      bars={trend.byCategory.map((c) => ({ key: c.code, label: c.label, value: c.value }))}
    />
  );
  const notes = [
    !hasTrend && rows.length
      ? 'La tendencia necesita narrativas con fecha en al menos dos días distintos; mientras tanto se muestra el total por categoría.'
      : '',
    trend.undated
      ? `${trend.undated} narrativa(s) sin fecha utilizable no se grafican en la tendencia.`
      : '',
    trend.fromUpdate
      ? `${trend.fromUpdate} narrativa(s) sin fecha propia se ubican en el día de su último cambio en SIPGES.`
      : '',
  ].filter(Boolean);
  return (
    <>
      {compact ? (
        <>
          <h4 className={styles.subhead}>Por categoría</h4>
          {categories}
          {hasTrend ? <h4 className={styles.subhead}>Por día</h4> : null}
        </>
      ) : null}
      {hasTrend ? (
        <MultiLineChart
          caption="Narrativas registradas por día y categoría"
          empty="Aún no hay narrativas con fecha para mostrar una tendencia."
          yTitle="N° de menciones"
          labels={trend.days.map(dayLabel)}
          series={trend.series.map((s) => ({
            key: s.code,
            label: s.label,
            tone: `trend${s.code}`,
            values: s.values,
          }))}
        />
      ) : compact ? null : (
        categories
      )}
      <p className={styles.note}>
        Cada narrativa cuenta como una mención el día de su publicación; si falta, el de su
        observación o su fecha de registro. La categoría sale del campo «Categoría»; si está vacío,
        se deduce del tema y la descripción.
        {notes.map((note) => ` ${note}`).join('')}
      </p>
    </>
  );
};
