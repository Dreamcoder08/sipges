import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import coordinates from '../../../../../data/project_coordinates.json';
import { server } from '../../test/server.ts';
import { UNITS_PER_DEGREE } from './BaseMap.tsx';
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
// Regression (functional audit, error 06): a selected concession is framed with its real
// geometry, shapes never fall back to the default black fill, and bad geometry is reported.
it('frames the selected concession and draws it with explicit fills', async () => {
  server.use(
    http.get('/system/project-coordinates', () =>
      HttpResponse.json({ available: true, data: coordinates, notice: coordinates.source.scope }),
    ),
  );
  renderPage();
  const map = await screen.findByLabelText('Geometría de referencia');
  const province = map.getAttribute('viewBox');
  await userEvent.selectOptions(screen.getByLabelText('Concesión'), '12000442Y01');
  const framed = (map.getAttribute('viewBox') ?? '').split(' ').map(Number);
  expect(map.getAttribute('viewBox')).not.toBe(province);
  // The view is centred on BAYOVAR N° 6 (lon/−lat space) and smaller than the province.
  const concession = coordinates.concessions.find((c) => c.code === '12000442Y01');
  const [x = 0, y = 0, w = 0, h = 0] = framed.map((v) => v / UNITS_PER_DEGREE);
  expect(concession?.centroid.longitude).toBeGreaterThan(x);
  expect(concession?.centroid.longitude).toBeLessThan(x + w);
  expect(-(concession?.centroid.latitude ?? 0)).toBeGreaterThan(y);
  expect(-(concession?.centroid.latitude ?? 0)).toBeLessThan(y + h);
  const selected = screen.getByRole('button', { name: 'Seleccionar BAYOVAR N° 6' });
  expect(selected).toHaveAttribute('aria-pressed', 'true');
  expect(selected).toHaveAttribute('fill', '#e6b54a');
  for (const path of map.querySelectorAll('path[role="button"]'))
    expect(path.getAttribute('fill')).toMatch(/^#/);
});

it('reports concessions whose geometry cannot be drawn', async () => {
  const broken = structuredClone(coordinates);
  const first = broken.concessions[0];
  if (first) first.geometry.coordinates[0]?.pop();
  server.use(
    http.get('/system/project-coordinates', () =>
      HttpResponse.json({ available: true, data: broken, notice: broken.source.scope }),
    ),
  );
  renderPage();
  expect(await screen.findByText(/No se dibujan 1 concesión/)).toHaveTextContent('anillo abierto');
  expect(screen.queryByRole('button', { name: 'Seleccionar BAYOVAR N° 5' })).toBeNull();
});
