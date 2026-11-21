import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resetApi, server } from '../../test/server.ts';
import { DashboardPage } from './DashboardPage.tsx';

/*
 * Panel ejecutivo on a phone (TodayView) and its IRSA card, as the visit-rc14 gallery saw them
 * (odd/archive/functional-10.md T14): alerts that share a title must read apart, and the dimension
 * scores must carry their names, not only their letters.
 */
const renderLink = (to: string, children: ReactNode) => <a href={to}>{children}</a>;
const renderPanel = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <DashboardPage scope="DEMO/PRJ-DEMO" renderLink={renderLink} />
    </QueryClientProvider>,
  );

beforeEach(() => {
  resetApi({ me: { username: 'demo', full_name: 'Persona', role: 'admin' } });
  // The phone layout follows `matchMedia`, which jsdom lacks (docs/adr/0015).
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(max-width: 60rem)',
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});
afterEach(() => vi.unstubAllGlobals());

it('tells apart two alerts with one title on the phone Panel by place and id (T14)', async () => {
  server.use(
    http.get('/api/alertas', () =>
      HttpResponse.json([
        {
          _id: 'AL-SIN-1',
          Causa: 'Bloqueo sintético de la vía',
          Nivel_Preliminar: 'Rojo',
          Estado: 'Abierta',
          Fecha: '2026-10-12',
          Territorio: 'Vice',
        },
        {
          _id: 'AL-SIN-2',
          Causa: 'Bloqueo sintético de la vía',
          Nivel_Preliminar: 'Rojo',
          Estado: 'Abierta',
          Fecha: '2026-10-12',
        },
        {
          _id: 'AL-SIN-3',
          Causa: 'Convocatoria sintética única',
          Nivel_Preliminar: 'Naranja',
          Estado: 'Abierta',
          Fecha: '2026-10-11',
          Territorio: 'Bernal',
        },
      ]),
    ),
  );
  renderPanel();
  const block = (await screen.findByRole('heading', { name: 'Requiere atención' })).closest(
    'section',
  );
  if (!block) throw new Error('missing «Requiere atención»');
  const first = await within(block).findByRole('link', { name: /AL-SIN-1/ });
  const second = within(block).getByRole('link', { name: /AL-SIN-2/ });
  expect(first).toHaveTextContent('12 oct. · Vice · AL-SIN-1');
  expect(second).toHaveTextContent('12 oct. · AL-SIN-2');
  expect(first.textContent).not.toBe(second.textContent);
  // A title that does not repeat keeps its place but needs no id.
  const single = within(block).getByRole('link', { name: /Convocatoria sintética única/ });
  expect(single).toHaveTextContent('11 oct. · Bernal');
  expect(single).not.toHaveTextContent('AL-SIN-3');
  // Role queries over the whole Panel are slow in jsdom on a loaded machine.
}, 20_000);

it('names every IRSA dimension beside its letter and score on the Panel (T14, F10)', async () => {
  renderPanel();
  const list = await screen.findByRole('list', { name: 'Puntaje por dimensión' });
  const items = within(list)
    .getAllByRole('listitem')
    .map((item) => item.textContent?.replace(/\s+/g, ' ').trim());
  expect(items).toEqual([
    expect.stringMatching(/^G ?Gobernanza ?\d/),
    expect.stringMatching(/^A ?Actores ?\d/),
    expect.stringMatching(/^D ?Demandas ?\d/),
    expect.stringMatching(/^N ?Narrativas ?\d/),
    expect.stringMatching(/^E ?Ambiental-territorial ?\d/),
    expect.stringMatching(/^I ?Institucional ?\d/),
  ]);
});
