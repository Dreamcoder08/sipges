import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { server } from '../../../test/server.ts';
import { IntegrationsPage } from './IntegrationsPage.tsx';

const context = {
  scope: 'ACME/P1',
  projectId: 'P1',
  projectLabel: 'Proyecto Uno',
  username: 'admin',
  fullName: 'Admin Demo',
};

const rule = (id: number, name: string, enabled: boolean) => ({
  id,
  name,
  enabled,
  module: 'Alertas',
  actions: ['CREATE'],
  conditions: [],
  steps: [{ kind: 'notify', title: 'Alerta {id}' }],
  created_by: 'admin',
  updated_at: '2026-10-14T10:00:00Z',
});

const overview = {
  sources: [{ module: 'Alertas', label: 'Alertas' }],
  actions: ['CREATE', 'UPDATE'],
  operators: ['eq', 'present'],
  rules: [rule(1, 'Alertas altas', true), rule(2, 'Control de calidad', false)],
  channels: [
    {
      id: 4,
      kind: 'slack',
      name: 'Equipo social',
      target_hint: 'hooks.slack.com',
      created_by: 'admin',
      created_at: '2026-10-14T09:00:00Z',
    },
  ],
  runs: [],
};

const feed = {
  id: 1,
  name: 'Diario Regional',
  url: 'https://medios.example.org/feed',
  keywords: [],
  territory: '',
  authorization_note: 'Autorizado por el titular',
  enabled: true,
  updated_by: 'admin',
  updated_at: '2026-10-14T09:00:00Z',
  last_poll_at: '2026-10-14T10:00:00Z',
  last_poll_error: '',
  last_imported: 3,
  last_matched: 3,
};

const defensoria = (configured: boolean) => ({
  id: 'defensoria',
  name: 'Defensoría del Pueblo',
  url: 'https://www.defensoria.gob.pe',
  checked_at: '2026-10-01',
  attribution: 'Defensoría del Pueblo',
  state: {
    enabled: configured,
    query: '',
    territory: '',
    authorization_note: configured ? 'Autorizado' : '',
    revision: 1,
    updated_by: configured ? 'admin' : '',
    updated_at: configured ? '2026-10-14T09:00:00Z' : null,
    last_poll_at: null,
    last_poll_error: '',
    last_imported: 0,
    last_duplicates: 0,
  },
});

const key = (access: 'read' | 'write', revoked = false) => ({
  id: access === 'read' ? 1 : 2,
  name: access === 'read' ? 'Claude Desktop' : 'n8n',
  prefix: 'abcdef012345',
  access,
  clearance: 'limited',
  created_by: 'admin',
  created_at: '2026-10-14T09:00:00Z',
  last_used_at: null,
  revoked_at: revoked ? '2026-10-15T09:00:00Z' : null,
});

type Api = {
  feeds?: unknown[];
  defensoria?: boolean;
  keys?: unknown[];
  mediaFails?: boolean;
};

const useApi = ({
  feeds = [feed],
  defensoria: configured = true,
  keys = [key('read')],
  mediaFails,
}: Api = {}) =>
  server.use(
    http.get('*/system/automations', () => HttpResponse.json(overview)),
    http.get('*/system/automations/runtime', () =>
      HttpResponse.json({
        event_processing: true,
        cron_configured: false,
        cron_schedule: null,
        interval_ms: 30000,
        latest_attempt: null,
      }),
    ),
    http.get('*/system/integrations/api-keys', () => HttpResponse.json(keys)),
    http.get('*/system/v4/media', () =>
      mediaFails
        ? HttpResponse.json({ detail: 'caído' }, { status: 500 })
        : HttpResponse.json({ poll_minutes: 30, max_feeds: 20, feeds }),
    ),
    http.get('*/system/intelligence/sources', () => HttpResponse.json(defensoria(configured))),
    http.get('*/system/geography/catalogue', () =>
      HttpResponse.json({
        status: 'verified',
        checkedAt: '2026-10-14T09:00:00Z',
        serviceUrl: 'https://geocatmin.ingemmet.gob.pe',
        attribution: 'INGEMMET – GEOCATMIN',
        services: [],
        layers: [],
      }),
    ),
    http.get('*/system/notifications/push', () =>
      HttpResponse.json({ enabled: true, public_key: 'clave-publica-sintetica' }),
    ),
  );

