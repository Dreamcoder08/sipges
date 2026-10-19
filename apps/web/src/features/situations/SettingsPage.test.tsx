import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { ProjectSettingsProvider } from '../../shared/lib/project-settings.tsx';
import { LevelPill } from '../../shared/ui/Badges.tsx';
import { server } from '../../test/server.ts';
import { SettingsPage } from './SettingsPage.tsx';

const meanings = {
  Verde: 'Situación estable / riesgo bajo',
  Amarillo: 'Requiere atención y seguimiento',
  Naranja: 'Requiere intervención preventiva',
  Rojo: 'Situación crítica / atención inmediata',
};
const settings = (version4: boolean) => ({
  version4,
  level_meanings: meanings,
  window_days: 90,
  half_life_days: 14,
  thresholds: { Amarillo: 2, Naranja: 4, Rojo: 7 },
  recommendations: [
    {
      id: 'reunion' as const,
      condition: 'Nivel Naranja o Rojo',
      text: 'Coordinar una reunión con los actores involucrados.',
      custom: false,
    },
  ],
  updated_by: version4 ? 'admin' : '',
  updated_at: version4 ? '2026-10-19T12:00:00Z' : null,
});
const context = {
  scope: 'ACME/P1',
  projectId: 'P1',
  projectLabel: 'Proyecto Uno',
  username: 'admin',
  fullName: 'Admin Demo',
};
const renderPage = (role: 'admin' | 'consulta') =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <SettingsPage {...context} role={role} />
    </QueryClientProvider>,
  );

it('shows only the colour while MASCLI 4.0 is off, and colour with meaning once on', () => {
  const { rerender } = render(<LevelPill level="Naranja" />);
  expect(screen.getByText('Naranja')).toBeInTheDocument();
  rerender(
    <ProjectSettingsProvider value={settings(false)}>
      <LevelPill level="Naranja" />
    </ProjectSettingsProvider>,
  );
  expect(screen.getByText('Naranja')).toBeInTheDocument();
  rerender(
    <ProjectSettingsProvider value={settings(true)}>
      <LevelPill level="Naranja" />
    </ProjectSettingsProvider>,
  );
  expect(screen.getByText('Naranja – Requiere intervención preventiva')).toBeInTheDocument();
});

it('lets an administrator switch MASCLI 4.0 on for the active project', async () => {
  const user = userEvent.setup();
  let sent: unknown;
  let scope: string | null = null;
  let current = settings(false);
  server.use(
    http.get('*/system/v4/settings', () => HttpResponse.json(current)),
    http.put('*/system/v4/settings', async ({ request }) => {
      sent = await request.json();
      scope = request.headers.get('X-MASCLI-Scope');
      current = settings(true);
      return HttpResponse.json(current);
    }),
  );
  renderPage('admin');
  expect(await screen.findByText('MASCLI 3.0 (4.0 desactivado)')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Activar MASCLI 4.0' }));
  expect(await screen.findByText('MASCLI 4.0 activado')).toBeInTheDocument();
  expect(sent).toEqual({ version4: true });
  expect(scope).toBe('ACME/P1');
  expect(screen.getByRole('button', { name: 'Volver a MASCLI 3.0' })).toBeInTheDocument();
});

it('saves edited colour meanings', async () => {
  const user = userEvent.setup();
  let sent: { level_meanings?: Record<string, string> } = {};
  server.use(
    http.get('*/system/v4/settings', () => HttpResponse.json(settings(true))),
    http.put('*/system/v4/settings', async ({ request }) => {
      sent = (await request.json()) as typeof sent;
      return HttpResponse.json({ ...settings(true), level_meanings: sent.level_meanings });
    }),
  );
  renderPage('admin');
  const rojo = await screen.findByLabelText('Rojo');
  await user.clear(rojo);
  await user.type(rojo, 'Atención inmediata');
  await user.click(screen.getByRole('button', { name: 'Guardar significados' }));
  expect(await screen.findByText('Significados guardados.')).toBeInTheDocument();
  expect(sent.level_meanings).toEqual({ ...meanings, Rojo: 'Atención inmediata' });
});

it('saves the project wording of a suggested action', async () => {
  const user = userEvent.setup();
  let sent: unknown;
  server.use(
    http.get('*/system/v4/settings', () => HttpResponse.json(settings(true))),
    http.put('*/system/v4/settings', async ({ request }) => {
      sent = await request.json();
      return HttpResponse.json(settings(true));
    }),
  );
  renderPage('admin');
  const field = await screen.findByLabelText('Nivel Naranja o Rojo');
  await user.clear(field);
  await user.type(field, 'Convocar mesa de diálogo.');
  await user.click(screen.getByRole('button', { name: 'Guardar acciones sugeridas' }));
  expect(await screen.findByText('Acciones sugeridas guardadas.')).toBeInTheDocument();
  expect(sent).toEqual({ recommendations: { reunion: 'Convocar mesa de diálogo.' } });
});

it('shows the settings read-only to other roles', async () => {
  server.use(http.get('*/system/v4/settings', () => HttpResponse.json(settings(true))));
  renderPage('consulta');
  expect(
    await screen.findByText('Solo un administrador puede cambiar la versión.'),
  ).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /MASCLI 3.0/ })).not.toBeInTheDocument();
  expect(screen.getByLabelText('Verde')).toHaveAttribute('readonly');
  expect(
    within(screen.getByLabelText('Vista previa de niveles')).getAllByRole('listitem'),
  ).toHaveLength(4);
});
