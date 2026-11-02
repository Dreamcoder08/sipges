import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { server } from '../../test/server.ts';
import { AvisosPanel } from './AvisosPanel.tsx';

const renderAvisos = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <AvisosPanel scope="ACME/P1" />
    </QueryClientProvider>,
  );

it('shows the unread count, links to the record and marks everything read', async () => {
  const user = userEvent.setup();
  let unread = 2;
  let marked: unknown = null;
  server.use(
    http.get('*/system/notifications', ({ request }) => {
      expect(request.headers.get('X-SIPGES-Scope')).toBe('ACME/P1');
      return HttpResponse.json({
        unread,
        items: [
          {
            id: 2,
            title: 'Alerta AL-1: bloqueo sintético',
            body: 'CREATE en Alertas AL-1',
            module: 'Alertas',
            record_id: 'AL-1',
            link: { module: 'alertas', id: 'AL-1' },
            created_at: '2026-10-14T10:00:00Z',
            read: unread === 0,
          },
          {
            id: 1,
            title: 'Corte IRSA',
            body: '',
            module: 'IRSA',
            record_id: null,
            link: null,
            created_at: '2026-10-14T09:00:00Z',
            read: unread === 0,
          },
        ],
      });
    }),
    http.post('*/system/notifications/read', async ({ request }) => {
      marked = await request.json();
      unread = 0;
      return HttpResponse.json({ ok: true });
    }),
  );
  renderAvisos();
  const panel = screen.getByRole('region', { name: 'Avisos' });
  expect(await within(panel).findByText('2 sin leer')).toBeVisible();
  expect(
    within(panel).getByRole('link', { name: 'Alerta AL-1: bloqueo sintético' }),
  ).toHaveAttribute('href', '/objeto/alertas/AL-1');
  expect(within(panel).getByText('Corte IRSA')).toBeVisible();
  await user.click(within(panel).getByRole('button', { name: 'Marcar todo como leído' }));
  expect(marked).toEqual({ all: true });
  expect(await within(panel).findByText('Todo leído')).toBeVisible();
  expect(within(panel).getByRole('button', { name: 'Marcar todo como leído' })).toBeDisabled();
});

it('explains an empty inbox and where device notifications are switched on', async () => {
  server.use(http.get('*/system/notifications', () => HttpResponse.json({ unread: 0, items: [] })));
  renderAvisos();
  expect(await screen.findByText(/Sin avisos/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Configuración › Notificaciones' })).toHaveAttribute(
    'href',
    '/version-4?seccion=notificaciones',
  );
  // The device push switch lives in Configuración only, not twice.
  expect(screen.queryByText(/notificaciones push/)).toBeNull();
});

it('says when the inbox cannot be loaded', async () => {
  server.use(http.get('*/system/notifications', () => new HttpResponse(null, { status: 500 })));
  renderAvisos();
  expect(await screen.findByRole('alert')).toHaveTextContent('No se pudieron cargar los avisos.');
});