const renderPage = (role: 'admin' | 'analista' = 'admin') =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <IntegrationsPage
        {...context}
        role={role}
        renderSource={(source) => <p>Gestión existente de {source}</p>}
      />
    </QueryClientProvider>,
  );

const cardNamed = async (name: string) => {
  const card = (await screen.findByRole('heading', { level: 3, name })).closest('li');
  if (!card) throw new Error(`Missing card ${name}`);
  return within(card);
};

it('lists what the project has, one section per kind, with trust label and status', async () => {
  useApi();
  renderPage();
  for (const title of ['Conectores entrantes', 'Conectores salientes', 'Skills', 'Programadas']) {
    expect(
      await screen.findByRole('heading', { level: 2, name: new RegExp(`^${title}`) }),
    ).toBeVisible();
  }
  const media = await cardNamed('Medios RSS');
  expect(media.getByText('Integrado')).toBeVisible();
  expect(media.getByText('Conectado')).toBeVisible();
  // Status is the shared badge family: the word plus a tone that picks colour and shape.
  expect(media.getByText('Conectado')).toHaveAttribute('data-tone', 'positive');
  const channel = await cardNamed('Equipo social');
  expect(channel.getByText('Personalizado')).toBeVisible();
  const paused = await cardNamed('Control de calidad');
  expect(paused.getByText('Pausada')).toBeVisible();
  expect(paused.getByText('Pausada')).toHaveAttribute('data-tone', 'neutral');
  const active = await cardNamed('Alertas altas');
  expect(active.getByText('Activa')).toBeVisible();
  expect(screen.queryByText(/Power BI/)).toBeNull();
});

