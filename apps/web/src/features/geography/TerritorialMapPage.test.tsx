import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, expect, it, vi } from 'vitest';
import { server } from '../../test/server.ts';
import { TerritorialMapPage } from './TerritorialMapPage.tsx';

// Synthetic records and a synthetic concession; no project or official data.
const EVENTS = [
  {
    _id: 'EV-1',
    Fecha: '2026-08-10',
    Territorio: 'Vice',
    Descripcion_Hecho: 'Asamblea comunal sintética',
    Nivel_Verificacion: 'A - Confirmada',
    Fuente_ID: 'FUE-1',
    Latitud: -5.55,
    Longitud: -80.85,
  },
  {
    _id: 'EV-2',
    Fecha: '2026-09-05',
    Territorio: 'Bayóvar',
    Descripcion_Hecho: 'Escenario de bloqueo de prueba',
    Estado_Informacion: 'Escenario hipotético',
  },
];
const CONCESSION = {
  attributes: {
    CODIGOU: 'SINT-0001',
    CONCESION: 'CONCESION SINTETICA',
    TIT_CONCES: 'TITULAR DE PRUEBA S.A.C.',
    HECTAGIS: 100,
    LEYENDA: 'TITULADO',
  },
  geometry: {
    rings: [
      [
        [-80.9, -5.5],
        [-80.8, -5.5],
        [-80.8, -5.6],
        [-80.9, -5.6],
        [-80.9, -5.5],
      ],
    ],
  },
};

const records = (rows: unknown[]) => () => HttpResponse.json(rows);
const bodies: unknown[] = [];
const dossiers: { seeds: { module: string; id: string }[] }[] = [];
const summary = (module: string, id: string, title: string, fields: Record<string, string>) => ({
  module,
  id,
  type_label: module,
  title,
  date: null,
  marking: 'interno',
  fields,
});
const serve = () =>
  server.use(
    http.get('/api/eventos', records(EVENTS)),
    http.get('/api/demandas', records([])),
    http.get('/api/actores', records([])),
    http.get('/api/alertas', records([])),
    http.post('/system/graph/neighbourhood', async ({ request }) => {
      const body = (await request.json()) as (typeof dossiers)[number];
      dossiers.push(body);
      return HttpResponse.json({
        seeds: body.seeds,
        nodes: [
          summary('eventos', 'EV-1', 'Asamblea comunal sintética', {
            Nivel_Verificacion: 'A - Confirmada',
            Fuente_ID: 'FUE-1',
          }),
          summary('alertas', 'AL-1', 'Alerta sintética de bloqueo', {
            Estado: 'Abierta',
            Nivel_Preliminar: 'Naranja',
            Accion_Sugerida: 'Convocar mesa sintética',
          }),
        ],
        edges: [
          {
            id: 1,
            link_type: 'origina',
            source: { module: 'eventos', id: 'EV-1' },
            target: { module: 'alertas', id: 'AL-1' },
            inferred: false,
            via: null,
            note: '',
            created_by: 'admin',
            created_at: null,
          },
        ],
        truncated: false,
      });
    }),
    http.get('/system/geography/catalogue', () =>
      HttpResponse.json({
        status: 'verified',
        checkedAt: '2026-10-18T00:00:00Z',
        serviceUrl: 'https://geocatmin.ingemmet.gob.pe/arcgis/rest/services/',
        attribution: 'INGEMMET – GEOCATMIN',
        layers: [
          {
            serviceId: 'SERV_CATASTRO_MINERO',
            id: 0,
            name: 'Catastro Minero',
            minScale: 0,
            maxScale: 0,
            capabilities: 'Query,Map,Data',
            attribution: 'INGEMMET',
            exportUrl: 'x',
            metadataUrl: 'y',
          },
        ],
      }),
    ),
    http.post('/system/geography/query', async ({ request }) => {
      const body = (await request.json()) as { polygon?: unknown; influenceMeters?: number };
      bodies.push(body);
      return HttpResponse.json({
        features: [CONCESSION],
        truncated: false,
        source:
          'https://geocatmin.ingemmet.gob.pe/arcgis/rest/services/SERV_CATASTRO_MINERO/MapServer/0',
        related: body.polygon
          ? [
              {
                id: 'EV-1',
                module: 'Eventos',
                relationship: 'geometry',
                evidence: 'Coordenadas explícitas WGS84',
              },
              ...(body.influenceMeters
                ? [
                    {
                      id: 'EV-9',
                      module: 'Eventos',
                      relationship: 'proximity',
                      evidence: 'Coordenadas explícitas a 1234 m del límite oficial',
                      distanceMeters: 1234,
                    },
                  ]
                : []),
            ]
          : [],
        unlocated: body.polygon ? [{ id: 'EV-2', module: 'Eventos', reason: 'Sin geometría' }] : [],
        ...(body.influenceMeters
          ? {
              influence: { meters: body.influenceMeters, engine: 'geodesic' },
            }
          : {}),
      });
    }),
  );

