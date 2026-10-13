import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCreated,
  AlertReviewed,
  AlertState,
  AnalysisMode,
  TerritorialAlerts,
  TerritorialSummary,
  TextAnalysisResponse,
} from '@mascli/contracts';
import { requestJson } from '../../shared/api/client.ts';
import { errorDetail } from '../../shared/api/feedback.ts';
import type { FeatureContext } from '../../shared/api/feature-context.ts';
import { Alert } from '../../shared/ui/Alert.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import { Card } from '../../shared/ui/Card.tsx';
import { QueryState } from '../../shared/ui/QueryState.tsx';
import styles from './Operations.module.css';
export const IntelligencePage = (context: FeatureContext) => {
  const { scope, projectId, role } = context;
  const writable = role !== 'consulta';
  const client = useQueryClient();
  const [text, setText] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [mode, setMode] = useState('automatic');
  const [sourceType, setSourceType] = useState('Publicación digital');
  const [analystNote, setAnalystNote] = useState('');
  const [selected, setSelected] = useState('');
  const [status, setStatus] = useState('Corroborado');
  const [note, setNote] = useState('');
  const alerts = useQuery({
    queryKey: ['operations', scope, 'alerts'],
    queryFn: ({ signal }) =>
      requestJson('/system/intelligence/territorial-alerts?limit=200', TerritorialAlerts, {
        scope,
        signal,
      }),
  });
  const summary = useQuery({
    queryKey: ['operations', scope, 'summary'],
    queryFn: ({ signal }) =>
      requestJson('/system/intelligence/territorial-summary', TerritorialSummary, {
        scope,
        signal,
      }),
  });
  const body = () => ({
    text,
    source_url: sourceUrl,
    mode,
    project_id: projectId,
    source_type: sourceType,
    analyst_note: analystNote,
  });
  const refresh = () => client.invalidateQueries({ queryKey: ['operations', scope] });
  const analysis = useMutation({
    mutationFn: () =>
      requestJson('/system/intelligence/semantic-analyze', TextAnalysisResponse, {
        scope,
        method: 'POST',
        body: { json: body() },
      }),
  });
  const create = useMutation({
    mutationFn: () =>
      requestJson('/system/intelligence/territorial-alerts', AlertCreated, {
        scope,
        method: 'POST',
        body: { json: body() },
      }),
    onSuccess: () => refresh(),
  });
  const review = useMutation({
    mutationFn: () =>
      requestJson(
        `/system/intelligence/territorial-alerts/${encodeURIComponent(selected)}`,
        AlertReviewed,
        { scope, method: 'PATCH', body: { json: { status, reviewer_note: note } } },
      ),
    onSuccess: () => refresh(),
  });
  const busy = analysis.isPending || create.isPending || review.isPending;
  const report = analysis.data ?? create.data?.analysis;
  const selectedAlert = alerts.data?.find((a) => a.id === selected);
  return (
    <div className={styles.stack}>
      <Alert tone="info">
        La prioridad textual requiere revisión humana. Analizar o corroborar una alerta no modifica
        el IRSA. El enlace se conserva como referencia y no se consulta automáticamente.
      </Alert>
      <Card title="Analizar publicación o reporte">
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy) {
              create.reset();
              analysis.mutate();
            }
          }}
        >
          <label>
            Texto a analizar
            <textarea
              required
              maxLength={20000}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                analysis.reset();
                create.reset();
              }}
              disabled={busy}
            />
          </label>
          <label>
            URL de la fuente
            <input
              type="url"
              value={sourceUrl}
              onChange={(e) => {
                setSourceUrl(e.target.value);
                analysis.reset();
                create.reset();
              }}
              disabled={busy}
            />
          </label>
          <label>
            Modo de análisis
            <select
              value={mode}
              onChange={(e) => {
                setMode(e.target.value);
                analysis.reset();
                create.reset();
              }}
              disabled={busy}
            >
              {AnalysisMode.options.map((m) => (
                <option key={m} value={m}>
                  {m === 'automatic'
                    ? 'Automático con respaldo por reglas'
                    : m === 'semantic'
                      ? 'Semántico (requiere modelo)'
                      : 'Reglas'}
                </option>
              ))}
            </select>
          </label>
          {writable && (
            <>
              <label>
                Tipo de fuente
                <select
                  value={sourceType}
                  onChange={(e) => setSourceType(e.target.value)}
                  disabled={busy}
                >
                  {['Publicación digital', 'Documento', 'Reporte de campo'].map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </label>
              <label>
                Nota del analista
                <textarea
                  maxLength={2000}
                  value={analystNote}
                  onChange={(e) => setAnalystNote(e.target.value)}
                  disabled={busy}
                />
              </label>
            </>
          )}
          <div className={styles.row}>
            <Button type="submit" disabled={busy || !text.trim()}>
              Analizar texto
            </Button>
            {writable && (
              <Button
                variant="secondary"
                disabled={busy || !text.trim()}
                onClick={(e) => {
                  if (!busy && e.currentTarget.form?.reportValidity()) {
                    analysis.reset();
                    create.mutate();
                  }
                }}
              >
                Registrar alerta
              </Button>
            )}
          </div>
        </form>
        {analysis.error && <Alert tone="error">{errorDetail(analysis.error)}</Alert>}
        {create.error && <Alert tone="error">{errorDetail(create.error)}</Alert>}
        {create.data && <Alert tone="success">Alerta registrada. {create.data.notice}</Alert>}
      </Card>
      {report && (
        <Card title="Resultado orientativo">
          <p>{report.method}</p>
          <p>
            Prioridad: {report.orientation.level} ({report.orientation.score}).{' '}
            {report.orientation.meaning}
          </p>
          {report.semantic && (
            <Alert tone="info">
              {report.semantic.note}{' '}
              {report.semantic.active ? 'Capa semántica activa.' : 'Capa semántica inactiva.'}
            </Alert>
          )}
          <p className={styles.fragment}>{report.evidence.fragment}</p>
          <p className={styles.hash}>SHA-256: {report.evidence.sha256}</p>
          <h4>Temas y señales</h4>
          <ul>
            {report.topics.map((t) => (
              <li key={t.tema}>
                {t.tema}: {t.terminos_detectados.join(', ')}
              </li>
            ))}
            {report.signals.map((s) => (
              <li key={s.senal}>
                {s.senal}: {s.terminos_detectados.join(', ')}
              </li>
            ))}
          </ul>
          <h4>Comparación con narrativas del proyecto</h4>
          <ul>
            {report.project_comparison.map((t) => (
              <li key={t.tema}>
                {t.tema}: {t.registros_relacionados_por_palabras} registros por palabras
              </li>
            ))}
          </ul>
          {report.semantic?.matches.map((m, i) => (
            <p key={i}>
              {m.theme}: similitud {m.similarity}; referencia {m.reference}
            </p>
          ))}
          <h4>Acciones sugeridas</h4>
          <ul>
            {report.suggested_actions.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
          <ul>
            {report.limitations.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </Card>
      )}
      <Card title="Resumen territorial">
        <QueryState query={summary} label="resumen territorial">
          {(data) => (
            <>
              <p>
                {data.total} alertas registradas. {data.caution}
              </p>
              <dl className={styles.metrics}>
                {Object.entries(data.by_status).map(([name, value]) => (
                  <div key={name} className={styles.metric}>
                    <dt>{name}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
              <h4>Prioridades de revisión</h4>
              <ul>
                {Object.entries(data.by_priority).map(([level, total]) => (
                  <li key={level}>
                    {level}: {total}
                  </li>
                ))}
              </ul>
              <h4>Temas registrados</h4>
              <ul>
                {data.themes.map((t) => (
                  <li key={t.name}>
                    {t.name}: {t.count}
                  </li>
                ))}
              </ul>
              <p>{data.irsa_integration}</p>
            </>
          )}
        </QueryState>
      </Card>
      <Card title="Bandeja de alertas">
        <QueryState query={alerts} label="alertas">
          {(items) => (
            <>
              {!items.length ? (
                <p>No hay alertas digitales en este proyecto.</p>
              ) : (
                <div className={styles.table}>
                  <table>
                    <thead>
                      <tr>
                        <th>Publicación</th>
                        <th>Prioridad</th>
                        <th>Estado</th>
                        <th>Revisión</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((a) => (
                        <tr key={a.id}>
                          <td>{a.excerpt}</td>
                          <td>
                            {a.level} ({a.score})
                          </td>
                          <td>{a.status}</td>
                          <td>
                            <Button
                              variant="secondary"
                              onClick={() => {
                                setSelected(a.id);
                                setStatus(a.status);
                                setNote(a.reviewer_note ?? '');
                                review.reset();
                              }}
                              disabled={busy}
                            >
                              Ver alerta {a.id}
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </QueryState>
        {selectedAlert && (
          <div className={styles.form}>
            <h4>Alerta {selectedAlert.id}</h4>
            <p className={styles.fragment}>{selectedAlert.excerpt}</p>
            <p>
              Fuente: {selectedAlert.source_url || 'Sin enlace'} · {selectedAlert.source_type}
            </p>
            <p>Nota del analista: {selectedAlert.analyst_note || 'Sin nota'}</p>
            <p>
              Última revisión: {selectedAlert.reviewer_note || 'Sin revisión'} ·{' '}
              {selectedAlert.reviewed_at ?? 'Pendiente'}
            </p>
            <p className={styles.hash}>SHA-256: {selectedAlert.sha256}</p>
            <ul>
              {selectedAlert.suggestions.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
            {writable && (
              <form
                className={styles.form}
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!busy) review.mutate();
                }}
              >
                <label>
                  Estado de revisión
                  <select
                    value={status}
                    onChange={(e) => setStatus(e.target.value)}
                    disabled={busy}
                  >
                    {AlertState.options.map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Nota de revisión humana
                  <textarea
                    maxLength={2000}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    disabled={busy}
                  />
                </label>
                <Button type="submit" disabled={busy}>
                  Guardar revisión
                </Button>
              </form>
            )}
            {review.error && <Alert tone="error">{errorDetail(review.error)}</Alert>}
            {review.data && <Alert tone="success">{review.data.notice}</Alert>}
          </div>
        )}
      </Card>
    </div>
  );
};
