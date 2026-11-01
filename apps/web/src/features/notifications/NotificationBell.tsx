import { NotificationInbox } from '@sipges/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { requestJson } from '../../shared/api/client.ts';
import { InternalLink, objectHref } from '../../shared/lib/navigation.tsx';
import { z } from 'zod';
import { Icon } from '../../shared/ui/Icon.tsx';
import { DevicePush } from './DevicePush.tsx';
import styles from './NotificationBell.module.css';

/** How often the inbox is refreshed while the app is open. */
export const INBOX_REFRESH_MS = 60_000;

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

/** Unread notifications, for a badge outside the inbox (the phone account avatar). */
export const useUnreadNotifications = (scope: string): number =>
  useQuery(inboxQuery(scope)).data?.unread ?? 0;

/** Inbox list with "mark all as read" and the device push switch (ADR 0014). */
export const NotificationList = ({ scope }: { scope: string }) => {
  const client = useQueryClient();
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
    <>
      <div className={styles.header}>
        <strong>Notificaciones</strong>
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
        <p role="alert">No se pudieron cargar las notificaciones.</p>
      ) : !inbox.data ? (
        <p role="status">Cargando…</p>
      ) : inbox.data.items.length === 0 ? (
        <p className={styles.empty}>
          Sin notificaciones. Las automatizaciones publican aquí sus avisos.
        </p>
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
                {item.read ? '' : ' · nueva'}
              </small>
            </li>
          ))}
        </ul>
      )}
      <DevicePush scope={scope} />
    </>
  );
};

/** Top-bar inbox of automation notifications (ADR 0014); read state is per person. */
export const NotificationBell = ({ scope }: { scope: string }) => {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const unread = useUnreadNotifications(scope);

  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent | MouseEvent) => {
      if (
        event instanceof KeyboardEvent
          ? event.key === 'Escape'
          : !root.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener('keydown', close);
    document.addEventListener('mousedown', close);
    return () => {
      document.removeEventListener('keydown', close);
      document.removeEventListener('mousedown', close);
    };
  }, [open]);

  return (
    <div ref={root} className={styles.root}>
      <button
        type="button"
        className={styles.trigger}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="bell" />
        <span className="visually-hidden">Notificaciones</span>
        {unread > 0 && (
          <span className={styles.badge}>
            {unread > 99 ? '99+' : unread}
            <span className="visually-hidden"> sin leer</span>
          </span>
        )}
      </button>
      {open && (
        <div id={panelId} className={styles.panel} role="region" aria-label="Notificaciones">
          <NotificationList scope={scope} />
        </div>
      )}
    </div>
  );
};
