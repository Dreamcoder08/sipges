import { accountDisplayName } from '../../shared/ui/account-name.ts';
import {
  DocumentReviewDecisionResponse,
  type DocumentReviewItem,
  DocumentReviewResponse,
  DocumentReviewStatus,
} from '@sipges/contracts';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { requestJson } from '../../shared/api/client.ts';
import type { FeatureContext } from '../../shared/api/feature-context.ts';
import { errorDetail } from '../../shared/api/feedback.ts';
import { InternalLink, objectHref } from '../../shared/lib/navigation.tsx';
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
const PAGE_SIZE = 50;
/** Link to the record an approval created (T23), named by its module's label. */
const RecordLink = ({ module, id, label }: { module: string; id: string; label: string }) => (
  <InternalLink href={objectHref(module, id)}>Ver el registro en {label}</InternalLink>
);
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
  const label = item.target?.label ?? 'su módulo';
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
      {item.target && !item.record ? (
        // «Aceptado para revisión» and «Corroborado documentalmente» both approve.
        <p>Al aprobar, se crea el registro en {label}.</p>
      ) : null}
      <Button
        disabled={mutation.isPending || (status === 'corroborado_documentalmente' && !note.trim())}
        onClick={() => void save()}
      >
        {mutation.isPending ? 'Guardando…' : 'Guardar decisión'}
      </Button>
      {mutation.error ? <Alert tone="error">{errorDetail(mutation.error)}</Alert> : null}
      {mutation.isSuccess ? (
        <Alert tone="success">
          {mutation.data.record
            ? `Decisión registrada. ${
                mutation.data.record.created ? 'Registro creado' : 'El registro ya existía'
              } en ${label}.`
            : 'Decisión registrada.'}
        </Alert>
      ) : null}
      {mutation.data?.record ? (
        <p>
          <RecordLink {...mutation.data.record} label={label} />
        </p>
      ) : null}
    </fieldset>
  );
};
export const ReviewInbox = (context: FeatureContext) => {
  const [status, setStatus] = useState('');
  const [theme, setTheme] = useState('');
  const [offset, setOffset] = useState(0);
  const query = useQuery({
    queryKey: ['document-review', context.scope, status, theme, offset],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (status) params.set('status', status);
      if (theme) params.set('theme', theme);
      return requestJson(`/system/document-lab/review?${params}`, DocumentReviewResponse, {
        scope: context.scope,
        signal,
      });
    },
    placeholderData: keepPreviousData,
  });
  const total = query.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  if (query.data && !query.isPlaceholderData && offset > 0 && offset >= total) {
    // A decision or another reviewer can shrink the queue below the current page.
    setOffset((pages - 1) * PAGE_SIZE);
  }
  const themes = { ...(theme ? { [theme]: 0 } : {}), ...query.data?.themes };
  const writable = context.role === 'admin' || context.role === 'analista';
  return (
    <Card title="Bandeja de revisión documental">
      <div className={styles.form}>
        <label>
          Filtrar tema
          <select
            value={theme}
            onChange={(event) => {
              setTheme(event.target.value);
              setOffset(0);
            }}
          >
            <option value="">Todos los temas</option>
            {Object.entries(themes).map(([name, count]) => (
              <option value={name} key={name}>
                {name} ({count})
              </option>
            ))}
          </select>
        </label>
        <label>
          Filtrar estado de revisión
          <select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setOffset(0);
            }}
          >
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
        <Button
          variant="secondary"
          disabled={offset === 0 || query.isFetching}
          onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
        >
          Anterior
        </Button>
        <span aria-live="polite">
          Página {page} de {pages}
        </span>
        <Button
          variant="secondary"
          disabled={page >= pages || query.isFetching}
          onClick={() => setOffset(offset + PAGE_SIZE)}
        >
          Siguiente
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
                  {item.record ? (
                    <p>
                      <RecordLink {...item.record} label={item.target?.label ?? 'su módulo'} />
                    </p>
                  ) : null}
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