it('filters by kind with the chips and keeps the counts', async () => {
  const user = userEvent.setup();
  useApi();
  renderPage();
  await cardNamed('Medios RSS');
  const chips = screen.getByRole('group', { name: 'Filtrar por tipo' });
  expect(within(chips).getByRole('button', { name: /^Todos/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await user.click(within(chips).getByRole('button', { name: /^Skills/ }));
  expect(within(chips).getByRole('button', { name: /^Skills/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(screen.getByRole('heading', { level: 2, name: /^Skills/ })).toBeVisible();
  expect(screen.queryByRole('heading', { level: 2, name: /^Programadas/ })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Medios RSS' })).toBeNull();
  await user.click(within(chips).getByRole('button', { name: /^Programadas/ }));
  expect(screen.getByRole('button', { name: 'Alertas altas' })).toBeVisible();
  expect(screen.queryByRole('heading', { level: 2, name: /^Skills/ })).toBeNull();
});

it('searches names and descriptions without caring about accents', async () => {
  const user = userEvent.setup();
  useApi();
  renderPage();
  await cardNamed('Medios RSS');
  await user.type(screen.getByRole('searchbox', { name: 'Buscar integraciones' }), 'defensoria');
  expect(screen.getByRole('button', { name: 'Defensoría del Pueblo' })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Medios RSS' })).toBeNull();
  await user.clear(screen.getByRole('searchbox', { name: 'Buscar integraciones' }));
  await user.type(screen.getByRole('searchbox', { name: 'Buscar integraciones' }), 'zzz');
  expect(screen.getByText('Ninguna integración coincide con estos filtros.')).toBeVisible();
});

it('offers to clear the search and the type filter when nothing matches', async () => {
  const user = userEvent.setup();
  useApi();
  renderPage();
  await cardNamed('Medios RSS');
  await user.click(
    within(screen.getByRole('group', { name: 'Filtrar por tipo' })).getByRole('button', {
      name: /^Programadas/,
    }),
  );
  await user.type(screen.getByRole('searchbox', { name: 'Buscar integraciones' }), 'zzz');
  await user.click(screen.getByRole('button', { name: 'Limpiar filtros' }));
  expect(screen.getByRole('searchbox', { name: 'Buscar integraciones' })).toHaveValue('');
  expect(
    within(screen.getByRole('group', { name: 'Filtrar por tipo' })).getByRole('button', {
      name: /^Todos/,
    }),
  ).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: 'Medios RSS' })).toBeVisible();
});

it('moves what is not configured yet to Descubrir, and nothing the code cannot enable', async () => {
  const user = userEvent.setup();
  useApi({ feeds: [], defensoria: false, keys: [] });
  renderPage();
  await screen.findByRole('button', { name: 'Claude vía MCP' });
  expect(screen.queryByRole('button', { name: 'Medios RSS' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Descubrir' }));
  expect(screen.getByRole('button', { name: 'Descubrir' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: 'Medios RSS' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Defensoría del Pueblo' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Telegram' })).toBeVisible();
  expect(screen.queryByText(/Power BI/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Claude vía MCP' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Añadir: Telegram' }));
  expect(await screen.findByText('Tipo de canal')).toBeVisible();
});

it('warns that Claude via MCP only works with synthetic data and offers no real-data action', async () => {
  const user = userEvent.setup();
  useApi();
  renderPage();
  const mcp = await cardNamed('Claude vía MCP');
  expect(
    mcp.getByText('Datos sintéticos hasta aprobar política de datos (Ley 29733)'),
  ).toBeVisible();
  expect(screen.queryByRole('button', { name: /datos reales/i })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Claude vía MCP' }));
  expect(
    await screen.findByText(/Datos sintéticos hasta aprobar política de datos \(Ley 29733\)\./),
  ).toBeVisible();
  expect(screen.queryByRole('button', { name: /datos reales/i })).toBeNull();
});

it('opens the existing key management in a detail view and returns to the list', async () => {
  const user = userEvent.setup();
  useApi();
  renderPage();
  await user.click(await screen.findByRole('button', { name: 'Claude vía MCP' }));
  expect(await screen.findByRole('heading', { level: 2, name: 'Claude vía MCP' })).toHaveFocus();
  expect(await screen.findByLabelText(/Nombre de la clave/)).toBeVisible();
  expect(screen.queryByRole('heading', { level: 2, name: /^Skills/ })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Integraciones' }));
  expect(await screen.findByRole('button', { name: 'Claude vía MCP' })).toHaveFocus();
});

it('opens the existing rule form from a scheduled card', async () => {
  const user = userEvent.setup();
  useApi();
  renderPage();
  const card = await cardNamed('Alertas altas');
  await user.click(card.getByRole('button', { name: 'Gestionar Alertas altas' }));
  expect(await screen.findByLabelText('Nombre de la regla')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Eliminar regla Alertas altas' })).toBeVisible();
  expect(screen.queryByLabelText('Tipo de canal')).toBeNull();
});

it('composes the source management of other screens through renderSource', async () => {
  const user = userEvent.setup();
  useApi();
  renderPage();
  await user.click(await screen.findByRole('button', { name: 'Defensoría del Pueblo' }));
  expect(await screen.findByText('Gestión existente de defensoria')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Integraciones' }));
  await user.click(await screen.findByRole('button', { name: 'Medios RSS' }));
  expect(await screen.findByText('Gestión existente de media')).toBeVisible();
});

it('shows skills as built-in screens and links to them', async () => {
  useApi();
  renderPage();
  const strategic = await cardNamed('Informe estratégico');
  expect(strategic.getByText('Pantalla integrada')).toBeVisible();
  expect(strategic.getByText('Integrado')).toBeVisible();
  expect(strategic.getByRole('link', { name: 'Abrir: Informe estratégico' })).toHaveAttribute(
    'href',
    '/estrategia',
  );
});

it('keeps the other cards when one source cannot be read', async () => {
  useApi({ mediaFails: true });
  renderPage();
  expect(await screen.findByRole('alert')).toHaveTextContent('Medios RSS');
  expect(await screen.findByRole('button', { name: 'Defensoría del Pueblo' })).toBeVisible();
});

it('stays closed to other roles', () => {
  renderPage('analista');
  expect(screen.getByText(/solo las configura el rol administrador/)).toBeInTheDocument();
});
