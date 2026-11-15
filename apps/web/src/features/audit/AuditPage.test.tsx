import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
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

// functional-10 T3 (F9): the action and the module read in Spanish; the stored values stay
// searchable so a filter typed from an export still finds its row.
it('names each action and module in Spanish and searches by either form', async () => {
  const user = userEvent.setup();
  server.use(
    http.get('*/system/audit', () =>
      HttpResponse.json([
        {
          id: 4,
          ts: '2026-11-14T15:00:00Z',
          module: 'Directorio_Territorial',
          record_id: 'DT-1',
          action: 'CREATE',
          detail: 'Alta sintética',
        },
        {
          id: 5,
          ts: '2026-11-14T14:00:00Z',
          module: 'IRSA',
          record_id: null,
          action: 'CONFIG_UPDATE',
          detail: 'Pesos sintéticos',
        },
        {
          id: 6,
          ts: '2026-11-14T13:00:00Z',
          module: 'Eventos',
          record_id: 'EV-2',
          action: 'NUEVA_ACCION',
          detail: 'Acción sin nombre conocido',
        },
      ]),
    ),
  );
  renderPage();
  const created = (await screen.findByText('Alta sintética')).closest('tr') as HTMLElement;
  expect(created).toHaveTextContent('Directorio territorial');
  expect(created).toHaveTextContent('Creación');
  expect(created).not.toHaveTextContent('CREATE');
  const config = screen.getByText('Pesos sintéticos').closest('tr') as HTMLElement;
  expect(config).toHaveTextContent('Cambio de configuración');
  const unknown = screen.getByText('Acción sin nombre conocido').closest('tr') as HTMLElement;
  expect(unknown).toHaveTextContent('Nueva accion');
  expect(unknown).not.toHaveTextContent('NUEVA_ACCION');
  await user.type(screen.getByLabelText('Buscar en auditoría'), 'creación');
  expect(screen.getByText('Alta sintética')).toBeInTheDocument();
  expect(screen.queryByText('Pesos sintéticos')).toBeNull();
  await user.clear(screen.getByLabelText('Buscar en auditoría'));
  await user.type(screen.getByLabelText('Buscar en auditoría'), 'CONFIG_UPDATE');
  expect(screen.getByText('Pesos sintéticos')).toBeInTheDocument();
  expect(screen.queryByText('Alta sintética')).toBeNull();
});

// functional-10 T13 (F30, F31): on a phone each operation becomes a card of labelled rows (the
// Registros pattern), so every cell carries its column name; the count agrees with one.
it('labels every cell with its column for the phone cards and counts one operation in the singular', async () => {
  server.use(
    http.get('*/system/audit', () =>
      HttpResponse.json([
        {
          id: 1,
          ts: '2026-11-15T16:21:00Z',
          module: 'automatizaciones',
          record_id: 'EV-1B5151999',
          action: 'create',
          detail: 'Registro creado en SIPGES',
        },
      ]),
    ),
  );
  renderPage();
  const table = await screen.findByRole('table', { name: /Registro de operaciones/ });
  await within(table).findByText('Registro creado en SIPGES');
  const headers = within(table)
    .getAllByRole('columnheader')
    .map((header) => header.textContent);
  const cells = within(table).getAllByRole('cell');
  expect(cells.map((cell) => cell.getAttribute('data-label'))).toEqual(headers);
  expect(screen.getByText(/de 1 registro/)).toHaveTextContent('1 de 1 registro cargado.');
});

// functional-10 T13 (CI follow-up): a long unspaced detail (a rule name) can make the table wider
// than a tablet; its scroll box must then be reachable and named for the keyboard (axe
// scrollable-region-focusable on WebKit at 930 px).
it('wraps the table in a focusable, named region so a wide table scrolls from the keyboard', async () => {
  server.use(
    http.get('*/system/audit', () =>
      HttpResponse.json([
        {
          id: 1,
          ts: '2026-11-15T16:21:00Z',
          module: 'Automatizaciones',
          record_id: '7',
          action: 'CREATE',
          detail: 'Regla «ReglaSintéticaSinEspaciosQueNoCabeEnUnaTarjeta» activa',
        },
      ]),
    ),
  );
  renderPage();
  const table = await screen.findByRole('table', { name: /Registro de operaciones/ });
  const region = screen.getByRole('region', { name: 'Tabla de auditoría' });
  expect(region).toContainElement(table);
  expect(region).toHaveAttribute('tabindex', '0');
});
