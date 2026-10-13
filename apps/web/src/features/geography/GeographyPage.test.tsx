import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import coordinates from '../../../../../data/project_coordinates.json';
import { server } from '../../test/server.ts';
import { GeographyPage } from './GeographyPage.tsx';
const renderPage = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <GeographyPage
        scope="MASCLI/PRJ-SECHURA"
        projectId="PRJ-SECHURA"
        projectLabel="Sechura"
        role="consulta"
        username="reader"
        fullName="Reader"
      />
    </QueryClientProvider>,
  );
it('renders scoped geometry, lets the reader select and zoom, and shows its provenance', async () => {
  let scope: string | null = null;
  server.use(
    http.get('/system/project-coordinates', ({ request }) => {
      scope = request.headers.get('X-MASCLI-Scope');
      return HttpResponse.json({
        available: true,
        data: coordinates,
        notice: coordinates.source.scope,
      });
    }),
  );
  renderPage();
  expect(await screen.findByText('GeoCatMin')).toBeVisible();
  expect(scope).toBe('MASCLI/PRJ-SECHURA');
  const map = screen.getByLabelText('Geometría de referencia');
  const before = map.getAttribute('viewBox');
  await userEvent.click(screen.getByRole('button', { name: 'Acercar' }));
  expect(map.getAttribute('viewBox')).not.toBe(before);
  await userEvent.selectOptions(screen.getByLabelText('Concesión'), '12000442Y01');
  expect(screen.getByRole('heading', { name: 'BAYOVAR N° 6' })).toBeVisible();
  expect(screen.getByText('EPSG:4326')).toBeVisible();
});
it('does not draw Sechura geometry when the scope has no registered reference', async () => {
  server.use(
    http.get('/system/project-coordinates', () =>
      HttpResponse.json({ available: false, data: null, notice: 'No hay geometría registrada.' }),
    ),
  );
  renderPage();
  expect(await screen.findByText('No hay geometría registrada.')).toBeVisible();
  expect(screen.queryByLabelText('Geometría de referencia')).toBeNull();
});
