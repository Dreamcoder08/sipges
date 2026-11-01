import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '../../test/server.ts';
import { HistoryPanel, readable } from './HistoryPanel.tsx';

it('lists versions newest first with labelled field changes', async () => {
  let scope: string | null = null;
  server.use(
    http.get('/api/actores/A-1/history', ({ request }) => {
      scope = request.headers.get('X-SIPGES-Scope');
      return HttpResponse.json([
        {
          version: 2,
          operation: 'UPDATE',
          actor: 'analista1',
          at: '2026-10-14T10:00:00Z',
          payload: { 'Nombre_Actor/Organizacion': 'Comunidad del Norte' },
          changes: [
            {
              field: 'Nombre_Actor/Organizacion',
              before: 'Comunidad Norte',
              after: 'Comunidad del Norte',
            },
          ],
        },
        {
          version: 1,
          operation: 'CREATE',
          actor: 'admin',
          at: '2026-10-13T10:00:00Z',
          payload: { 'Nombre_Actor/Organizacion': 'Comunidad Norte' },
          changes: [{ field: 'Nombre_Actor/Organizacion', after: 'Comunidad Norte' }],
        },
      ]);
    }),
  );
  render(
    <QueryClientProvider client={new QueryClient()}>
      <HistoryPanel module="actores" id="A-1" scope="A/B" />
    </QueryClientProvider>,
  );
  const items = await screen.findAllByRole('listitem');
  expect(items[0]).toHaveTextContent('v2 · Actualización');
  expect(items[0]).toHaveTextContent('analista1');
  expect(screen.getByText('Nombre del actor u organización:')).toBeInTheDocument();
  expect(screen.getByText('Comunidad Norte', { selector: 'del' })).toBeInTheDocument();
  expect(screen.getByText('Comunidad del Norte', { selector: 'ins' })).toBeInTheDocument();
  expect(screen.getByText(/v1 · Creación/)).toBeInTheDocument();
  expect(scope).toBe('A/B');
});

describe('readable history values', () => {
  it('shows attachments by file name and type, and objects as key: value pairs', () => {
    expect(
      readable([
        { id: 'ADJ-1', tipo: 'Acta', archivo: 'acta.txt', verificacion: 'E - No verificada' },
        { id: 'ADJ-2', archivo: 'foto.png' },
      ]),
    ).toBe('acta.txt (Acta), foto.png');
    expect(readable({ hitos: 2, estado: 'Abierto', nota: null })).toBe(
      'hitos: 2 · estado: Abierto',
    );
    expect(readable('Texto')).toBe('Texto');
  });
});
