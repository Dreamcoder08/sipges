import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '../../shared/ui/Button.tsx';
import { Card } from '../../shared/ui/Card.tsx';
import { MultiLineChart } from '../../shared/ui/charts/Charts.tsx';
import { QueryState } from '../../shared/ui/QueryState.tsx';
import { recordsQuery } from './api.ts';
import { type TrendWindow, narrativeTrend } from './narrative-trend.ts';
import styles from './Records.module.css';

const WINDOWS: readonly [TrendWindow, string][] = [
  [30, '30 días'],
  [90, '90 días'],
  ['todo', 'Todo'],
];

const DAY = new Intl.DateTimeFormat('es-PE', { day: '2-digit', month: 'short', timeZone: 'UTC' });
const dayLabel = (day: string) => DAY.format(new Date(`${day}T12:00:00Z`)).replace('.', '');

/** Narratives of the active project per day and category (line per category). */
export const NarrativeTrend = ({ scope }: { scope: string }) => {
  const [period, setPeriod] = useState<TrendWindow>(30);
  // Same key as the unfiltered list below, so the records are fetched once.
  const rows = useQuery(recordsQuery('narrativas', scope, ''));
  return (
    <Card
      eyebrow="Tendencia"
      title="Tendencia temporal de narrativas"
      action={
        <div className={styles.actions} role="group" aria-label="Periodo del gráfico">
          {WINDOWS.map(([value, label]) => (
            <Button
              key={String(value)}
              variant={period === value ? 'primary' : 'secondary'}
              aria-pressed={period === value}
              onClick={() => setPeriod(value)}
            >
              {label}
            </Button>
          ))}
        </div>
      }
    >
      <QueryState query={rows} label="la tendencia de narrativas">
        {(data) => {
          const trend = narrativeTrend(data, period);
          return (
            <>
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
              <p className={styles.muted}>
                Cada narrativa cuenta como una mención el día de su publicación (o de su
                observación). La categoría sale del campo «Categoría»; si está vacío, se deduce del
                tema y la descripción.
                {trend.undated ? ` ${trend.undated} narrativa(s) sin fecha no se grafican.` : ''}
              </p>
            </>
          );
        }}
      </QueryState>
    </Card>
  );
};
