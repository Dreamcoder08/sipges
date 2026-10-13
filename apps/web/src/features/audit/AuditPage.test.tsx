import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { server } from '../../test/server.ts';
import { AuditPage } from './AuditPage.tsx';
const context = {
  scope: 'ACME/P1',
  projectId: 'P1',
  projectLabel: 'Proyecto Uno',
  role: 'admin' as const,
  username: 'admin',
  fullName: 'Admin Demo',
};
const renderPage = (role: 'admin' | 'consulta' = 'admin') =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <AuditPage {...context} role={role} />
    </QueryClientProvider>,
  );
it('loads active tenant audit and filters detail/module/action locally', async () => {
  const user = userEvent.setup();
  server.use(
    http.get('*/system/audit', ({ request }) => {
      expect(request.headers.get('X-MASCLI-Scope')).toBe('ACME/P1');
      return HttpResponse.json([
        {
          id: 1,
          ts: '2026-10-13T12:00:00Z',
          module: 'eventos',
          record_id: 'EV1',
          action: 'create',
          detail: 'Incidente sintético',
        },
        {
          id: 2,
          ts: '2026-10-13T11:00:00Z',
          module: 'actores',
          record_id: 'AC1',
          action: 'update',
          detail: null,
        },
      ]);
    }),
  );
  renderPage();
  await screen.findByText('Incidente sintético');
  await user.type(screen.getByLabelText('Buscar en auditoría'), 'incident');
  expect(screen.getByText('Incidente sintético')).toBeInTheDocument();
  expect(screen.queryByText('AC1')).not.toBeInTheDocument();
});
it('does not request audit for non-admin users', async () => {
  let calls = 0;
  server.use(
    http.get('*/system/audit', () => {
      calls++;
      return HttpResponse.json([]);
    }),
  );
  renderPage('consulta');
  expect(screen.getByText(/Auditoría restringida/)).toBeInTheDocument();
  expect(calls).toBe(0);
});
it('shows server refusal without retaining rows', async () => {
  server.use(
    http.get('*/system/audit', () =>
      HttpResponse.json({ detail: 'Requiere rol administrador' }, { status: 403 }),
    ),
  );
  renderPage();
  expect(await screen.findByRole('alert')).toHaveTextContent('Requiere rol administrador');
});
