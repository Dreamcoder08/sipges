import type { Role } from '@sipges/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api, resetApi, server } from '../../../test/server.ts';
import { FirstSteps } from './FirstSteps.tsx';
import { InicioPage } from './InicioPage.tsx';

/*
 * Inicio's «Primeros pasos» (world-class-local T7): only steps the app can read from existing API
 * data, a «N de M» line, «Ocultar» per person and project, and nothing once every step is done.
 */

const SCOPE = 'DEMO/PRJ-DEMO';
const REGION = { name: 'Primeros pasos' };
const EMPTY_COUNTS = {
  eventos: 0,
  actores: 0,
  directorio: 0,
  demandas: 0,
  narrativas: 0,
  fuentes: 0,
  buzon: 0,
};

const account = (username: string, active: 0 | 1 = 1) => ({
  username,
  full_name: `Persona ${username}`,
  role: 'analista',
  active,
  created_at: '2026-11-01T10:00:00Z',
  google_email: null,
});

const useData = ({ records = 0, accounts = [account('demo')] } = {}) =>
  server.use(
    http.get('/api/registros/summary', () =>
      HttpResponse.json({ counts: { ...EMPTY_COUNTS, eventos: records }, rows: [] }),
    ),
    http.get('/system/auth/accounts', () => HttpResponse.json(accounts)),
  );

beforeEach(() => {
  resetApi({ me: { username: 'demo', full_name: 'Persona Demo', role: 'admin' } });
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

const renderSteps = (role: Role = 'admin', queryClient = client()) =>
  render(
    <QueryClientProvider client={queryClient}>
      <FirstSteps scope={SCOPE} username="demo" role={role} />
    </QueryClientProvider>,
  );

const steps = async () =>
  within(await screen.findByRole('region', REGION)).getAllByRole('listitem');

it('marks the records step open on an empty project and links to Registros', async () => {
  useData({ records: 0 });
  renderSteps();
  const [records] = await steps();
  expect(records).toHaveTextContent(/^Pendiente:/);
  expect(records).toHaveTextContent('Cargue los primeros registros');
  expect(records).toHaveTextContent(
    'Cárguelos con «Importar» o cree el primero con «Nuevo registro».',
  );
  expect(
    within(records as HTMLElement).getByRole('link', { name: 'Ir a Registros' }),
  ).toHaveAttribute('href', '/registros');
});

it('marks the records step done once the project has a record', async () => {
  useData({ records: 3 });
  renderSteps();
  const [records] = await steps();
  expect(records).toHaveTextContent(/^Hecho:/);
  expect(within(records as HTMLElement).queryByRole('link')).toBeNull();
  expect(screen.getByText('1 de 2')).toBeInTheDocument();
});

it('marks the team step open while no other active account exists, done once one does', async () => {
  useData({ accounts: [account('demo'), account('baja', 0)] });
  const { unmount } = renderSteps();
  const [, team] = await steps();
  expect(team).toHaveTextContent(/^Pendiente:/);
  expect(team).toHaveTextContent('Dé acceso a su equipo');
  expect(
    within(team as HTMLElement).getByRole('link', { name: 'Abrir Administración' }),
  ).toHaveAttribute('href', '/administracion');
  expect(screen.getByText('0 de 2')).toBeInTheDocument();
  unmount();

  useData({ accounts: [account('demo'), account('colega')] });
  renderSteps();
  const [, done] = await steps();
  expect(done).toHaveTextContent(/^Hecho:/);
});

it('hides the admin-only team step from an analyst', async () => {
  useData();
  renderSteps('analista');
  const list = await steps();
  expect(list).toHaveLength(1);
  expect(screen.queryByText('Dé acceso a su equipo')).toBeNull();
  expect(screen.getByText('0 de 1')).toBeInTheDocument();
});

it('shows nothing to roles that cannot act on any step', async () => {
  useData();
  const requested = vi.fn();
  server.events.on('request:start', requested);
  for (const role of ['consulta', 'coordinador'] as const) {
    const { container, unmount } = renderSteps(role);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container).toBeEmptyDOMElement();
    unmount();
  }
  server.events.removeAllListeners();
  expect(requested).not.toHaveBeenCalled();
});

it('shows nothing once every step is done, and stores nothing in the browser for it', async () => {
  // The app keeps nothing in browser storage the person did not choose (e2e 03, 24, 25).
  window.localStorage.clear();
  useData({ records: 2, accounts: [account('demo'), account('colega')] });
  const queryClient = client();
  const { container } = renderSteps('admin', queryClient);
  await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  expect(container).toBeEmptyDOMElement();
  expect(window.localStorage.length).toBe(0);
});

it('stays hidden after «Ocultar», across a remount, for this person and project only', async () => {
  useData();
  const { unmount } = renderSteps();
  fireEvent.click(
    within(await screen.findByRole('region', REGION)).getByRole('button', { name: 'Ocultar' }),
  );
  expect(screen.queryByRole('region', REGION)).toBeNull();
  unmount();

  const { container, unmount: unmountAgain } = renderSteps();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(container).toBeEmptyDOMElement();
  unmountAgain();

  // Another project of the same person still shows it.
  render(
    <QueryClientProvider client={client()}>
      <FirstSteps scope="DEMO/PRJ-OTRO" username="demo" role="admin" />
    </QueryClientProvider>,
  );
  expect(await screen.findByRole('region', REGION)).toBeInTheDocument();
});

it('renders and hides without browser storage', async () => {
  useData();
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  renderSteps();
  const region = await screen.findByRole('region', REGION);
  fireEvent.click(within(region).getByRole('button', { name: 'Ocultar' }));
  expect(screen.queryByRole('region', REGION)).toBeNull();
});

it('shows nothing when a source fails, instead of guessing', async () => {
  server.use(
    http.get('/api/registros/summary', () => HttpResponse.json({ detail: 'x' }, { status: 500 })),
    http.get('/system/auth/accounts', () => HttpResponse.json([account('demo')])),
  );
  const queryClient = client();
  const { container } = renderSteps('admin', queryClient);
  await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  expect(container).toBeEmptyDOMElement();
});

it('sits below the greeting and above the attention cards on an empty Inicio', async () => {
  useData();
  api.me = { username: 'demo', full_name: 'Persona Demo', role: 'admin' };
  render(
    <QueryClientProvider client={client()}>
      <InicioPage
        scope={SCOPE}
        projectId="PRJ-DEMO"
        projectLabel="Proyecto Demo"
        fullName="Persona Demo"
        username="demo"
        role="admin"
        onAsk={vi.fn()}
      />
    </QueryClientProvider>,
  );
  const region = await screen.findByRole('region', REGION);
  const greeting = screen.getByRole('heading', { level: 2, name: /^Hola, Persona/ });
  const attention = screen.getByRole('region', { name: 'Necesita tu atención' });
  expect(greeting.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(region.compareDocumentPosition(attention) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