const renderPage = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <TerritorialMapPage
        scope="SIPGES/PRJ-SECHURA"
        projectId="PRJ-SECHURA"
        projectLabel="Sechura"
        role="consulta"
        username="reader"
        fullName="Reader"
      />
    </QueryClientProvider>,
  );

afterEach(() => {
  bodies.length = 0;
  dossiers.length = 0;
  vi.unstubAllGlobals();
});

it('draws official concessions, opens their sheet and relates records by geometry', async () => {
  serve();
  renderPage();
  // jsdom has no WebGL: the SVG renderer draws the same layers.
  const concession = await screen.findByRole('button', {
    name: 'Concesión CONCESION SINTETICA (SINT-0001)',
  });
  expect(bodies[0]).toMatchObject({ serviceId: 'SERV_CATASTRO_MINERO', layerId: 0 });
  await userEvent.click(concession);
  const sheet = screen.getByRole('heading', { name: 'CONCESION SINTETICA' }).closest('div');
  if (!sheet) throw new Error('sheet expected');
  expect(within(sheet).getByText('TITULAR DE PRUEBA S.A.C.')).toBeVisible();
  expect(
    await within(sheet).findByRole('link', { name: /Eventos · Asamblea comunal sintética/ }),
  ).toHaveAttribute('href', '/objeto/eventos/EV-1');
  expect(bodies.at(-1)).toMatchObject({
    concessionCode: 'SINT-0001',
    polygon: { type: 'Polygon' },
  });
  // Only the related records stay on the map and in the evolution.
  await userEvent.click(within(sheet).getByLabelText(/Mostrar solo estos registros/));
  const list = screen.getByRole('list', { name: 'Registros del periodo' });
  expect(within(list).getAllByRole('listitem')).toHaveLength(1);
});

it('separates observed records from declared scenarios and filters by state', async () => {
  serve();
  renderPage();
  const list = await screen.findByRole('list', { name: 'Registros del periodo' });
  expect(within(list).getByText('Observado')).toBeVisible();
  expect(within(list).getByText('Escenario hipotético')).toBeVisible();
  await userEvent.click(screen.getByRole('checkbox', { name: 'Escenario hipotético' }));
  expect(within(list).queryByText('Escenario hipotético')).toBeNull();
  // Selecting from the evolution opens the record sheet with its provenance.
  await userEvent.click(within(list).getByRole('button', { name: /Asamblea comunal sintética/ }));
  expect(screen.getByText('Verificación A - Confirmada con fuente FUE-1')).toBeVisible();
  expect(screen.getByText('Coordenadas WGS84 del registro')).toBeVisible();
});

it('plays the documented evolution month by month', async () => {
  serve();
  renderPage();
  const list = await screen.findByRole('list', { name: 'Registros del periodo' });
  fireEvent.click(screen.getByRole('button', { name: 'Reproducir evolución' }));
  expect(screen.getByText('Hasta Agosto de 2026')).toBeVisible();
  expect(within(list).getAllByRole('listitem')).toHaveLength(1);
  // One month per step (STEP_MS), then playback stops at the last documented month.
  expect(await screen.findByText('Hasta Setiembre de 2026', {}, { timeout: 3000 })).toBeVisible();
  expect(within(list).getAllByRole('listitem')).toHaveLength(2);
  expect(
    await screen.findByRole('button', { name: 'Reproducir evolución' }, { timeout: 3000 }),
  ).toBeVisible();
});

