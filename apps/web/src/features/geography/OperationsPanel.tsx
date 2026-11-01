import { RecordNeighbourhood } from '@sipges/contracts';
import { useQuery } from '@tanstack/react-query';
import { requestJson } from '../../shared/api/client.ts';
import { InternalLink, objectHref } from '../../shared/lib/navigation.tsx';
import { LevelPill } from '../../shared/ui/Badges.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import { EvidenceTag } from './EvidenceTag.tsx';
import {
  ACTOR_GROUP_LABELS,
  ACTOR_GROUPS,
  buildDossier,
  type DossierAction,
  type DossierRef,
  DOSSIER_FIELDS,
  DOSSIER_HOPS,
} from './operations.ts';
import styles from './Operations.module.css';

const RecordLink = ({ record }: { record: DossierRef }) => (
  <InternalLink href={objectHref(record.module, record.id)}>{record.title}</InternalLink>
);

const actionLine = (a: DossierAction) =>
  [
    a.status || 'Sin estado',
    a.responsible ? `responsable ${a.responsible}` : '',
    a.due ? `plazo ${a.due}` : '',
  ]
    .filter(Boolean)
    .join(' · ');

const ActionItem = ({ action }: { action: DossierAction }) => (
  <li>
    <RecordLink record={action} />
    <small>
      {actionLine(action)}
      {action.overdue ? <strong className={styles.late}> · vencida</strong> : null}
    </small>
    <small>
      {action.result
        ? `Resultado: ${action.result}`
        : action.done
          ? 'Sin resultado documentado'
          : 'Resultado pendiente'}
    </small>
  </li>
);

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Operational intelligence of what is selected on the territorial map (ODD
 * territorial-operations, phase 3): signals, the alerts they justify, actions and their
 * results, commitments and the actors involved, joined only by typed links.
 */
