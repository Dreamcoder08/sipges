import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, expect, it, vi } from 'vitest';
import { server } from '../../test/server.ts';
import { DevicePush } from './DevicePush.tsx';

const renderSwitch = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <DevicePush scope="ACME/P1" />
    </QueryClientProvider>,
  );

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/synthetic';

/** A fake browser push stack: one registration whose subscription the test can inspect. */
const stubBrowser = (permission: NotificationPermission) => {
  let current: {
    endpoint: string;
    unsubscribe: () => Promise<boolean>;
    toJSON: () => unknown;
  } | null = null;
  const subscribe = vi.fn(async () => {
    current = {
      endpoint: ENDPOINT,
      unsubscribe: async () => {
        current = null;
        return true;
      },
      toJSON: () => ({ endpoint: ENDPOINT, keys: { p256dh: 'BPk', auth: 'au' } }),
    };
    return current;
  });
  const registration = { pushManager: { subscribe, getSubscription: async () => current } };
  vi.stubGlobal('PushManager', function PushManager() {});
  vi.stubGlobal('Notification', { requestPermission: async () => permission });
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { ready: Promise.resolve(registration), getRegistration: async () => registration },
  });
  return { subscribe };
};

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'serviceWorker');
});

const enabled = () =>
  http.get('*/system/notifications/push', () =>
    HttpResponse.json({ enabled: true, public_key: 'AQID' }),
  );

it('subscribes this device with the server key and unsubscribes it again', async () => {
  const user = userEvent.setup();
  const { subscribe } = stubBrowser('granted');
  const posted: { path: string; body: unknown }[] = [];
  server.use(
    enabled(),
    http.post('*/system/notifications/push*', async ({ request }) => {
      posted.push({ path: new URL(request.url).pathname, body: await request.json() });
      return HttpResponse.json({ ok: true });
    }),
  );
  renderSwitch();
  const toggle = await screen.findByRole('checkbox', {
    name: 'Recibir avisos en este dispositivo',
  });
  expect(toggle).not.toBeChecked();

  await user.click(toggle);
  expect(
    await screen.findByText(
      'Suscripción guardada. Usa la prueba y confirma la recepción en este dispositivo.',
    ),
  ).toBeInTheDocument();
  expect(subscribe).toHaveBeenCalledWith({
    userVisibleOnly: true,
    applicationServerKey: Uint8Array.of(1, 2, 3),
  });
  expect(posted[0]).toEqual({
    path: '/system/notifications/push',
    body: { endpoint: ENDPOINT, keys: { p256dh: 'BPk', auth: 'au' } },
  });
  await vi.waitFor(() => expect(toggle).toBeChecked());

  await user.click(toggle);
  expect(await screen.findByText('Este dispositivo ya no recibirá avisos.')).toBeInTheDocument();
  expect(posted[1]).toEqual({
    path: '/system/notifications/push/unsubscribe',
    body: { endpoint: ENDPOINT },
  });
  await vi.waitFor(() => expect(toggle).not.toBeChecked());
});

it('explains a blocked permission without subscribing', async () => {
  const user = userEvent.setup();
  const { subscribe } = stubBrowser('denied');
  server.use(enabled());
  renderSwitch();
  await user.click(await screen.findByRole('checkbox'));
  expect(await screen.findByText(/El navegador bloqueó los avisos/)).toBeInTheDocument();
  expect(subscribe).not.toHaveBeenCalled();
});

it('stays hidden when the server has no push keys or the browser lacks push', async () => {
  let calls = 0;
  let respond: () => void = () => undefined;
  const responseReady = new Promise<void>((resolve) => {
    respond = resolve;
  });
  server.use(
    http.get('*/system/notifications/push', async () => {
      calls++;
      await responseReady;
      return HttpResponse.json({ enabled: false, public_key: null });
    }),
  );
  renderSwitch();
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  expect(calls).toBe(0);

  stubBrowser('granted');
  const { container } = renderSwitch();
  await vi.waitFor(() => expect(calls).toBe(1));
  respond();
  await waitFor(() => expect(container).toHaveTextContent(/Los avisos push no están configurados/));
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  expect(calls).toBe(1);
});