it('shows the sheet as a swipeable panel on phones', async () => {
  // jsdom has no PointerEvent; a MouseEvent carries the coordinates of the swipe.
  vi.stubGlobal(
    'PointerEvent',
    class extends MouseEvent {
      pointerId: number;
      constructor(type: string, init?: PointerEventInit) {
        super(type, init);
        this.pointerId = init?.pointerId ?? 0;
      }
    },
  );
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: true,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  serve();
  renderPage();
  const list = await screen.findByRole('list', { name: 'Registros del periodo' });
  expect(screen.queryByRole('region', { name: 'Ficha del registro' })).toBeNull();
  await userEvent.click(within(list).getByRole('button', { name: /Asamblea comunal sintética/ }));
  const sheet = screen.getByRole('region', { name: 'Ficha del registro' });
  const handle = within(sheet).getByRole('button', { name: 'Contraer Ficha del registro' });
  fireEvent.pointerDown(handle, { clientY: 300, pointerId: 1 });
  fireEvent.pointerUp(handle, { clientY: 380, pointerId: 1 });
  expect(sheet).toHaveAttribute('data-open', 'false');
  fireEvent.pointerDown(handle, { clientY: 300, pointerId: 1 });
  fireEvent.pointerUp(handle, { clientY: 380, pointerId: 1 });
  expect(screen.queryByRole('region', { name: 'Ficha del registro' })).toBeNull();
});

it('reports an unavailable cadastre without querying it', async () => {
  serve();
  server.use(
    http.get('/system/geography/catalogue', () =>
      HttpResponse.json({
        status: 'unavailable',
        checkedAt: '2026-10-18T00:00:00Z',
        serviceUrl: 'x',
        attribution: 'INGEMMET',
        layers: [],
      }),
    ),
  );
  renderPage();
  expect(
    await screen.findByText(/El catastro minero de INGEMMET no está disponible ahora/),
  ).toBeVisible();
  expect(bodies).toHaveLength(0);
  expect(screen.queryByRole('alert')).toBeNull();
});

it('relates the territory to its alerts, their basis and what still needs action', async () => {
  serve();
  renderPage();
  const panel = (await screen.findByRole('heading', { name: 'Inteligencia operacional' })).closest(
    'section',
  );
  if (!panel) throw new Error('operations card expected');
  expect(
    await within(panel).findByText('Alerta abierta sin una acción vinculada que la atienda.'),
  ).toBeVisible();
  expect(
    within(panel).getAllByRole('link', { name: 'Alerta sintética de bloqueo' })[0],
  ).toHaveAttribute('href', '/objeto/alertas/AL-1');
  expect(
    within(panel).getByText(/Acción sugerida en la alerta: Convocar mesa sintética/),
  ).toBeVisible();
  // The visible records seed the dossier, newest first.
  expect(dossiers[0]?.seeds).toEqual([
    { module: 'eventos', id: 'EV-2' },
    { module: 'eventos', id: 'EV-1' },
  ]);
  // Selecting a concession narrows the dossier to the records related to it.
  await userEvent.click(
    await screen.findByRole('button', { name: 'Concesión CONCESION SINTETICA (SINT-0001)' }),
  );
  expect(await within(panel).findByText('Concesión CONCESION SINTETICA')).toBeVisible();
  await within(panel).findByText(/Concesión CONCESION SINTETICA: 1 señal/);
  expect(dossiers.at(-1)?.seeds).toEqual([{ module: 'eventos', id: 'EV-1' }]);
});

it(
  'widens a concession to its area of influence and says how distances were measured',
  { timeout: 20000 },
  async () => {
    serve();
    renderPage();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Concesión CONCESION SINTETICA (SINT-0001)' }),
    );
    const sheet = screen.getByRole('heading', { name: 'CONCESION SINTETICA' }).closest('div');
    if (!sheet) throw new Error('sheet expected');
    await within(sheet).findByRole('link', { name: /Asamblea comunal sintética/ });
    await userEvent.selectOptions(within(sheet).getByLabelText('Área de influencia'), '3000');
    expect(
      await within(sheet).findByText(/En el área de influencia a 1.2 km del límite/),
    ).toBeVisible();
    expect(bodies.at(-1)).toMatchObject({ concessionCode: 'SINT-0001', influenceMeters: 3000 });
    expect(within(sheet).getByText(/PostGIS aún no está habilitado/)).toBeVisible();
    expect(await screen.findByText('Concesión CONCESION SINTETICA y 3 km alrededor')).toBeVisible();
  },
);
