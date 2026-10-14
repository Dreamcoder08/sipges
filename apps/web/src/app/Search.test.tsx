import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, expect, it } from 'vitest';
import { installRecordsApi } from '../test/records-api.ts';
import { resetApi, server } from '../test/server.ts';
import { App } from './App.tsx';

beforeEach(() =>
  resetApi({ me: { username: 'demo', full_name: 'Persona de prueba', role: 'consulta' } }),
);

it('searches every object type with Ctrl+K and opens the chosen record', async () => {
  installRecordsApi({
    'DEMO/PRJ-DEMO/demandas': [{ _id: 'D-1', Descripcion: 'Acceso a agua potable' }],
  });
  const queries: { q: string | null; scope: string | null }[] = [];
  server.use(
    http.get('/system/search', ({ request }) => {
      const url = new URL(request.url);
      queries.push({
        q: url.searchParams.get('q'),
        scope: request.headers.get('X-MASCLI-Scope'),
      });
      return HttpResponse.json({
        query: url.searchParams.get('q'),
        hits: [
          {
            module: 'demandas',
            id: 'D-1',
            type_label: 'Demanda',
            title: 'Acceso a agua potable',
            date: null,
            marking: 'interno',
            fields: {},
            match: { field: 'Descripcion', excerpt: 'Acceso a agua potable' },
          },
          {
            module: 'eventos',
            id: 'EV-1',
            type_label: 'Evento',
            title: 'Protesta',
            date: null,
            marking: 'interno',
            fields: {},
            match: { field: 'Causa', excerpt: '…por el agua' },
          },
        ],
      });
    }),
  );
  window.history.replaceState(null, '', '/');
  render(<App />);
  const user = userEvent.setup();
  await screen.findByRole('button', { name: /Buscar/ });
  await user.keyboard('{Control>}k{/Control}');
  const box = await screen.findByRole('combobox', { name: 'Buscar en todo el proyecto' });
  await user.type(box, 'agua');
  expect(await screen.findByRole('option', { name: /Acceso a agua potable/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(screen.getByText('…por el agua')).toBeVisible();
  expect(queries.at(-1)).toEqual({ q: 'agua', scope: 'DEMO/PRJ-DEMO' });
  await user.keyboard('{Enter}');
  await waitFor(() => expect(window.location.pathname).toBe('/objeto/demandas/D-1'));
  expect(screen.queryByRole('dialog')).toBeNull();
});
