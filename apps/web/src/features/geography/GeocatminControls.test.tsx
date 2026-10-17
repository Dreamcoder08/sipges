import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { useState } from 'react';
import { expect, it } from 'vitest';
import { server } from '../../test/server.ts';
import { GeocatminControls, type OfficialSelection } from './GeocatminControls.tsx';
const base =
  'https://geocatmin.ingemmet.gob.pe/arcgis/rest/services/SERV_CATASTRO_MINERO/MapServer';
const catalogue = {
  status: 'verified',
  checkedAt: '2026-10-17',
  serviceUrl: base,
  attribution: 'INGEMMET',
  services: [{ id: 'SERV_CATASTRO_MINERO', status: 'verified', checkedAt: '2026-10-17' }],
  layers: [
    {
      serviceId: 'SERV_CATASTRO_MINERO',
      id: 0,
      name: 'Derechos sintéticos de prueba',
      minScale: 0,
      maxScale: null,
      capabilities: 'Query,Map',
      attribution: 'INGEMMET',
      exportUrl: `${base}/export`,
      metadataUrl: `${base}/0`,
    },
  ],
};
const Workspace = () => {
  const [selection, onChange] = useState<OfficialSelection[]>([]);
  return (
    <GeocatminControls
      scope="ACME/P1"
      selection={selection}
      onChange={onChange}
      status={{ 'SERV_CATASTRO_MINERO:0': 'error' }}
      polygon={{
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
            [0, 0],
          ],
        ],
      }}
      concessionCode="C1"
    />
  );
};
const renderControls = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <Workspace />
    </QueryClientProvider>,
  );
it('selects layers, controls opacity and queries scoped same-origin geometry with provenance', async () => {
  let requestBody: unknown,
    scope: string | null = null;
  server.use(
    http.get('/system/geography/catalogue', () => HttpResponse.json(catalogue)),
    http.post('/system/geography/query', async ({ request }) => {
      scope = request.headers.get('X-MASCLI-Scope');
      requestBody = await request.json();
      return HttpResponse.json({
        features: [{ attributes: { CODIGOU: 'SYNTHETIC' } }],
        truncated: true,
        source: base,
        related: [
          {
            id: 'E1',
            module: 'Eventos',
            relationship: 'explicit-reference',
            evidence: 'acta sintética',
          },
        ],
        unlocated: [{ id: 'E2', module: 'Eventos', reason: 'Sin geometría válida' }],
      });
    }),
  );
  renderControls();
  await userEvent.click(screen.getByText('Capas oficiales GEOCATMIN y consulta territorial'));
  await userEvent.click(await screen.findByLabelText('Mostrar Derechos sintéticos de prueba'));
  expect(screen.getByLabelText('Opacidad Derechos sintéticos de prueba')).toBeEnabled();
  expect(screen.getByRole('alert')).toHaveTextContent('No se pudo cargar esta capa oficial');
  await userEvent.click(
    screen.getByRole('button', { name: 'Consultar intersecciones de la concesión' }),
  );
  expect(await screen.findByText(/Resultado truncado/)).toBeVisible();
  expect(scope).toBe('ACME/P1');
  expect(requestBody).toMatchObject({
    serviceId: 'SERV_CATASTRO_MINERO',
    layerId: 0,
    concessionCode: 'C1',
    polygon: { type: 'Polygon' },
  });
  expect(screen.getByText(/Referencia explícita documentada/)).toBeVisible();
  expect(screen.getByText(/E2: Sin geometría válida/)).toBeVisible();
});
it('reports unavailable metadata and preserves retry and official escape link', async () => {
  server.use(
    http.get('/system/geography/catalogue', () =>
      HttpResponse.json({ ...catalogue, status: 'unavailable', layers: [], services: [] }),
    ),
  );
  renderControls();
  await userEvent.click(screen.getByText('Capas oficiales GEOCATMIN y consulta territorial'));
  await waitFor(() =>
    expect(screen.getByRole('alert')).toHaveTextContent('No se pudo verificar el catálogo'),
  );
  expect(screen.getByRole('link', { name: 'Abrir visor oficial INGEMMET' })).toHaveAttribute(
    'href',
    'https://geocatmin.ingemmet.gob.pe/geocatmin_v3/',
  );
  expect(screen.getByRole('button', { name: 'Reintentar catálogo' })).toBeEnabled();
});
