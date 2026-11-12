import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { expect, it, vi } from 'vitest';
import { NavigateProvider } from '../../shared/lib/navigation.tsx';
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

it('does not open a result while an input method is still composing the query', async () => {
  const hit = {
    module: 'eventos',
    id: 'E-1',
    type_label: 'Evento',
    title: 'Corte de agua',
    date: null,
    marking: 'interno',
    fields: {},
    match: null,
  };
  server.use(
    http.get('*/system/intelligence/embedder', () => HttpResponse.json(status({}))),
    http.get('*/system/search', () => HttpResponse.json({ query: 'agua', hits: [hit] })),
  );
  const navigate = vi.fn();
  const user = userEvent.setup();
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <NavigateProvider value={navigate}>
        <SearchPalette scope="DEMO/PRJ-DEMO" />
      </NavigateProvider>
    </QueryClientProvider>,
  );
  await user.click(screen.getByRole('button', { name: /Buscar/ }));
  const input = screen.getByRole('combobox', { name: 'Buscar en todo el proyecto' });
  await user.type(input, 'agua');
  expect(await screen.findByRole('option', { name: /Corte de agua/ })).toBeVisible();
  // Chromium and Firefox flag the confirming Enter as composing; Safari reports keyCode 229.
  for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
    expect(fireEvent.keyDown(input, { key: 'Enter', ...init })).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Búsqueda global' })).toBeVisible();
  }
  await user.keyboard('{Enter}');
  expect(navigate).toHaveBeenCalledWith('/objeto/eventos/E-1');
});
