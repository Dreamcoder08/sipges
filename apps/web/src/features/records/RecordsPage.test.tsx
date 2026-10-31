import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { server } from '../../test/server.ts';
import { RecordsPage } from './RecordsPage.tsx';

const renderDemandas = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <RecordsPage
        module="demandas"
        scope="ACME/P1"
        projectId="P1"
        projectLabel="Proyecto Uno"
        role="admin"
      />
    </QueryClientProvider>,
  );

it('shows each request with its priority, derived progress and status in the table', async () => {
  server.use(
    http.get('*/api/demandas', ({ request }) => {
      const offset = new URL(request.url).searchParams.get('offset');
      return HttpResponse.json(
        offset === '0'
          ? [
              {
                _id: 'D-1',
                Fecha_Registro: '2026-09-19',
                Descripcion: 'Demanda sintética nueva',
                'Actor/Grupo': 'Grupo sintético A',
                Prioridad: 'Alta',
                Estado: 'Nueva',
              },
              {
                _id: 'D-2',
                Fecha_Registro: '2026-09-20',
                Descripcion: 'Demanda sintética en diálogo',
                'Actor/Grupo': 'Grupo sintético B',
                Prioridad: 'Media',
                Estado: 'En diálogo',
              },
            ]
          : [],
      );
    }),
  );
  renderDemandas();
  const table = await screen.findByRole('table');
  expect(
    within(table)
      .getAllByRole('columnheader')
      .map((header) => header.textContent),
  ).toEqual([
    'Fecha de registro',
    'Descripción',
    'Actor o grupo',
    'Prioridad',
    'Avance',
    'Estado',
    'Acciones',
  ]);
  const [, first, second] = within(table).getAllByRole('row');
  expect(within(first as HTMLElement).getByRole('progressbar')).toHaveAttribute(
    'aria-valuenow',
    '0',
  );
  expect(within(second as HTMLElement).getByRole('progressbar')).toHaveAttribute(
    'aria-valuenow',
    '50',
  );
  expect(within(second as HTMLElement).getByText('50%')).toBeInTheDocument();
  expect(within(second as HTMLElement).getByText('En diálogo')).toHaveAttribute(
    'data-tone',
    'info',
  );
});
