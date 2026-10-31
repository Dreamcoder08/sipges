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
const settings = () => ({
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
  phase: null as 'exploracion' | 'construccion' | 'operacion' | 'cierre' | null,
  phases: [
    {
      id: 'exploracion' as const,
      label: 'Exploración',
      weights: null as Record<string, number> | null,
      suggestion: { G: 0.2, A: 0.25, D: 0.15, N: 0.2, E: 0.1, I: 0.1 },
    },
    {
      id: 'operacion' as const,
      label: 'Operación',
      weights: null as Record<string, number> | null,
      suggestion: { G: 0.15, A: 0.15, D: 0.2, N: 0.15, E: 0.25, I: 0.1 },
    },
  ],
  updated_by: 'admin',
  updated_at: '2026-10-19T12:00:00Z',
});
const feed = {
  id: 1,
  name: 'Radio sintética',
  url: 'https://radio.example.pe/feed',
  keywords: ['agua'],
  territory: '',
  authorization_note: 'Aprobada (sintético).',
  enabled: true,
  updated_by: 'admin',
  updated_at: '2026-10-19T12:00:00Z',
  last_poll_at: '2026-10-19T12:30:00Z',
  last_poll_error: '',
  last_imported: 2,
  last_matched: 3,
};
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

it('shows the colour alone until the settings load, then colour with meaning, with no switch', () => {
  const { rerender } = render(<LevelPill level="Naranja" />);
  expect(screen.getByText('Naranja')).toBeInTheDocument();
  rerender(
    <ProjectSettingsProvider value={settings()}>
      <LevelPill level="Naranja" />
    </ProjectSettingsProvider>,
  );
  expect(screen.getByText('Naranja – Requiere intervención preventiva')).toBeInTheDocument();
});

it('presents the project as MASCLI 4.0 with no switch to turn it on or off', async () => {
  server.use(http.get('*/system/v4/settings', () => HttpResponse.json(settings())));
  renderPage('admin');
  expect(await screen.findByRole('heading', { name: 'MASCLI 4.0' })).toBeInTheDocument();
  expect(screen.queryByText(/MASCLI 3\.0/)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Activar|Volver a/ })).not.toBeInTheDocument();
  expect(screen.getByText('Significado de cada color')).toBeInTheDocument();
  expect(screen.getByText('Fase del proyecto')).toBeInTheDocument();
  expect(screen.getByText('Fuentes RSS regionales')).toBeInTheDocument();
});

