import { NotificationInbox } from '@sipges/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId } from 'react';
import { z } from 'zod';
import { requestJson } from '../../shared/api/client.ts';
import { InternalLink, objectHref } from '../../shared/lib/navigation.tsx';
import styles from './Avisos.module.css';

/** How often the inbox is refreshed while the app is open. */
export const INBOX_REFRESH_MS = 60_000;

/** Where the device push switch lives (Configuración, section Notificaciones). */
export const DEVICE_PUSH_HREF = '/version-4?seccion=notificaciones';

const Ok = z.object({ ok: z.literal(true) });

const when = (iso: string) =>
  new Date(iso).toLocaleString('es-PE', { dateStyle: 'short', timeStyle: 'short' });

/** The person's inbox for the active project, refreshed while the app is open. */
const inboxQuery = (scope: string) => ({
  queryKey: ['notifications', scope],
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    requestJson('/system/notifications?limit=30', NotificationInbox, { scope, signal }),
  refetchInterval: INBOX_REFRESH_MS,
});

/** Unread avisos, for the counts the shell shows (Bandeja link, phone menu button). */
export const useUnreadNotifications = (scope: string): number =>
  useQuery(inboxQuery(scope)).data?.unread ?? 0;

/**
 * «Avisos», the Bandeja tab with the automation notifications (ADR 0014, functional-closure
 * S9): the list, its read state per person and "mark all as read". Receiving them on this
 * device is switched on in Configuración, so the switch is not repeated here.
 */
export const AvisosPanel = ({ scope }: { scope: string }) => {
  const client = useQueryClient();
  const heading = useId();
  const inbox = useQuery(inboxQuery(scope));
  const markAll = useMutation({
    mutationFn: () =>
      requestJson('/system/notifications/read', Ok, {
        scope,
        method: 'POST',
        body: { json: { all: true } },
      }),
    onSettled: () => client.invalidateQueries({ queryKey: ['notifications', scope] }),
  });
  const unread = inbox.data?.unread ?? 0;
  return (
    <section className={styles.panel} aria-labelledby={heading}>
      <div className={styles.header}>
        <h2 id={heading}>Avisos</h2>
        {inbox.data ? (
          <span className={styles.count}>{unread > 0 ? `${unread} sin leer` : 'Todo leído'}</span>
        ) : null}
        <button
          type="button"
          className={styles.link}
          disabled={unread === 0 || markAll.isPending}
          onClick={() => markAll.mutate()}
        >
          Marcar todo como leído
        </button>
      </div>
      {inbox.error ? (
        <p role="alert">No se pudieron cargar los avisos.</p>
      ) : !inbox.data ? (
        <p role="status">Cargando…</p>
      ) : inbox.data.items.length === 0 ? (
        <p className={styles.empty}>Sin avisos. Las automatizaciones publican aquí sus avisos.</p>
      ) : (
        <ul className={styles.list}>
          {inbox.data.items.map((item) => (
            <li key={item.id} className={item.read ? styles.read : styles.unread}>
              {item.href || item.link ? (
                <InternalLink
                  href={item.href ?? (item.link ? objectHref(item.link.module, item.link.id) : '/')}
                >
                  {item.title}
                </InternalLink>
              ) : (
                <span>{item.title}</span>
              )}
              {item.body && <p>{item.body}</p>}
              <small>
                {when(item.created_at)}
                {item.read ? '' : ' · nuevo'}
              </small>
            </li>
          ))}
        </ul>
      )}
      <p className={styles.empty}>
        Para recibirlos también en este dispositivo, actívalos en{' '}
        <InternalLink href={DEVICE_PUSH_HREF}>Configuración › Notificaciones</InternalLink>.
      </p>
    </section>
  );
};
