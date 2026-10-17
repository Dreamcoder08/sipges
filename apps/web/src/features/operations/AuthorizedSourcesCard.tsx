import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AuthorizedSourcesCatalog,
  OfficialSourcePost,
  type AuthorizedSourceState,
} from '@mascli/contracts';
import { z } from 'zod';
import { request, requestJson } from '../../shared/api/client.ts';
import { errorDetail } from '../../shared/api/feedback.ts';
import type { FeatureContext } from '../../shared/api/feature-context.ts';
import { Card } from '../../shared/ui/Card.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import styles from './AuthorizedSourcesCard.module.css';
const BASE = '/system/intelligence/sources';
const Configuration = ({
  context,
  state,
  changed,
}: {
  context: FeatureContext;
  state: AuthorizedSourceState;
  changed: () => Promise<void>;
}) => {
  const [enabled, setEnabled] = useState(state.enabled);
  const [query, setQuery] = useState(state.query);
  const [territory, setTerritory] = useState(state.territory);
  const [note, setNote] = useState(state.authorization_note);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const save = async () => {
    setBusy(true);
    try {
      await request(`${BASE}/defensoria/config`, {
        method: 'PUT',
        scope: context.scope,
        body: { json: { enabled, query, territory, authorization_note: note } },
      });
      await changed();
      setMessage('Configuración guardada.');
    } catch (error) {
      setMessage(errorDetail(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={styles.form}>
      <label>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />{' '}
        Activar consulta periódica autorizada
      </label>
      <label>
        Filtro de publicaciones
        <input maxLength={100} value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>
      <label>
        Territorio documentado (opcional)
        <input
          maxLength={200}
          value={territory}
          onChange={(event) => setTerritory(event.target.value)}
        />
      </label>
      <label>
        Nota de autorización
        <textarea maxLength={1000} value={note} onChange={(event) => setNote(event.target.value)} />
      </label>
      {enabled ? (
        <label>
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />{' '}
          Confirmo la autorización de esta fuente para el proyecto
        </label>
      ) : null}
      <Button
        disabled={busy || (enabled && (!note.trim() || !confirmed))}
        onClick={() => void save()}
      >
        Guardar configuración
      </Button>
      {message ? <p role="status">{message}</p> : null}
    </div>
  );
};
const SourceCard = ({ context }: { context: FeatureContext }) => {
  const client = useQueryClient();
  const key = ['authorized-sources', context.scope];
  const catalog = useQuery({
    queryKey: key,
    queryFn: () => requestJson(BASE, AuthorizedSourcesCatalog, { scope: context.scope }),
  });
  const [query, setQuery] = useState('');
  const [territory, setTerritory] = useState('');
  const [posts, setPosts] = useState<z.infer<typeof OfficialSourcePost>[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const writable = context.role === 'admin' || context.role === 'analista';
  const changed = async () => {
    await client.invalidateQueries({ queryKey: key });
  };
  const preview = async () => {
    setBusy(true);
    setMessage('');
    try {
      const items = await requestJson(
        `${BASE}/defensoria/preview?query=${encodeURIComponent(query)}`,
        z.array(OfficialSourcePost),
        { scope: context.scope },
      );
      setPosts(items);
      if (!items.length) setMessage('La fuente no devolvió publicaciones para este filtro.');
    } catch (error) {
      setPosts([]);
      setMessage(errorDetail(error));
    } finally {
      setBusy(false);
    }
  };
  const importPost = async (id: number) => {
    setBusy(true);
    try {
      const response = await request(`${BASE}/defensoria/import`, {
        method: 'POST',
        scope: context.scope,
        body: { json: { post_id: id, territory } },
      });
      const result = (await response.json()) as { created: boolean };
      setMessage(
        result.created
          ? 'Narrativa importada; pendiente de evaluación y verificación.'
          : 'Esta evidencia ya se había importado.',
      );
    } catch (error) {
      setMessage(errorDetail(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Fuentes oficiales autorizadas" eyebrow="Ingreso verificable">
      <div className={styles.panel}>
        {catalog.isPending ? <p>Cargando fuentes…</p> : null}
        {catalog.error ? <p role="alert">{errorDetail(catalog.error)}</p> : null}
        {catalog.data ? (
          <>
            <p>
              <a href={catalog.data.url} target="_blank" rel="noreferrer">
                {catalog.data.name}
              </a>{' '}
              · comprobada el {catalog.data.checked_at}
            </p>
            <p>{catalog.data.attribution}</p>
            <p>
              Consulta periódica: {catalog.data.state.enabled ? 'activada' : 'desactivada'}. Último
              intento: {catalog.data.state.last_poll_at ?? 'sin ejecución'}. Importadas:{' '}
              {catalog.data.state.last_imported}; duplicadas: {catalog.data.state.last_duplicates}.
            </p>
            {catalog.data.state.last_poll_error ? (
              <p role="alert">Error de la fuente: {catalog.data.state.last_poll_error}</p>
            ) : null}
            <p>
              Hasta 10 extractos por consulta, con intervalo mínimo de 15 minutos. La ejecución
              depende del ejecutor configurado; sin garantía de actualización inmediata.
            </p>
            <label>
              Buscar en la fuente oficial
              <input
                value={query}
                maxLength={100}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <Button disabled={busy} onClick={() => void preview()}>
              Previsualizar publicaciones
            </Button>
            {writable ? (
              <>
                <label>
                  Territorio documentado para importar (opcional)
                  <input
                    value={territory}
                    maxLength={200}
                    onChange={(event) => setTerritory(event.target.value)}
                  />
                </label>
                <p>
                  El territorio debe constar en la evidencia; no se deduce del nombre ni se asignan
                  coordenadas.
                </p>
                <Configuration
                  key={`${context.scope}:${catalog.data.state.revision}`}
                  context={context}
                  state={catalog.data.state}
                  changed={changed}
                />
              </>
            ) : (
              <p>Lectura: solo administradores y analistas pueden importar o configurar fuentes.</p>
            )}
            {posts.map((post) => (
              <article key={post.id} className={styles.post}>
                <a href={post.url} target="_blank" rel="noreferrer">
                  {post.title}
                </a>
                <p>{post.excerpt}</p>
                <small>{post.published_at}</small>
                {writable ? (
                  <Button disabled={busy} onClick={() => void importPost(post.id)}>
                    Importar publicación
                  </Button>
                ) : null}
              </article>
            ))}
          </>
        ) : null}
        {message ? <p role="status">{message}</p> : null}
      </div>
    </Card>
  );
};
export const AuthorizedSourcesCard = ({ context }: { context: FeatureContext }) => (
  <SourceCard key={context.scope} context={context} />
);
