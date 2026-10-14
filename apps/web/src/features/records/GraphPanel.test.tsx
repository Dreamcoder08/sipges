import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { NavigateProvider } from '../../shared/lib/navigation.tsx';
import { server } from '../../test/server.ts';
import { GraphPanel } from './GraphPanel.tsx';

const node = (module: string, id: string, title: string, type_label: string) => ({
  module,
  id,
  title,
  type_label,
  date: null,
  fields: {},
});

it('draws the neighbourhood, switches depth and opens a neighbour', async () => {
  const depths: string[] = [];
  server.use(
    http.get('/system/ontology', () =>
      HttpResponse.json({
        object_types: [],
        link_types: [
          {
            id: 'plantea',
            label: 'plantea',
            inverse_label: 'es planteada por',
            sources: ['actores'],
            targets: ['demandas'],
            symmetric: false,
          },
        ],
      }),
    ),
    http.get('/system/graph', ({ request }) => {
      depths.push(new URL(request.url).searchParams.get('depth') ?? '');
      return HttpResponse.json({
        root: { module: 'actores', id: 'A-1' },
        nodes: [
          node('actores', 'A-1', 'Comunidad Norte', 'Actor'),
          node('demandas', 'D-1', 'Agua potable', 'Demanda'),
        ],
        edges: [
          {
            id: 1,
            link_type: 'plantea',
            source: { module: 'actores', id: 'A-1' },
            target: { module: 'demandas', id: 'D-1' },
            inferred: false,
            via: null,
            note: '',
            created_by: 'admin',
            created_at: '2026-10-14T00:00:00Z',
          },
        ],
        truncated: false,
      });
    }),
  );
  const visited: string[] = [];
  render(
    <QueryClientProvider client={new QueryClient()}>
      <NavigateProvider value={(href) => visited.push(href)}>
        <GraphPanel module="actores" id="A-1" scope="A/B" />
      </NavigateProvider>
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  const neighbour = await screen.findByRole('link', { name: 'Demanda: Agua potable' });
  expect(screen.getByRole('cell', { name: 'plantea' })).toBeInTheDocument();
  expect(screen.getByText(/2 registros · 1 relaciones/)).toBeInTheDocument();
  await user.click(neighbour);
  expect(visited).toEqual(['/objeto/demandas/D-1']);
  await user.click(screen.getByRole('button', { name: 'Dos saltos' }));
  await screen.findByRole('button', { name: 'Dos saltos', pressed: true });
  expect(depths).toEqual(['1', '2']);
});
