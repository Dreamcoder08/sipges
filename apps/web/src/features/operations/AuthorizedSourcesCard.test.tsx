import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { server } from '../../test/server.ts';
import { AuthorizedSourcesCard } from './AuthorizedSourcesCard.tsx';
import type { FeatureContext } from '../../shared/api/feature-context.ts';
const state = {
  enabled: false,
  query: '',
  territory: '',
  authorization_note: '',
  revision: 0,
  updated_by: '',
  updated_at: null,
  last_poll_at: null,
  last_poll_error: '',
  last_imported: 0,
  last_duplicates: 0,
};
const renderCard = (role: FeatureContext['role']) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <AuthorizedSourcesCard
        context={{
          role,
          scope: 'ACME/P1',
          projectId: 'P1',
          projectLabel: 'Synthetic',
          username: 'test',
          fullName: 'Test',
        }}
      />
    </QueryClientProvider>,
  );
const handlers = () =>
  server.use(
    http.get('*/system/intelligence/sources', () =>
      HttpResponse.json({
        id: 'defensoria',
        name: 'Defensoría del Pueblo del Perú',
        url: 'https://www.defensoria.gob.pe/',
        checked_at: '2026-10-17',
        attribution: 'Solo extractos oficiales.',
        state,
      }),
    ),
  );
it('keeps coordinator access read only and explains official metadata', async () => {
  handlers();
  renderCard('coordinador');
  expect(await screen.findByText('Solo extractos oficiales.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Guardar configuración' })).not.toBeInTheDocument();
  expect(screen.getByText(/Lectura: solo administradores/)).toBeInTheDocument();
});
it('requires an explicit confirmation and authorization note before enabling', async () => {
  handlers();
  renderCard('analista');
  const user = userEvent.setup();
  const enabled = await screen.findByRole('checkbox', {
    name: 'Activar consulta periódica autorizada',
  });
  await user.click(enabled);
  expect(screen.getByRole('button', { name: 'Guardar configuración' })).toBeDisabled();
  await user.type(
    screen.getByLabelText('Nota de autorización'),
    'Autorizado para el proyecto sintético',
  );
  await user.click(
    screen.getByRole('checkbox', {
      name: 'Confirmo la autorización de esta fuente para el proyecto',
    }),
  );
  expect(screen.getByRole('button', { name: 'Guardar configuración' })).toBeEnabled();
});
