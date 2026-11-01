import type { Timeline } from '@sipges/contracts';
import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import type { FeatureContext } from '../../shared/api/feature-context.ts';
import { InternalLink, objectHref } from '../../shared/lib/navigation.tsx';
import { monthLabel } from '../../shared/lib/text.ts';
import { Alert } from '../../shared/ui/Alert.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import { Card } from '../../shared/ui/Card.tsx';
import { EmptyState } from '../../shared/ui/EmptyState.tsx';
import { QueryState } from '../../shared/ui/QueryState.tsx';
import { monthlySeries } from '../../shared/ui/time/series.ts';
import { TimeHistogram } from '../../shared/ui/time/TimeHistogram.tsx';
import { timelineQuery } from './api.ts';
import styles from './Timeline.module.css';

/** Object types with a date of their own (docs/adr/0011 §7). */
const TYPES = [
  ['eventos', 'Eventos'],
  ['demandas', 'Demandas'],
  ['compromisos', 'Compromisos'],
  ['alertas', 'Alertas'],
  ['narrativas', 'Narrativas'],
  ['fuentes', 'Fuentes'],
  ['aarc', 'Evaluaciones AARC'],
] as const;

type Entry = Timeline['entries'][number];

const byMonth = (entries: readonly Entry[]) => {
  const groups = new Map<string, Entry[]>();
  for (const entry of entries) {
    const month = (entry.date ?? '').slice(0, 7);
    groups.set(month, [...(groups.get(month) ?? []), entry]);
  }
  return [...groups.entries()];
};

/** Every dated record of the project in one chronology, filterable by type and period. */
export const TimelinePage = ({ scope }: FeatureContext) => {
  const id = useId();
  const [modules, setModules] = useState<string[]>([]);
  const [range, setRange] = useState({ from: '', to: '' });
  // The histogram always shows the whole span; the list follows the selected period.
  const overview = useQuery(timelineQuery(scope, '', '', modules));
  const list = useQuery(timelineQuery(scope, range.from, range.to, modules));
  const toggle = (slug: string) =>
    setModules((current) =>
      current.includes(slug) ? current.filter((m) => m !== slug) : [...current, slug],
    );
  return (
    <div className={styles.page}>
      <Card title="Filtros">
        <fieldset className={styles.types}>
          <legend>Tipos de registro</legend>
          {TYPES.map(([slug, label]) => (
            <label key={slug} htmlFor={`${id}-${slug}`}>
              <input
                id={`${id}-${slug}`}
                type="checkbox"
                checked={modules.includes(slug)}
                onChange={() => toggle(slug)}
              />{' '}
              {label}
            </label>
          ))}
        </fieldset>
        <p className={styles.muted}>Sin tipos marcados se muestran todos.</p>
        {overview.data?.entries.length ? (
          <TimeHistogram
            series={monthlySeries(overview.data.entries.map((e) => e.date ?? ''))}
            from={range.from}
            to={range.to}
            label="Registros por mes"
            onChange={(from, to) => setRange({ from, to })}
          />
        ) : null}
        {range.from || range.to ? (
          <div className={styles.period}>
            <span>
              Periodo: {range.from ? monthLabel(range.from) : 'el inicio'} –{' '}
              {range.to ? monthLabel(range.to) : 'hoy'}
            </span>
            <Button variant="ghost" onClick={() => setRange({ from: '', to: '' })}>
              Ver todo el periodo
            </Button>
          </div>
        ) : null}
      </Card>
      <Card title="Cronología">
        <QueryState query={list} label="la cronología">
          {(data) =>
            data.entries.length ? (
              <>
                {data.truncated ? (
                  <Alert tone="info">
                    Se muestran los 500 registros más recientes. Acote el periodo para ver los
                    anteriores.
                  </Alert>
                ) : null}
                {byMonth(data.entries).map(([month, entries]) => (
                  <section key={month} aria-labelledby={`${id}-m-${month}`}>
                    <h3 id={`${id}-m-${month}`} className={styles.month}>
                      {monthLabel(month)} <small>({entries.length})</small>
                    </h3>
                    <ol className={styles.entries}>
                      {entries.map((entry) => (
                        <li key={`${entry.module}/${entry.id}`}>
                          <time dateTime={entry.date ?? ''}>{entry.date}</time>
                          <span className={styles.type}>{entry.type_label}</span>
                          <InternalLink href={objectHref(entry.module, entry.id)}>
                            {entry.title}
                          </InternalLink>
                          {entry.marking === 'restringido' ? (
                            <span className={styles.restricted}>Restringido</span>
                          ) : null}
                        </li>
                      ))}
                    </ol>
                  </section>
                ))}
              </>
            ) : (
              <EmptyState title="Sin registros fechados para estos filtros.">
                Los registros aparecen aquí cuando tienen fecha (por ejemplo, la fecha de un evento
                o el registro de una demanda).
              </EmptyState>
            )
          }
        </QueryState>
      </Card>
    </div>
  );
};
