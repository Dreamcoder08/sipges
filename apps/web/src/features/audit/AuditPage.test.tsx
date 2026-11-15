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
      expect(request.headers.get('X-SIPGES-Scope')).toBe('ACME/P1');
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

// functional-10 T1 (F2): an operation at 22:33 in Lima on the 14th reads the 14th, not the UTC 15th.
it('shows each operation in Lima time under a column that says so', async () => {
  server.use(
    http.get('*/system/audit', () =>
      HttpResponse.json([
        {
          id: 3,
          ts: '2026-11-15T03:33:35Z',
          module: 'eventos',
          record_id: 'EV9',
          action: 'create',
          detail: 'Hecho sintético nocturno',
        },
      ]),
    ),
  );
  renderPage();
  const row = (await screen.findByText('Hecho sintético nocturno')).closest('tr') as HTMLElement;
  expect(screen.getByRole('columnheader', { name: 'Fecha y hora (Lima)' })).toBeInTheDocument();
  expect(screen.queryByRole('columnheader', { name: 'Fecha UTC' })).toBeNull();
  const time = row.querySelector('time');
  expect(time).toHaveTextContent('14 nov. 2026, 22:33');
  expect(time).toHaveAttribute('datetime', '2026-11-15T03:33:35Z');
  expect(row).not.toHaveTextContent('2026-11-15T03:33:35Z');
});
