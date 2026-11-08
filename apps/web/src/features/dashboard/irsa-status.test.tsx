import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetApi, server } from '../../test/server.ts';
import { DashboardPage } from './DashboardPage.tsx';

const SCOPE = 'DEMO/PRJ-DEMO';
const NO_DATA = 'Sin datos suficientes';
const HINT = 'Carga registros del proyecto para calcular el IRSA.';
const PENDING = 'Metodología pendiente de validación';

const irsa = (extra: Record<string, unknown> = {}) =>
  HttpResponse.json({
    irsa: 5.55,
    level: 'Verde',
    scores: { G: 0, A: 0, D: 0, N: 0, E: 0, I: 33.33 },
    drivers: [],
    config_version: '0.4-indicators',
    coverage: { G: 0, A: 0, D: 0, N: 0, E: 0, I: 0 },
    insufficient_data: false,
    ...extra,
  });

const renderLink = (to: string, children: ReactNode) => <a href={to}>{children}</a>;
const renderDashboard = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <DashboardPage scope={SCOPE} renderLink={renderLink} />
    </QueryClientProvider>,
  );

/** The phone layout follows `matchMedia`, which jsdom lacks (docs/adr/0015). */
const stubViewport = (compact: boolean) =>
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: compact && query === '(max-width: 60rem)',
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));

beforeEach(() => resetApi({ me: { username: 'demo', full_name: 'Persona', role: 'admin' } }));
afterEach(() => vi.unstubAllGlobals());

describe.each([
  ['Dashboard', false],
  ['Hoy (phone)', true],
])('IRSA reading in %s', (_name, compact) => {
  beforeEach(() => stubViewport(compact));

  it('says «Sin datos suficientes» with no level or risk colour when there is no evidence (S3)', async () => {
    server.use(http.get('/system/irsa', () => irsa({ insufficient_data: true })));
    renderDashboard();
    expect((await screen.findAllByText(NO_DATA))[0]).toBeVisible();
    expect(screen.getAllByText(HINT)[0]).toBeVisible();
    const reading = screen.getAllByText(NO_DATA)[0]?.closest('p');
    expect(reading).not.toHaveTextContent(/Verde|Amarillo|Naranja|Rojo/);
    expect(screen.queryByText('5.6')).toBeNull();
    expect(screen.queryByText('5.5')).toBeNull();
  });

  it('keeps the value and the level once there is evidence (S3, S5)', async () => {
    server.use(
      http.get('/system/irsa', () =>
        irsa({ irsa: 42.25, level: 'Amarillo', coverage: { G: 0, A: 0, D: 3, N: 0, E: 0, I: 1 } }),
      ),
    );
    renderDashboard();
    expect((await screen.findAllByText(/^Amarillo/, { selector: 'p > span' }))[0]).toBeVisible();
    expect(screen.queryByText(NO_DATA)).toBeNull();
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it('shows the pending-methodology badge only while the config says so (S3)', async () => {
    server.use(http.get('/system/irsa', () => irsa({ irsa: 42.25, level: 'Amarillo' })));
    renderDashboard();
    expect((await screen.findAllByText(PENDING))[0]).toBeVisible();
  });

  it('hides the badge when the methodology is validated (S3)', async () => {
    server.use(
      http.get('/system/irsa', () => irsa({ irsa: 42.25, level: 'Amarillo' })),
      http.get('/system/irsa/config', () =>
        HttpResponse.json({
          status: 'VALIDADO',
          weights: { G: 1, A: 0, D: 0, N: 0, E: 0, I: 0 },
          thresholds: { Verde: [0, 100] },
          contributions: {},
        }),
      ),
    );
    renderDashboard();
    expect((await screen.findAllByText(/^Amarillo/, { selector: 'p > span' }))[0]).toBeVisible();
    await waitFor(() => expect(screen.queryByText(PENDING)).toBeNull());
  });
});