export const OperationsPanel = ({
  scope,
  seeds,
  context,
  capped,
}: {
  scope: string;
  /** Records of the territory (slug + id), at most 100. */
  seeds: readonly { module: string; id: string }[];
  /** What the seeds are, e.g. "Concesión Rosa 1". */
  context: string;
  /** More records were in scope than the dossier takes. */
  capped: boolean;
}) => {
  const key = seeds.map((s) => `${s.module}:${s.id}`).join('|');
  const query = useQuery({
    queryKey: ['territorial-operations', scope, key],
    enabled: seeds.length > 0,
    staleTime: 60_000,
    retry: false,
    queryFn: ({ signal }) =>
      requestJson('/system/graph/neighbourhood', RecordNeighbourhood, {
        scope,
        signal,
        method: 'POST',
        body: { json: { seeds, hops: DOSSIER_HOPS, fields: DOSSIER_FIELDS } },
      }),
  });

  if (!seeds.length)
    return (
      <p className={styles.note}>
        No hay registros del territorio en {context}. Amplíe los filtros o seleccione otra
        concesión.
      </p>
    );
  if (query.error)
    return (
      <p role="alert">
        No se pudieron reunir los vínculos del territorio.{' '}
        <Button variant="ghost" onClick={() => void query.refetch()}>
          Reintentar
        </Button>
      </p>
    );
  if (!query.data) return <p role="status">Reuniendo señales, alertas y acciones vinculadas…</p>;

  const dossier = buildDossier(query.data, seeds, today());
  const openAlerts = dossier.alerts.filter((a) => a.open);
  const attending = new Set(dossier.alerts.flatMap((a) => a.actions.map((x) => x.id)));
  const demandActions = dossier.actions.filter((a) => !attending.has(a.id));
  const counts: [string, number][] = [
    ['Señales', dossier.signals.length],
    ['Alertas abiertas', openAlerts.length],
    ['Acciones', dossier.actions.length],
    ['Compromisos', dossier.commitments.length],
    ['Actores', dossier.actors.length],
  ];

  return (
    <div className={styles.panel}>
      <p className={styles.note}>
        {context}: {dossier.signals.length} señal(es) documentada(s)
        {capped ? ' (las 100 más recientes de la vista)' : ''}.
      </p>
      <dl className={styles.counts}>
        {counts.map(([label, value]) => (
          <div key={label} data-alert={label === 'Alertas abiertas' && value > 0}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>

      <section aria-label="Requiere atención" className={styles.section}>
        <h4 className={styles.heading}>Requiere atención</h4>
        {dossier.attention.length ? (
          <ul className={styles.list}>
            {dossier.attention.map((a) => (
              <li key={`${a.kind}:${a.ref.module}:${a.ref.id}`} className={styles.attention}>
                <RecordLink record={a.ref} />
                <small>{a.text}</small>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.note}>
            Sin pendientes en los vínculos documentados: cada alerta abierta tiene una acción y
            ningún plazo explícito está vencido.
          </p>
        )}
      </section>

      <section aria-label="Alertas y su sustento" className={styles.section}>
        <h4 className={styles.heading}>Alertas y su sustento</h4>
        {dossier.alerts.length ? (
          <ul className={styles.list}>
            {dossier.alerts.map((alert) => (
              <li key={alert.id} className={styles.alert}>
                <span className={styles.row}>
                  <LevelPill level={alert.level} /> <RecordLink record={alert} />
                </span>
                <small>
                  {alert.status || 'Sin estado'}
                  {alert.date ? ` · ${alert.date}` : ''}
                </small>
                <p className={styles.label}>Señales que la originan</p>
                <ul className={styles.sublist}>
                  {alert.basis.map((s) => (
                    <li key={`${s.module}:${s.id}`}>
                      <EvidenceTag state={s.evidence} /> <RecordLink record={s} />
                      <small>
                        {s.typeLabel}
                        {s.date ? ` · ${s.date}` : ''} · {s.basis}
                      </small>
                    </li>
                  ))}
                </ul>
                <p className={styles.label}>Acciones</p>
                {alert.actions.length ? (
                  <ul className={styles.sublist}>
                    {alert.actions.map((a) => (
                      <ActionItem key={a.id} action={a} />
                    ))}
                  </ul>
                ) : (
                  <p className={styles.note}>
                    Sin acción vinculada.
                    {alert.suggested ? ` Acción sugerida en la alerta: ${alert.suggested}` : ''}
                  </p>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.note}>
            Ninguna alerta está vinculada como originada por estas señales.
          </p>
        )}
      </section>

      {demandActions.length ? (
        <section aria-label="Acciones sobre demandas" className={styles.section}>
          <h4 className={styles.heading}>Acciones sobre demandas</h4>
          <ul className={styles.list}>
            {demandActions.map((a) => (
              <ActionItem key={a.id} action={a} />
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-label="Compromisos" className={styles.section}>
        <h4 className={styles.heading}>Compromisos</h4>
        {dossier.commitments.length ? (
          <ul className={styles.list}>
            {dossier.commitments.map((c) => (
              <li key={c.id}>
                <RecordLink record={c} />
                <small>
                  {[
                    c.status || 'Sin estado',
                    c.responsible ? `responsable ${c.responsible}` : '',
                    c.due ? `plazo ${c.due}` : '',
                    c.progress !== null ? `avance ${c.progress}%` : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                  {c.overdue ? <strong className={styles.late}> · vencido</strong> : null}
                </small>
                {c.progress !== null ? (
                  <progress
                    className={styles.progress}
                    max={100}
                    value={c.progress}
                    aria-label={`Avance de ${c.title}`}
                  />
                ) : null}
                <small>Responde a: {c.demands.map((d) => d.title).join('; ')}</small>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.note}>
            Ningún compromiso responde a las demandas de este territorio.
          </p>
        )}
      </section>

      <section aria-label="Actores involucrados" className={styles.section}>
        <h4 className={styles.heading}>Actores involucrados</h4>
        {dossier.actors.length ? (
          ACTOR_GROUPS.map((group) => {
            const members = dossier.actors.filter((a) => a.group === group);
            return members.length ? (
              <div key={group}>
                <p className={styles.label}>{ACTOR_GROUP_LABELS[group]}</p>
                <ul className={styles.sublist}>
                  {members.map((a) => (
                    <li key={a.id}>
                      <RecordLink record={a} />
                      {a.type ? <small>{a.type}</small> : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null;
          })
        ) : (
          <p className={styles.note}>Ningún actor está vinculado a estas señales.</p>
        )}
      </section>

      <p className={styles.note}>
        Solo se relacionan registros con vínculos explícitos o campos de referencia (Alerta
        asociada, Demanda asociada, actor principal); los nombres de lugares y los textos no crean
        relaciones. Los vencimientos usan fechas límite explícitas. Nada aquí es una predicción.
        {dossier.truncated
          ? ' El territorio tiene más vínculos de los que se muestran; acerque el mapa o filtre.'
          : ''}
      </p>
    </div>
  );
};
