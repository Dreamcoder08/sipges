import {
  type MediaFeed,
  MediaFeedPreview,
  type MediaFeedIn,
  MediaMonitorState,
  MediaPollReport,
} from '@sipges/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { request, requestJson } from '../../shared/api/client.ts';
import { errorDetail } from '../../shared/api/feedback.ts';
import { formatDateTime } from '../../shared/lib/text.ts';
import { Alert } from '../../shared/ui/Alert.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import { Card } from '../../shared/ui/Card.tsx';
import { Field } from '../../shared/ui/Field.tsx';
import { QueryState } from '../../shared/ui/QueryState.tsx';
import styles from './Situations.module.css';

const BASE = '/system/v4/media';

const keywordList = (text: string) =>
  text
    .split(/[,\n]/)
    .map((k) => k.trim())
    .filter(Boolean);

const EMPTY = { name: '', url: '', keywords: '', territory: '', note: '' };

/** Media monitoring by public RSS/Atom feeds (docs/adr/0021). */
export const MediaMonitorCard = ({ scope, admin }: { scope: string; admin: boolean }) => {
  const cache = useQueryClient();
  const state = useQuery({
    queryKey: ['media-monitor', scope],
    queryFn: ({ signal }) => requestJson(BASE, MediaMonitorState, { scope, signal }),
  });
  const [form, setForm] = useState(EMPTY);
  const [notice, setNotice] = useState('');
  const refresh = () => cache.invalidateQueries({ queryKey: ['media-monitor', scope] });
  const body = (): MediaFeedIn => ({
    name: form.name,
    url: form.url,
    keywords: keywordList(form.keywords),
    territory: form.territory,
    authorization_note: form.note,
    enabled: true,
  });
  const preview = useMutation({
    mutationFn: () =>
      requestJson(`${BASE}/preview`, MediaFeedPreview, {
        scope,
        method: 'POST',
        body: { json: { url: form.url, keywords: keywordList(form.keywords) } },
      }),
  });
  const add = useMutation({
    mutationFn: () => request(`${BASE}/feeds`, { scope, method: 'POST', body: { json: body() } }),
    onSuccess: async () => {
      setForm(EMPTY);
      preview.reset();
      setNotice('Fuente agregada.');
      await refresh();
    },
  });
  const change = useMutation({
    mutationFn: ({ feed, enabled }: { feed: MediaFeed; enabled: boolean }) =>
      request(`${BASE}/feeds/${feed.id}`, {
        scope,
        method: 'PUT',
        body: {
          json: {
            name: feed.name,
            url: feed.url,
            keywords: feed.keywords,
            territory: feed.territory,
            authorization_note: feed.authorization_note,
            enabled,
          },
        },
      }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (feed: MediaFeed) =>
      request(`${BASE}/feeds/${feed.id}`, { scope, method: 'DELETE' }),
    onSuccess: refresh,
  });
  const poll = useMutation({
    mutationFn: () =>
      requestJson(`${BASE}/poll`, MediaPollReport, { scope, method: 'POST', body: { json: {} } }),
    onSuccess: async (report) => {
      setNotice(
        `Consulta terminada: ${report.imported} narrativas nuevas, ${report.duplicates} ya registradas, ${report.errors} fuentes con error.`,
      );
      await refresh();
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setNotice('');
    add.mutate();
  };
  const failed = [add, change, remove, poll].find((m) => m.isError);
  return (
    <Card eyebrow="Monitoreo de medios" title="Fuentes RSS regionales">
      <p>
        SIPGES consulta cada fuente cada 30 minutos y crea una narrativa por cada noticia nueva que
        menciona alguna palabra clave (o todas, si no hay palabras clave). Las reglas de
        automatización, incluida «evaluar narrativa», se aplican a cada una. Solo fuentes públicas
        con https, sin cuentas ni servicios pagos.
      </p>
      <QueryState query={state} label="las fuentes de monitoreo">
        {(data) => (
          <>
            {data.feeds.length ? (
              <ul className={styles.feeds} aria-label="Fuentes registradas">
                {data.feeds.map((feed) => (
                  <li key={feed.id} className={styles.feed}>
                    <strong>
                      {feed.name}
                      {feed.enabled ? '' : ' (pausada)'}
                    </strong>
                    <span className={styles.muted}>{feed.url}</span>
                    <span>
                      Palabras clave:{' '}
                      {feed.keywords.length ? feed.keywords.join(', ') : 'todas las noticias'}
                      {feed.territory ? ` · Territorio: ${feed.territory}` : ''}
                    </span>
                    <span className={feed.last_poll_error ? styles.error : styles.muted}>
                      {feed.last_poll_at
                        ? `Última consulta ${formatDateTime(new Date(feed.last_poll_at))}: ${
                            feed.last_poll_error ||
                            `${feed.last_matched} coincidencias, ${feed.last_imported} nuevas`
                          }`
                        : 'Aún no consultada.'}
                    </span>
                    {admin ? (
                      <div className={styles.actions}>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={change.isPending}
                          onClick={() => change.mutate({ feed, enabled: !feed.enabled })}
                        >
                          {feed.enabled ? `Pausar ${feed.name}` : `Reanudar ${feed.name}`}
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={remove.isPending}
                          onClick={() => remove.mutate(feed)}
                        >
                          Eliminar {feed.name}
                        </Button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className={styles.muted}>Aún no hay fuentes registradas.</p>
            )}
            {admin && data.feeds.length ? (
              <Button
                variant="secondary"
                disabled={poll.isPending}
                onClick={() => {
                  setNotice('');
                  poll.mutate();
                }}
              >
                Consultar ahora
              </Button>
            ) : null}
            {admin && data.feeds.length < data.max_feeds ? (
              <form className={styles.form} onSubmit={submit} aria-label="Agregar fuente">
                <Field
                  label="Nombre de la fuente"
                  required
                  maxLength={120}
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
                <Field
                  label="URL del RSS o Atom"
                  type="url"
                  required
                  maxLength={500}
                  placeholder="https://"
                  value={form.url}
                  onChange={(e) => setForm({ ...form, url: e.target.value })}
                />
                <Field
                  label="Palabras clave (separadas por comas)"
                  hint="Vacío: todas las noticias de la fuente."
                  value={form.keywords}
                  onChange={(e) => setForm({ ...form, keywords: e.target.value })}
                />
                <Field
                  label="Territorio (opcional)"
                  maxLength={200}
                  value={form.territory}
                  onChange={(e) => setForm({ ...form, territory: e.target.value })}
                />
                <label className={styles.textarea}>
                  Nota de autorización
                  <textarea
                    required
                    maxLength={1000}
                    value={form.note}
                    onChange={(e) => setForm({ ...form, note: e.target.value })}
                  />
                </label>
                <div className={styles.actions}>
                  <Button
                    variant="secondary"
                    disabled={!form.url || preview.isPending}
                    onClick={() => preview.mutate()}
                  >
                    Probar fuente
                  </Button>
                  <Button type="submit" disabled={add.isPending}>
                    Agregar fuente
                  </Button>
                </div>
              </form>
            ) : null}
            {preview.isError ? <Alert tone="error">{errorDetail(preview.error)}</Alert> : null}
            {preview.data ? (
              <div aria-label="Vista previa de la fuente">
                <p>
                  {preview.data.total} noticias leídas;{' '}
                  {preview.data.items.filter((i) => i.matched.length).length} coinciden con las
                  palabras clave.
                </p>
                <ul>
                  {preview.data.items.map((item) => (
                    <li key={item.link}>
                      <a href={item.link} target="_blank" rel="noreferrer noopener">
                        {item.title}
                      </a>
                      {item.matched.length ? ` · ${item.matched.join(', ')}` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        )}
      </QueryState>
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {failed ? <Alert tone="error">{errorDetail(failed.error)}</Alert> : null}
    </Card>
  );
};
