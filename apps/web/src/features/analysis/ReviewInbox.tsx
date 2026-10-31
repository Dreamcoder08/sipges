import { accountDisplayName } from '../../shared/ui/account-name.ts';
import {
  DocumentReviewDecisionResponse,
  type DocumentReviewItem,
  DocumentReviewResponse,
  DocumentReviewStatus,
} from '@mascli/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { requestJson } from '../../shared/api/client.ts';
import type { FeatureContext } from '../../shared/api/feature-context.ts';
import { errorDetail } from '../../shared/api/feedback.ts';
import { Alert } from '../../shared/ui/Alert.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import { Card } from '../../shared/ui/Card.tsx';
import { QueryState } from '../../shared/ui/QueryState.tsx';
import styles from './Analysis.module.css';

const labels: Record<DocumentReviewStatus, string> = {
  pendiente: 'Pendiente',
  aceptado_para_revision: 'Aceptado para revisión',
  descartado: 'Descartado',
  corroborado_documentalmente: 'Corroborado documentalmente',
};
const ReviewDecision = ({
  item,
  context,
}: {
  item: DocumentReviewItem;
  context: FeatureContext;
}) => {
  const [status, setStatus] = useState<DocumentReviewStatus>(item.status);
  const [note, setNote] = useState(item.note);
  const lock = useRef(false);
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: (input: { status: DocumentReviewStatus; note: string }) =>
      requestJson(
        `/system/document-lab/review/${encodeURIComponent(item.id)}`,
        DocumentReviewDecisionResponse,
        {
          method: 'PATCH',
          scope: context.scope,
          body: { json: { ...input, reviewer: context.fullName || context.username } },
        },
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: ['document-review', context.scope] }),
  });
  const save = async () => {
    if (lock.current || (status === 'corroborado_documentalmente' && !note.trim())) return;
    lock.current = true;
    try {
      await mutation.mutateAsync({ status, note });
    } catch {
      /* Error rendered below. */
    } finally {
      lock.current = false;
    }
  };
  return (
    <fieldset
      className={styles.form}
      aria-label={`Revisar hallazgo ${item.id}`}
      disabled={mutation.isPending}
    >
      <legend>Decisión</legend>
      <label>
        Decisión
        <select
          value={status}
          onChange={(event) => {
            setStatus(DocumentReviewStatus.parse(event.target.value));
            mutation.reset();
          }}
        >
          {DocumentReviewStatus.options.map((option) => (
            <option key={option} value={option}>
              {labels[option]}
            </option>
          ))}
        </select>
      </label>
      <label>
        Nota sobre evidencia contrastada
        <textarea
          value={note}
          maxLength={1500}
          onChange={(event) => {
            setNote(event.target.value);
            mutation.reset();
          }}
        />
      </label>
      <p className={styles.muted}>
        Para corroborar, indique la fuente y documentación contrastada. Una decisión no certifica la
        verdad.
      </p>
      <Button
        disabled={mutation.isPending || (status === 'corroborado_documentalmente' && !note.trim())}
        onClick={() => void save()}
      >
        {mutation.isPending ? 'Guardando…' : 'Guardar decisión'}
      </Button>
      {mutation.error ? <Alert tone="error">{errorDetail(mutation.error)}</Alert> : null}
      {mutation.isSuccess ? <Alert tone="success">Decisión registrada.</Alert> : null}
    </fieldset>
  );
};
export const ReviewInbox = (context: FeatureContext) => {
  const [status, setStatus] = useState('');
  const query = useQuery({
    queryKey: ['document-review', context.scope, status],
    queryFn: ({ signal }) =>
      requestJson(
        `/system/document-lab/review${status ? `?status=${encodeURIComponent(status)}` : ''}`,
        DocumentReviewResponse,
        { scope: context.scope, signal },
      ),
  });
  const writable = context.role === 'admin' || context.role === 'analista';
  return (
    <Card title="Bandeja de revisión documental">
      <div className={styles.form}>
        <label>
          Filtrar estado de revisión
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">Todos</option>
            {DocumentReviewStatus.options.map((option) => (
              <option value={option} key={option}>
                {labels[option]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className={styles.actions}>
        <Button
          variant="secondary"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          Actualizar bandeja
        </Button>
      </div>
      <QueryState query={query} label="la bandeja documental">
        {(data) => (
          <>
            <p>{data.total} hallazgos en la bandeja del proyecto.</p>
            <Alert tone="info">{data.limitations}</Alert>
            {data.items.length ? (
              data.items.map((item) => (
                <article key={item.id} className={styles.item}>
                  <h4>{item.theme}</h4>
                  <p>{item.excerpt}</p>
                  <p>
                    Fuente: {item.source_file} · {item.location}
                  </p>
                  <p className={styles.muted}>SHA-256: {item.source_sha256}</p>
                  <p>{item.action}</p>
                  <p>
                    Estado: {labels[item.status]}. Revisor:{' '}
                    {accountDisplayName(item.reviewer) || 'Sin asignar'}.
                  </p>
                  {item.note ? <p>Nota registrada: {item.note}</p> : null}
                  {writable ? (
                    <ReviewDecision
                      key={`${item.id}/${item.updated_at}/${item.status}`}
                      item={item}
                      context={context}
                    />
                  ) : null}
                </article>
              ))
            ) : (
              <p>Sin hallazgos para este filtro.</p>
            )}
          </>
        )}
      </QueryState>
    </Card>
  );
};
