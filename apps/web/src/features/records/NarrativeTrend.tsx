import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '../../shared/ui/Button.tsx';
import { Card } from '../../shared/ui/Card.tsx';
import { QueryState } from '../../shared/ui/QueryState.tsx';
import { recordsQuery } from './api.ts';
import type { TrendWindow } from '../../shared/lib/narrative-trend.ts';
import { NarrativeCharts } from '../../shared/ui/NarrativeCharts.tsx';
import styles from './Records.module.css';

const WINDOWS: readonly [TrendWindow, string][] = [
  [30, '30 días'],
  [90, '90 días'],
  ['todo', 'Todo'],
];

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
        {(data) => <NarrativeCharts rows={data} window={period} />}
      </QueryState>
    </Card>
  );
};
