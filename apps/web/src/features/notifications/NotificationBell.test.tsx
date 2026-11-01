import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { server } from '../../test/server.ts';
import { NotificationBell } from './NotificationBell.tsx';

const renderBell = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <NotificationBell scope="ACME/P1" />
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
  renderBell();
  expect(await screen.findByRole('button', { name: 'Notificaciones 2 sin leer' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: /Notificaciones/ }));
  const panel = screen.getByRole('region', { name: 'Notificaciones' });
  expect(
    within(panel).getByRole('link', { name: 'Alerta AL-1: bloqueo sintético' }),
  ).toHaveAttribute('href', '/objeto/alertas/AL-1');
  await user.click(within(panel).getByRole('button', { name: 'Marcar todo como leído' }));
  expect(marked).toEqual({ all: true });
  expect(await screen.findByRole('button', { name: 'Notificaciones' })).toBeVisible();
});

it('explains an empty inbox', async () => {
  const user = userEvent.setup();
  server.use(http.get('*/system/notifications', () => HttpResponse.json({ unread: 0, items: [] })));
  renderBell();
  await user.click(screen.getByRole('button', { name: /Notificaciones/ }));
  expect(await screen.findByText(/Sin notificaciones/)).toBeInTheDocument();
});
