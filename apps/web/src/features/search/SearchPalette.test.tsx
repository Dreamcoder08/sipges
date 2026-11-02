import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { expect, it } from 'vitest';
import { server } from '../../test/server.ts';
import { SearchPalette } from './SearchPalette.tsx';

const status = (overrides: Record<string, unknown>) => ({
  configured: true,
  available: true,
  reason: null,
  model: 'nomic-embed-text',
  egress: 'external',
  semantic_search: true,
  ...overrides,
});

const open = async (embedder: Record<string, unknown>) => {
  server.use(
    http.get('*/system/intelligence/embedder', () => HttpResponse.json(embedder)),
    http.get('*/system/search', () => HttpResponse.json({ query: 'agua', hits: [] })),
  );
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <SearchPalette scope="DEMO/PRJ-DEMO" />
    </QueryClientProvider>,
  );
  await userEvent.setup().click(screen.getByRole('button', { name: /Buscar/ }));
};

it('says search is keyword only when the semantic model is unavailable', async () => {
  await open(status({ available: false, reason: 'external_ai_disabled' }));
  expect(
    await screen.findByText(
      'Búsqueda por palabras clave: la búsqueda por significado no está disponible (el envío a IA externa está desactivado para este proyecto).',
    ),
  ).toBeVisible();
});

it('says nothing extra when semantic search works', async () => {
  await open(status({}));
  expect(await screen.findByText(/Escribe para buscar/)).toBeVisible();
  expect(screen.queryByText(/palabras clave/)).toBeNull();
});
