import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { server } from '../../test/server.ts';
import { ImportPanel, suggestMapping } from './ImportPanel.tsx';

it('suggests fields by key, label or alias, ignoring accents and case', () => {
  expect(
    suggestMapping('actores', ['NOMBRE DEL ACTOR U ORGANIZACIÓN', 'Tipo_Actor', 'Columna rara']),
  ).toEqual(['Nombre_Actor/Organizacion', 'Tipo_Actor', '']);
});

it('maps columns, previews and imports a CSV file', async () => {
  const bodies: unknown[] = [];
  server.use(
    http.post('/system/import/actores', async ({ request }) => {
      const body = (await request.json()) as { dry_run: boolean };
      bodies.push(body);
      return HttpResponse.json({
        applied: !body.dry_run,
        created: 1,
        updated: 1,
        problems: [],
      });
    }),
  );
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ImportPanel module="actores" scope="A/B" onClose={() => undefined} />
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  const csv =
    'Nombre del actor u organización;Tipo_Actor;Notas\nComunidad Norte;Comunal;x\nFrente;;y\n';
  await user.upload(
    screen.getByLabelText(/Archivo CSV/),
    new File([csv], 'actores.csv', { type: 'text/csv' }),
  );
  expect(await screen.findByText(/2 filas en/)).toBeVisible();
  expect(screen.getByRole('button', { name: 'Importar' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Revisar importación' }));
  expect(await screen.findByText(/Listo para importar/)).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Importar' }));
  expect(await screen.findByText(/Importación completada/)).toBeVisible();
  await waitFor(() => expect(bodies).toHaveLength(2));
  expect(bodies[0]).toEqual({
    rows: [
      { 'Nombre_Actor/Organizacion': 'Comunidad Norte', Tipo_Actor: 'Comunal' },
      { 'Nombre_Actor/Organizacion': 'Frente', Tipo_Actor: '' },
    ],
    dry_run: true,
    source: 'actores.csv',
  });
  expect(bodies[1]).toMatchObject({ dry_run: false });
});

it('shows rejected rows from a refused batch', async () => {
  server.use(
    http.post('/system/import/actores', () =>
      HttpResponse.json(
        { applied: false, created: 0, updated: 0, problems: [{ row: 2, message: 'Duplicado' }] },
        { status: 200 },
      ),
    ),
  );
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ImportPanel module="actores" scope="A/B" onClose={() => undefined} />
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  await user.upload(
    screen.getByLabelText(/Archivo CSV/),
    new File(['Tipo_Actor\nComunal\n'], 'a.csv', { type: 'text/csv' }),
  );
  await user.click(await screen.findByRole('button', { name: 'Revisar importación' }));
  expect(await screen.findByText('Fila 2: Duplicado')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Importar' })).toBeDisabled();
});
