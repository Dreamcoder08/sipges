import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ActionSaved,
  ActionStatus,
  ManagementOverview,
  PreventionSummary,
  PreventiveActions,
  TerritorialAlerts,
} from '@mascli/contracts';
import { requestJson } from '../../shared/api/client.ts';
import { downloadFile } from '../../shared/api/download.ts';
import { errorDetail } from '../../shared/api/feedback.ts';
import type { FeatureContext } from '../../shared/api/feature-context.ts';
import { Alert } from '../../shared/ui/Alert.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import { Card } from '../../shared/ui/Card.tsx';
import { QueryState } from '../../shared/ui/QueryState.tsx';
import styles from './Operations.module.css';
const labels: Record<string, string> = {
  digital_alerts: 'Alertas digitales',
  high_priority_alerts: 'Alertas de prioridad alta',
  pending_review: 'Pendientes de revisión',
  total_actions: 'Acciones registradas',
  active_actions: 'Acciones activas',
  overdue_actions: 'Acciones vencidas',
  completed_actions: 'Acciones completadas',
  completion_percent: 'Cumplimiento (%)',
  average_progress: 'Avance promedio (%)',
  registered_commitments: 'Compromisos registrados',
  overdue_commitments_explicit: 'Compromisos explícitamente vencidos',
};
export const ManagementPage = ({ scope, projectId, role }: FeatureContext) => {
  const writable = role !== 'consulta';
  const client = useQueryClient();
  const [alertId, setAlertId] = useState('');
  const [title, setTitle] = useState('');
  const [responsible, setResponsible] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [description, setDescription] = useState('');
  const [selected, setSelected] = useState('');
  const [status, setStatus] = useState('Pendiente');
  const [progress, setProgress] = useState(0);
  const [note, setNote] = useState('');
  const [evidence, setEvidence] = useState('');
  const overview = useQuery({
    queryKey: ['operations', scope, 'management'],
    queryFn: ({ signal }) =>
      requestJson('/system/management/overview', ManagementOverview, { scope, signal }),
  });
  const actions = useQuery({
    queryKey: ['operations', scope, 'actions'],
    queryFn: ({ signal }) =>
      requestJson('/system/prevention/actions', PreventiveActions, { scope, signal }),
  });
  const summary = useQuery({
    queryKey: ['operations', scope, 'prevention'],
    queryFn: ({ signal }) =>
      requestJson('/system/prevention/summary', PreventionSummary, { scope, signal }),
  });
  const alerts = useQuery({
    queryKey: ['operations', scope, 'alerts'],
    queryFn: ({ signal }) =>
      requestJson('/system/intelligence/territorial-alerts?limit=200', TerritorialAlerts, {
        scope,
        signal,
      }),
  });
  const refresh = () => client.invalidateQueries({ queryKey: ['operations', scope] });
  const create = useMutation({
    mutationFn: () =>
      requestJson('/system/prevention/actions', ActionSaved, {
        scope,
        method: 'POST',
        body: {
          json: {
            project_id: projectId,
            alert_id: alertId,
            title,
            responsible,
            due_date: dueDate,
            description,
          },
        },
      }),
    onSuccess: () => {
      setTitle('');
      setDescription('');
      return refresh();
    },
  });
  const update = useMutation({
    mutationFn: () =>
      requestJson(`/system/prevention/actions/${encodeURIComponent(selected)}`, ActionSaved, {
        scope,
        method: 'PATCH',
        body: { json: { status, progress, note, evidence_url: evidence } },
      }),
    onSuccess: () => refresh(),
  });
  const csv = useMutation({
    mutationFn: () =>
      downloadFile(scope, '/system/management/report.csv', 'mascli_rc28_reporte_gerencial.csv'),
  });
  const busy = create.isPending || update.isPending;
  const actionable =
    alerts.data?.filter((a) => a.status === 'Corroborado' || a.status === 'En seguimiento') ?? [];
  const current = actions.data?.find((a) => a.id === selected);
  const transitionError =
    status === 'Completada' && progress !== 100
      ? 'Una acción completada debe indicar 100%.'
      : status === 'Pendiente' && progress !== 0
        ? 'Seleccione En ejecución cuando haya avance.'
        : current?.status === 'Cancelada' && status !== 'Cancelada'
          ? 'No puede reactivar una acción cancelada.'
          : (status === 'Completada' || status === 'Cancelada') && !note.trim()
            ? 'Justifique el cierre o cancelación.'
            : '';
  return (
    <div className={styles.stack}>
      <Card
        title="Resumen gerencial"
        action={
          <Button
            variant="secondary"
            disabled={csv.isPending || !overview.data}
            onClick={() => csv.mutate()}
          >
            Descargar CSV
          </Button>
        }
      >
        <QueryState query={overview} label="resumen gerencial">
          {(data) => (
            <>
              <p>
                Proyecto: {data.project_id} · Generado: {data.generated_at}
              </p>
              <dl className={styles.metrics}>
                {Object.entries(data.metrics).map(([name, value]) => (
                  <div key={name} className={styles.metric}>
                    <dt>{labels[name] ?? name}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
              <p>{data.methodology}</p>
              <ul>
                {data.limitations.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
              <h4>Prioridad de alertas</h4>
              <ul>
                {Object.entries(data.alerts_by_level).map(([name, total]) => (
                  <li key={name}>
                    {name}: {total}
                  </li>
                ))}
              </ul>
              <h4>Estado de acciones</h4>
              <ul>
                {Object.entries(data.actions_by_status).map(([name, total]) => (
                  <li key={name}>
                    {name}: {total}
                  </li>
                ))}
              </ul>
              <h4>Alertas recientes</h4>
              {data.recent_alerts.length ? (
                <ul>
                  {data.recent_alerts.map((a) => (
                    <li key={a.id}>
                      {a.id} · {a.created_at} · {a.status} · Prioridad {a.level} ({a.score})
                      <p className={styles.fragment}>
                        {a.source_type} · {a.source_url || 'Sin enlace'}
                      </p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No hay alertas recientes.</p>
              )}
              <h4>Acciones críticas</h4>
              {data.critical_actions.length ? (
                <ul>
                  {data.critical_actions.map((a) => (
                    <li key={a.id}>
                      {a.title} · {a.responsible} · {a.due_date} · {a.progress}%
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No hay acciones críticas.</p>
              )}
              <h4>Responsables</h4>
              <ul>
                {data.actions_by_responsible.map((a) => (
                  <li key={a.name}>
                    {a.name || 'Sin responsable'}: {a.total} acciones, {a.overdue} vencidas
                  </li>
                ))}
              </ul>
              <h4>Compromisos</h4>
              {data.commitments.length ? (
                <ul>
                  {data.commitments.map((c) => (
                    <li key={c.id}>
                      {c.id} · {c.responsible} · {c.status} · {c.due_date || 'Sin plazo'}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No hay compromisos registrados.</p>
              )}
            </>
          )}
        </QueryState>
        {csv.error && <Alert tone="error">{errorDetail(csv.error)}</Alert>}
      </Card>
      <Card title="Prevención territorial">
        <QueryState query={summary} label="métricas de prevención">
          {(data) => (
            <>
              <p>
                {data.total} acciones · {data.active} activas · {data.overdue} vencidas · Avance
                promedio {data.average_progress}%
              </p>
              <Alert tone="info">{data.notice} El IRSA permanece independiente.</Alert>
            </>
          )}
        </QueryState>
        {writable && (
          <>
            <h4>Crear plan preventivo</h4>
            <QueryState query={alerts} label="alertas verificadas">
              {() =>
                actionable.length ? (
                  <form
                    className={styles.form}
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!busy) create.mutate();
                    }}
                  >
                    <label>
                      Alerta verificada
                      <select
                        required
                        value={alertId}
                        onChange={(e) => setAlertId(e.target.value)}
                        disabled={busy}
                      >
                        <option value="">Seleccione una alerta</option>
                        {actionable.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.id} · {a.excerpt.slice(0, 80)} · {a.status}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Título del plan
                      <input
                        required
                        minLength={5}
                        maxLength={200}
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        disabled={busy}
                      />
                    </label>
                    <label>
                      Responsable
                      <input
                        required
                        minLength={2}
                        maxLength={150}
                        value={responsible}
                        onChange={(e) => setResponsible(e.target.value)}
                        disabled={busy}
                      />
                    </label>
                    <label>
                      Fecha de vencimiento
                      <input
                        type="date"
                        required
                        value={dueDate}
                        onChange={(e) => setDueDate(e.target.value)}
                        disabled={busy}
                      />
                    </label>
                    <label>
                      Descripción
                      <textarea
                        maxLength={2000}
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        disabled={busy}
                      />
                    </label>
                    <Button type="submit" disabled={busy || !alertId}>
                      Crear plan
                    </Button>
                  </form>
                ) : (
                  <p>
                    Primero corrobore una alerta mediante revisión humana para crear un plan
                    preventivo.
                  </p>
                )
              }
            </QueryState>
            {create.error && <Alert tone="error">{errorDetail(create.error)}</Alert>}
            {create.data && (
              <Alert tone="success">Plan preventivo creado; no modifica el IRSA.</Alert>
            )}
          </>
        )}
      </Card>
      <Card title="Acciones y seguimiento">
        <QueryState query={actions} label="acciones preventivas">
          {(items) =>
            items.length ? (
              <div className={styles.table}>
                <table>
                  <thead>
                    <tr>
                      <th>Plan</th>
                      <th>Responsable</th>
                      <th>Vencimiento</th>
                      <th>Estado</th>
                      <th>Avance</th>
                      <th>Historial</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((a) => (
                      <tr key={a.id}>
                        <td>{a.title}</td>
                        <td>{a.responsible}</td>
                        <td>{a.due_date}</td>
                        <td>{a.status}</td>
                        <td>{a.progress}%</td>
                        <td>
                          <Button
                            variant="secondary"
                            disabled={busy}
                            onClick={() => {
                              setSelected(a.id);
                              setStatus(a.status);
                              setProgress(a.progress);
                              setNote('');
                              setEvidence('');
                              update.reset();
                            }}
                          >
                            Ver plan {a.id}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p>No hay planes preventivos en este proyecto.</p>
            )
          }
        </QueryState>
        {current && (
          <div className={styles.form}>
            <h4>{current.title}</h4>
            <p>{current.description || 'Sin descripción'}</p>
            <p>Alerta: {current.alert_id}</p>
            <h4>Historial de avances</h4>
            <ol>
              {current.history.map((h) => (
                <li key={h.id}>
                  {h.created_at} · {h.status} · {h.progress}% · {h.note || 'Sin nota'}
                  {h.evidence_url && <p className={styles.fragment}>Evidencia: {h.evidence_url}</p>}
                </li>
              ))}
            </ol>
            {writable && (
              <form
                className={styles.form}
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!busy && !transitionError) update.mutate();
                }}
              >
                <label>
                  Estado del plan
                  <select
                    value={status}
                    onChange={(e) => {
                      setStatus(e.target.value);
                      if (e.target.value === 'Completada') setProgress(100);
                      if (e.target.value === 'Pendiente') setProgress(0);
                    }}
                    disabled={busy}
                  >
                    {ActionStatus.options.map((s) => (
                      <option
                        key={s}
                        disabled={current.status === 'Cancelada' && s !== 'Cancelada'}
                      >
                        {s}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Avance (%)
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    required
                    value={progress}
                    onChange={(e) => setProgress(Number(e.target.value))}
                    disabled={busy}
                  />
                </label>
                <label>
                  Nota de avance
                  <textarea
                    maxLength={2000}
                    required={status === 'Completada' || status === 'Cancelada'}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    disabled={busy}
                  />
                </label>
                <label>
                  URL de evidencia
                  <input
                    type="url"
                    value={evidence}
                    onChange={(e) => setEvidence(e.target.value)}
                    disabled={busy}
                  />
                </label>
                {transitionError && <Alert tone="info">{transitionError}</Alert>}
                <Button type="submit" disabled={busy || !!transitionError}>
                  Guardar avance
                </Button>
              </form>
            )}
            {update.error && <Alert tone="error">{errorDetail(update.error)}</Alert>}
            {update.data && <Alert tone="success">Avance registrado; no modifica el IRSA.</Alert>}
          </div>
        )}
      </Card>
    </div>
  );
};