it('saves edited colour meanings', async () => {
  const user = userEvent.setup();
  let sent: { level_meanings?: Record<string, string> } = {};
  server.use(
    http.get('*/system/v4/settings', () => HttpResponse.json(settings())),
    http.put('*/system/v4/settings', async ({ request }) => {
      sent = (await request.json()) as typeof sent;
      return HttpResponse.json({ ...settings(), level_meanings: sent.level_meanings });
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
    http.get('*/system/v4/settings', () => HttpResponse.json(settings())),
    http.put('*/system/v4/settings', async ({ request }) => {
      sent = await request.json();
      return HttpResponse.json(settings());
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
  server.use(http.get('*/system/v4/settings', () => HttpResponse.json(settings())));
  renderPage('consulta');
  expect(await screen.findByLabelText('Verde')).toHaveAttribute('readonly');
  expect(screen.queryByRole('button', { name: 'Guardar significados' })).not.toBeInTheDocument();
  expect(
    within(screen.getByLabelText('Vista previa de niveles')).getAllByRole('listitem'),
  ).toHaveLength(4);
});

it('sets the project phase and saves its IRSA weights from the suggestion', async () => {
  const user = userEvent.setup();
  const sent: unknown[] = [];
  let current = settings();
  server.use(
    http.get('*/system/v4/settings', () => HttpResponse.json(current)),
    http.put('*/system/v4/settings', async ({ request }) => {
      const body = (await request.json()) as { phase?: 'operacion' };
      sent.push(body);
      current = {
        ...current,
        ...(body.phase ? { phase: body.phase } : {}),
        updated_at: `2026-10-19T12:0${sent.length}:00Z`,
      };
      return HttpResponse.json(current);
    }),
  );
  renderPage('admin');
  expect(await screen.findByText('Fase sin definir')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Operación' }));
  expect(await screen.findByText('Fase del proyecto guardada.')).toBeInTheDocument();
  expect(
    screen.getByText(
      'La fase Operación no tiene pesos guardados: el IRSA usa los pesos generales.',
    ),
  ).toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText('Pesos de la fase'), 'operacion');
  expect(screen.getByLabelText('E · Ambiental-territorial')).toHaveValue(0.25);
  const e = screen.getByLabelText('E · Ambiental-territorial');
  await user.clear(e);
  await user.type(e, '0.5');
  expect(screen.getByRole('button', { name: 'Guardar pesos de la fase' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Usar sugerencia preliminar' }));
  await user.click(screen.getByRole('button', { name: 'Guardar pesos de la fase' }));
  expect(await screen.findByText('Pesos de la fase guardados.')).toBeInTheDocument();
  expect(sent).toEqual([
    { phase: 'operacion' },
    { phase_weights: { operacion: { G: 0.15, A: 0.15, D: 0.2, N: 0.15, E: 0.25, I: 0.1 } } },
  ]);
});

it('lists media sources, previews a new one and adds it', async () => {
  const user = userEvent.setup();
  let added: unknown;
  let previewed: unknown;
  server.use(
    http.get('*/system/v4/settings', () => HttpResponse.json(settings())),
    http.get('*/system/v4/media', () =>
      HttpResponse.json({ poll_minutes: 30, max_feeds: 20, feeds: [feed] }),
    ),
    http.post('*/system/v4/media/preview', async ({ request }) => {
      previewed = await request.json();
      return HttpResponse.json({
        total: 2,
        items: [
          {
            title: 'Paro por el agua',
            link: 'https://diario.example.pe/1',
            summary: '',
            published_at: null,
            matched: ['agua'],
          },
          {
            title: 'Festival',
            link: 'https://diario.example.pe/2',
            summary: '',
            published_at: null,
            matched: [],
          },
        ],
      });
    }),
    http.post('*/system/v4/media/feeds', async ({ request }) => {
      added = await request.json();
      return HttpResponse.json({ ...feed, id: 2 }, { status: 201 });
    }),
  );
  renderPage('admin');
  expect(await screen.findByText('Radio sintética')).toBeInTheDocument();
  expect(screen.getByText('Palabras clave: agua')).toBeInTheDocument();
  expect(screen.getByText(/3 coincidencias, 2 nuevas/)).toBeInTheDocument();
  await user.type(screen.getByLabelText('Nombre de la fuente'), 'Diario sintético');
  await user.type(screen.getByLabelText('URL del RSS o Atom'), 'https://diario.example.pe/rss');
  await user.type(screen.getByLabelText('Palabras clave (separadas por comas)'), 'agua, paro');
  await user.type(screen.getByLabelText('Nota de autorización'), 'Aprobada por el titular.');
  await user.click(screen.getByRole('button', { name: 'Probar fuente' }));
  expect(await screen.findByText(/2 noticias leídas; 1 coinciden/)).toBeInTheDocument();
  expect(previewed).toEqual({ url: 'https://diario.example.pe/rss', keywords: ['agua', 'paro'] });
  await user.click(screen.getByRole('button', { name: 'Agregar fuente' }));
  expect(await screen.findByText('Fuente agregada.')).toBeInTheDocument();
  expect(added).toEqual({
    name: 'Diario sintético',
    url: 'https://diario.example.pe/rss',
    keywords: ['agua', 'paro'],
    territory: '',
    authorization_note: 'Aprobada por el titular.',
    enabled: true,
  });
});

it('shows media sources read-only to other roles', async () => {
  server.use(
    http.get('*/system/v4/settings', () => HttpResponse.json(settings())),
    http.get('*/system/v4/media', () =>
      HttpResponse.json({ poll_minutes: 30, max_feeds: 20, feeds: [feed] }),
    ),
  );
  renderPage('consulta');
  expect(await screen.findByText('Radio sintética')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Consultar ahora' })).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Agregar fuente')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Operación' })).not.toBeInTheDocument();
});
