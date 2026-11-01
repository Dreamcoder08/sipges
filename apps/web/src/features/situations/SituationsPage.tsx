import {
  RecordCreated,
  type Situation,
  type SituationsReport as Report,
  SituationsReport,
} from '@sipges/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { requestJson } from '../../shared/api/client.ts';
import type { FeatureContext } from '../../shared/api/feature-context.ts';
import { errorDetail } from '../../shared/api/feedback.ts';
import { fetchModuleRecords } from '../../shared/api/module-records.ts';
import { InternalLink, objectHref } from '../../shared/lib/navigation.tsx';
import { Alert } from '../../shared/ui/Alert.tsx';
import { LevelPill } from '../../shared/ui/Badges.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import { Card } from '../../shared/ui/Card.tsx';
import { EmptyState } from '../../shared/ui/EmptyState.tsx';
import { QueryState } from '../../shared/ui/QueryState.tsx';
import { situationAlertPayload, citationHref, GENERATED_ORIGIN } from './model.ts';
import styles from './Situations.module.css';

const KIND: Readonly<Record<Situation['kind'], string>> = {
  tema: 'Tema',
  actor: 'Actor',
  territorio: 'Territorio',
};

/** Related records, their trend and suggested actions (docs/adr/0020). */
export const SituationsPage = ({ scope, projectId, projectLabel, role }: FeatureContext) => {
  const report = useQuery({
    queryKey: ['situations', scope],
    queryFn: ({ signal }) =>
      requestJson('/system/v4/situations', SituationsReport, { scope, signal }),
  });
  // Alerts already created from a situation, so the same one is not raised twice.
  const alerts = useQuery({
    queryKey: ['situations', scope, 'alerts'],
    queryFn: ({ signal }) => fetchModuleRecords('alertas', scope, '', signal),
  });
  const raised = new Map(
    (alerts.data ?? [])
      .filter((row) => row.Origen === GENERATED_ORIGIN && typeof row.Situacion === 'string')
      .map((row) => [String(row.Situacion), row._id]),
  );
  return (
    <div className={styles.page}>
      <p>
        SIPGES relaciona registros que comparten tema, actor o territorio registrado en fechas
        cercanas. Lo reciente pesa más. Cada situación muestra por qué tiene su color y qué acciones
        podrían tomarse; la decisión es siempre suya.
      </p>
      <QueryState query={report} label="las situaciones">
        {(data) => (
          <SituationList
            data={data}
            scope={scope}
            projectId={projectId}
            projectLabel={projectLabel}
            writable={role !== 'consulta'}
            raised={raised}
          />
        )}
      </QueryState>
    </div>
  );
};

const SituationList = ({
  data,
  ...rest
}: {
  data: Report;
  scope: string;
  projectId: string;
  projectLabel: string;
  writable: boolean;
  raised: ReadonlyMap<string, string>;
}) => (
  <>
    <p className={styles.muted}>
      {data.considered} registro(s) con fecha en los últimos {data.window_days} días
      {data.undated ? ` · ${data.undated} sin fecha no se consideran` : ''}.
    </p>
    {data.situations.length ? (
      <ol className={styles.list}>
        {data.situations.map((situation) => (
          <li key={situation.key}>
            <SituationCard situation={situation} today={data.today} {...rest} />
          </li>
        ))}
      </ol>
    ) : (
      <EmptyState title="Sin situaciones relacionadas" icon="layers">
        Aún no hay dos o más registros con fecha que compartan tema, actor o territorio en la
        ventana del proyecto.
      </EmptyState>
    )}
    <NarrativeCard narratives={data.narratives} />
    <details className={styles.method}>
      <summary>Cómo se calcula</summary>
      <p>{data.method}</p>
      <ul>
        {data.limitations.map((text) => (
          <li key={text}>{text}</li>
        ))}
      </ul>
    </details>
  </>
);

