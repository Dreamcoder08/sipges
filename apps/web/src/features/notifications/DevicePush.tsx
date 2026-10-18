import { PushConfig } from '@mascli/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { z } from 'zod';
import { requestJson } from '../../shared/api/client.ts';
import styles from './NotificationBell.module.css';

const Ok = z.object({ ok: z.literal(true) });

/** The browser APIs device notifications need; absent in older browsers and in tests. */
const supported = () =>
  typeof navigator !== 'undefined' &&
  'serviceWorker' in navigator &&
  typeof window.PushManager !== 'undefined' &&
  typeof window.Notification !== 'undefined';

const keyBytes = (base64url: string) => {
  const text = atob(base64url.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(text, (ch) => ch.charCodeAt(0));
};

const currentSubscription = async () => {
  const registration = await navigator.serviceWorker.getRegistration();
  return (await registration?.pushManager.getSubscription()) ?? null;
};

/**
 * Opt-in switch for notifications on this device (ADR 0014). The server only learns the
 * browser's push endpoint and keys; the setting follows the person, not the project.
 */
export const DevicePush = ({ scope }: { scope: string }) => {
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const config = useQuery({
    queryKey: ['push-config'],
    queryFn: ({ signal }) =>
      requestJson('/system/notifications/push', PushConfig, { scope, signal }),
    enabled: supported(),
    staleTime: Infinity,
  });
  const subscription = useQuery({
    queryKey: ['push-subscription'],
    queryFn: currentSubscription,
    enabled: supported() && config.data?.enabled === true,
  });
  const guidance = (
    <p>
      En iPhone o iPad (iOS 16.4 o posterior), añade MASCLI a la pantalla de inicio desde Compartir
      y ábrelo desde allí. En Android, permite las notificaciones del sitio.{' '}
      <a
        href="https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/"
        target="_blank"
        rel="noreferrer"
      >
        Guía de WebKit
      </a>
    </p>
  );
  if (!supported())
    return (
      <div className={styles.device}>
        <p>Este navegador no ofrece notificaciones push.</p>
        {guidance}
      </div>
    );
  if (config.isError) return <p role="alert">No se pudo consultar la configuración de avisos.</p>;
  if (config.data && !config.data.enabled)
    return <p>Los avisos push no están configurados. La bandeja sigue disponible.</p>;
  if (!config.data?.public_key || subscription.isPending)
    return <p>Consultando suscripción del dispositivo…</p>;
  if (subscription.isError)
    return <p role="alert">No se pudo consultar la suscripción de este dispositivo.</p>;
  const publicKey = config.data.public_key;
  const active = subscription.data !== null;

  const toggle = async () => {
    setBusy(true);
    setMessage(null);
    try {
      if (active && subscription.data) {
        const { endpoint } = subscription.data;
        await subscription.data.unsubscribe();
        await requestJson('/system/notifications/push/unsubscribe', Ok, {
          scope,
          method: 'POST',
          body: { json: { endpoint } },
        });
        setMessage('Este dispositivo ya no recibirá avisos.');
      } else {
        if ((await Notification.requestPermission()) !== 'granted') {
          setMessage('El navegador bloqueó los avisos. Permítelos en la configuración del sitio.');
          return;
        }
        const registration = await navigator.serviceWorker.ready;
        const created = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: keyBytes(publicKey),
        });
        await requestJson('/system/notifications/push', Ok, {
          scope,
          method: 'POST',
          body: { json: created.toJSON() },
        });
        setMessage(
          'Suscripción guardada. Usa la prueba y confirma la recepción en este dispositivo.',
        );
      }
    } catch {
      setMessage('No se pudo cambiar la suscripción de este dispositivo.');
    } finally {
      setBusy(false);
      await subscription.refetch();
    }
  };

  return (
    <div className={styles.device}>
      <label>
        <input type="checkbox" checked={active} disabled={busy} onChange={() => void toggle()} />{' '}
        Recibir avisos en este dispositivo
      </label>
      {active && (
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const result = await requestJson(
                '/system/notifications/push/test',
                z.object({ status: z.string(), accepted: z.number(), detail: z.string() }),
                { scope, method: 'POST' },
              );
              setMessage(result.detail);
            } catch {
              setMessage('La prueba falló. Revisa tu conexión y suscripción.');
            } finally {
              setBusy(false);
            }
          }}
        >
          Probar solo mis dispositivos
        </button>
      )}
      {guidance}
      {message && <p role="status">{message}</p>}
    </div>
  );
};
