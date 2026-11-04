import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import userEvent from '@testing-library/user-event';
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

it('separates named actors from preserved documentary mentions without claiming verification', async () => {
  const user = userEvent.setup();
  const actors = [
    {
      _id: 'A-NAMED',
      'Nombre_Actor/Organizacion': 'Organización sintética',
      Revision_Documental_ID: 'R1',
    },
    {
      _id: 'A-PENDING',
      'Nombre_Actor/Organizacion': 'Por identificar (fuente sintética.pdf)',
      Revision_Documental_ID: 'R2',
      'Rol/Relacion': 'Fragmento sintético incompleto',
      Fuente_ID: 'fuente sintética.pdf · Página 2',
    },
  ];
  server.use(
    http.get('*/api/actores', ({ request }) =>
      HttpResponse.json(new URL(request.url).searchParams.get('offset') === '0' ? actors : []),
    ),
  );
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <RecordsPage
        module="actores"
        scope="ACME/P1"
        projectId="P1"
        projectLabel="Proyecto Uno"
        role="admin"
      />
    </QueryClientProvider>,
  );
  const table = await screen.findByRole('table');
  expect(within(table).getByText('Organización sintética')).toBeInTheDocument();
  expect(
    within(table).queryByText('Por identificar (fuente sintética.pdf)'),
  ).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Padrón con nombre (1)' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await user.click(screen.getByRole('button', { name: 'Menciones pendientes (1)' }));
  expect(
    within(screen.getByRole('table')).getByText('Fragmento sintético incompleto'),
  ).toBeInTheDocument();
  expect(
    within(screen.getByRole('table')).queryByText('Organización sintética'),
  ).not.toBeInTheDocument();
  expect(screen.queryByText('Mapa estratégico de actores')).not.toBeInTheDocument();
  expect(screen.getByText(/no implica identidad corroborada/i)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Padrón con nombre (1)' }));
  expect(within(screen.getByRole('table')).getByText('Organización sintética')).toBeInTheDocument();
  expect(actors[1]?.['Rol/Relacion']).toBe('Fragmento sintético incompleto');
});