const SituationCard = ({
  situation,
  today,
  scope,
  projectId,
  projectLabel,
  writable,
  raised,
}: {
  situation: Situation;
  today: string;
  scope: string;
  projectId: string;
  projectLabel: string;
  writable: boolean;
  raised: ReadonlyMap<string, string>;
}) => {
  const cache = useQueryClient();
  const [created, setCreated] = useState<string | null>(null);
  const titles = new Map(situation.records.map((r) => [`${r.module}:${r.id}`, r]));
  const create = useMutation({
    mutationFn: async () =>
      (
        await requestJson('/api/alertas', RecordCreated, {
          scope,
          method: 'POST',
          body: {
            json: { payload: situationAlertPayload(situation, today, projectId, projectLabel) },
          },
        })
      ).id,
    onSuccess: async (id) => {
      setCreated(id);
      await cache.invalidateQueries({ queryKey: ['situations', scope, 'alerts'] });
    },
  });
  const existing = created ?? raised.get(situation.key);
  return (
    <Card
      eyebrow={`${KIND[situation.kind]} · ${situation.trend}`}
      title={situation.label}
      action={<LevelPill level={situation.level} />}
    >
      <p className={styles.summary}>{situation.summary}</p>
      <section aria-label={`Por qué: ${situation.label}`}>
        <h4>Por qué</h4>
        <ul className={styles.reasons}>
          {situation.reasons.map((reason) => (
            <li key={reason.text}>
              {reason.text}
              {reason.records.length ? (
                <span className={styles.citations}>
                  {reason.records.map((ref) => {
                    const record = titles.get(ref);
                    return record ? (
                      <InternalLink
                        key={ref}
                        href={citationHref(record.module, record.id)}
                        aria-label={`${record.module} ${record.id}: ${record.title}`}
                      >
                        {record.id}
                      </InternalLink>
                    ) : null;
                  })}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
      <section aria-label={`Acciones sugeridas: ${situation.label}`}>
        <h4>Acciones sugeridas</h4>
        <ul>
          {situation.recommendations.map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ul>
        <p className={styles.muted}>Solo orientan: la decisión final es suya.</p>
      </section>
      {situation.lessons && situation.lessons.length > 0 && (
        <section>
          <h4>Lecciones previas</h4>
          <ul>
            {situation.lessons.map((lesson) => (
              <li key={lesson.id}>
                <InternalLink href={objectHref('lecciones', lesson.id)}>{lesson.id}</InternalLink> ·{' '}
                {lesson.date} · {lesson.learned}
              </li>
            ))}
          </ul>
        </section>
      )}
      <details>
        <summary>Registros relacionados ({situation.records.length})</summary>
        <ul>
          {situation.records.map((record) => (
            <li key={`${record.module}:${record.id}`}>
              <InternalLink href={citationHref(record.module, record.id)}>
                {record.module} {record.id}
              </InternalLink>{' '}
              · {record.date} · {record.title}
            </li>
          ))}
        </ul>
      </details>
      {existing ? (
        <Alert tone="success">
          Alerta registrada para esta situación:{' '}
          <InternalLink href={objectHref('alertas', existing)}>{existing}</InternalLink>
        </Alert>
      ) : writable ? (
        <Button disabled={create.isPending} onClick={() => create.mutate()}>
          Crear alerta {situation.level.toLowerCase()} con esta explicación
        </Button>
      ) : null}
      {create.isError ? <Alert tone="error">{errorDetail(create.error)}</Alert> : null}
    </Card>
  );
};

/** Repeated topics, platforms and tone change in narratives and media (S7). */
const NarrativeCard = ({ narratives }: { narratives: Report['narratives'] }) => (
  <Card eyebrow="Redes y medios" title="Narrativas en la ventana del proyecto">
    {narratives.total ? (
      <>
        <p>
          {narratives.total} publicación(es) con fecha · {narratives.recent} en los últimos 7 días.
        </p>
        {narratives.tone ? (
          <p className={styles.summary}>
            Cambio de narrativa: el tono negativo pasa de {narratives.tone.then} % a{' '}
            {narratives.tone.now} % en las publicaciones más recientes.
          </p>
        ) : null}
        {narratives.topics.length ? (
          <>
            <h4>Temas que se repiten</h4>
            <ul>
              {narratives.topics.map((topic) => (
                <li key={topic.name}>
                  {topic.name}: {topic.count} publicación(es)
                  {topic.recent ? `, ${topic.recent} esta semana` : ''}
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {narratives.platforms.length ? (
          <p className={styles.muted}>
            Plataformas: {narratives.platforms.map((p) => `${p.name} (${p.count})`).join(', ')}
          </p>
        ) : null}
      </>
    ) : (
      <p>Aún no hay narrativas con fecha en la ventana del proyecto.</p>
    )}
    <p className={styles.muted}>
      Hoy se detectan con reglas transparentes. Más adelante un asistente de IA podrá revisar estas
      mismas publicaciones si el titular de los datos lo aprueba.
    </p>
  </Card>
);
