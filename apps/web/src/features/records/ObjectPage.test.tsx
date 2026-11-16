import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { beforeEach, expect, it } from 'vitest';
import { server } from '../../test/server.ts';
import { ObjectPage } from './ObjectPage.tsx';

beforeEach(() =>
  server.use(http.get('*', () => HttpResponse.json({ detail: 'Sin datos' }, { status: 503 }))),
);

const renderPage = (module: string, from?: 'calidad') =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ObjectPage
        module={module}
        id="X-1"
        scope="DEMO/PRJ-DEMO"
        role="consulta"
        projectId="PRJ-DEMO"
        projectLabel="Demo"
        from={from}
      />
    </QueryClientProvider>,
  );

// functional-10 T16 (ego-browser walk): every record sheet offered «Volver a calidad de datos»,
// also when the person came from Registros, Territorio or Inicio.
it('goes back to the list of the record type', () => {
  renderPage('eventos');
  expect(screen.getByRole('link', { name: 'Volver a Eventos' })).toHaveAttribute(
    'href',
    '/eventos',
  );
  expect(screen.queryByRole('link', { name: 'Volver a calidad de datos' })).toBeNull();
});

it('sends commitments to the screen that lists them', () => {
  renderPage('compromisos');
  expect(screen.getByRole('link', { name: /^Volver a/ })).toHaveAttribute('href', '/demandas');
});

it('goes back home for a type without a list of its own', () => {
  renderPage('acciones');
  expect(screen.getByRole('link', { name: 'Volver al inicio' })).toHaveAttribute('href', '/inicio');
});

it('goes back to Calidad de datos when the sheet was opened from there', () => {
  renderPage('actores', 'calidad');
  expect(screen.getByRole('link', { name: 'Volver a calidad de datos' })).toHaveAttribute(
    'href',
    '/calidad',
  );
});
