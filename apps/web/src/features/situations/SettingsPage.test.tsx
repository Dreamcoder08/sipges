import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { ProjectSettingsProvider } from '../../shared/lib/project-settings.tsx';
import { LevelPill } from '../../shared/ui/Badges.tsx';
import { server } from '../../test/server.ts';
import { SettingsPage } from './SettingsPage.tsx';
import { type SettingsSection, settingsSearch } from './sections.ts';

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
const renderPage = (
  role: 'admin' | 'consulta',
  section: SettingsSection = 'proyecto',
  extra: Partial<Parameters<typeof SettingsPage>[0]> = {},
) =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <SettingsPage {...context} role={role} section={section} {...extra} />
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

it('presents the project as SIPGES with no switch to turn it on or off', async () => {
  server.use(http.get('*/system/v4/settings', () => HttpResponse.json(settings())));
  renderPage('admin');
  expect(await screen.findByRole('heading', { name: 'SIPGES' })).toBeInTheDocument();
  expect(screen.queryByText(/SIPGES 3\.0/)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Activar|Volver a/ })).not.toBeInTheDocument();
  expect(screen.getByText('Significado de cada color')).toBeInTheDocument();
  expect(screen.getByText('Fase del proyecto')).toBeInTheDocument();
  expect(screen.getByText('Fuentes RSS regionales')).toBeInTheDocument();
});

it('opens on Apariencia for every role, with a section nav like Claude settings', async () => {
  server.use(http.get('*/system/v4/settings', () => HttpResponse.json(settings())));
  renderPage('consulta', undefined, { section: undefined });
  const nav = screen.getByRole('navigation', { name: 'Secciones de Configuración' });
  expect(
    within(nav)
      .getAllByRole('link')
      .map((link) => link.textContent),
  ).toEqual([
    'Cuenta',
    'Apariencia',
    'Proyecto',
    'Privacidad y datos',
    'Notificaciones',
    'Integraciones',
  ]);
  expect(within(nav).getByRole('link', { name: 'Cuenta' })).toHaveAttribute(
    'href',
    '/version-4?seccion=cuenta',
  );
  expect(within(nav).getByRole('link', { name: 'Apariencia' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  expect(within(nav).getByRole('link', { name: 'Proyecto' })).toHaveAttribute(
    'href',
    '/version-4?seccion=proyecto',
  );
  expect(within(nav).getByRole('link', { name: 'Integraciones' })).toHaveAttribute(
    'href',
    '/integraciones',
  );
  expect(screen.getByRole('group', { name: 'Tema' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'SIPGES' })).not.toBeInTheDocument();
  expect(screen.queryByRole('checkbox', { name: 'Envío a IA externa' })).not.toBeInTheDocument();
});

it('shows one section at a time and goes to another through the URL', async () => {
  const user = userEvent.setup();
  const visited: string[] = [];
  server.use(http.get('*/system/v4/settings', () => HttpResponse.json(settings())));
  renderPage('admin', 'privacidad', { onNavigate: (href) => visited.push(href) });
  expect(await screen.findByRole('checkbox', { name: 'Envío a IA externa' })).toBeInTheDocument();
  expect(screen.queryByRole('group', { name: 'Tema' })).not.toBeInTheDocument();
  expect(screen.queryByText('Significado de cada color')).not.toBeInTheDocument();
  const nav = screen.getByRole('navigation', { name: 'Secciones de Configuración' });
  expect(within(nav).getByRole('link', { name: 'Privacidad y datos' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  within(nav).getByRole('link', { name: 'Proyecto' }).focus();
  await user.keyboard('{Enter}');
  await user.click(within(nav).getByRole('link', { name: 'Integraciones' }));
  expect(visited).toEqual(['/version-4?seccion=proyecto', '/integraciones']);
});

it('keeps the section nav working without a router', async () => {
  const user = userEvent.setup();
  server.use(http.get('*/system/v4/settings', () => HttpResponse.json(settings())));
  renderPage('admin', 'apariencia');
  await user.click(screen.getByRole('link', { name: 'Proyecto' }));
  expect(await screen.findByRole('heading', { name: 'SIPGES' })).toBeInTheDocument();
});

it('shows Cuenta with the signed-in user and the active sessions', async () => {
  server.use(
    http.get('*/system/auth/sessions', () =>
      HttpResponse.json({
        sessions: [
          {
            id: 'a'.repeat(32),
            created_at: '2026-11-12T11:00:00Z',
            expires_at: '2026-11-12T19:00:00Z',
            method: 'password',
            current: true,
          },
        ],
      }),
    ),
  );
  renderPage('consulta', 'cuenta');
  expect(screen.getByRole('heading', { name: 'Cuenta' })).toBeInTheDocument();
  expect(screen.getByText('Admin Demo')).toBeInTheDocument();
  expect(await screen.findByText('Este dispositivo')).toBeInTheDocument();
  const nav = screen.getByRole('navigation', { name: 'Secciones de Configuración' });
  expect(within(nav).getByRole('link', { name: 'Cuenta' })).toHaveAttribute('aria-current', 'page');
  expect(screen.queryByRole('group', { name: 'Tema' })).not.toBeInTheDocument();
});

it('shows only the notification preference that exists today: this device', () => {
  renderPage('consulta', 'notificaciones', {
    notifications: <p>Recibir avisos en este dispositivo</p>,
  });
  expect(screen.getByRole('heading', { name: 'Notificaciones' })).toBeInTheDocument();
  expect(screen.getByText('Recibir avisos en este dispositivo')).toBeInTheDocument();
  expect(screen.queryByRole('group', { name: 'Tema' })).not.toBeInTheDocument();
});

it('accepts only known sections in the URL', () => {
  expect(settingsSearch.parse({ seccion: 'privacidad' })).toEqual({ seccion: 'privacidad' });
  expect(settingsSearch.parse({ seccion: 'cuenta' })).toEqual({ seccion: 'cuenta' });
  expect(settingsSearch.parse({ seccion: 'facturacion' })).toEqual({ seccion: undefined });
  expect(settingsSearch.parse({ seccion: 7 })).toEqual({ seccion: undefined });
  expect(settingsSearch.parse({})).toEqual({ seccion: undefined });
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

const COPY =
  'Envío a IA externa — los datos salen siempre seudonimizados; nunca se envían nombres reales ni datos sensibles. Requiere revisión legal (Ley 29733).';

it('shows «Envío a IA externa» off by default, with the privacy copy', async () => {
  server.use(http.get('*/system/v4/settings', () => HttpResponse.json(settings())));
  renderPage('admin', 'privacidad');
  const toggle = await screen.findByRole('checkbox', { name: 'Envío a IA externa' });
  expect(toggle).not.toBeChecked();
  expect(screen.getByText(COPY)).toBeInTheDocument();
});

it('lets an administrator turn «Envío a IA externa» on and sends only that setting', async () => {
  const user = userEvent.setup();
  let sent: unknown;
  let stored: ReturnType<typeof settings> & { external_ai?: { enabled: boolean } } = settings();
  server.use(
    http.get('*/system/v4/settings', () => HttpResponse.json(stored)),
    http.put('*/system/v4/settings', async ({ request }) => {
      sent = await request.json();
      stored = { ...settings(), external_ai: { enabled: true } };
      return HttpResponse.json(stored);
    }),
  );
  renderPage('admin', 'privacidad');
  await user.click(await screen.findByRole('checkbox', { name: 'Envío a IA externa' }));
  expect(await screen.findByText('Envío a IA externa activado.')).toBeInTheDocument();
  expect(sent).toEqual({ external_ai: { enabled: true } });
  expect(await screen.findByRole('checkbox', { name: 'Envío a IA externa' })).toBeChecked();
});

it('shows the switch to everyone else read-only', async () => {
  server.use(
    http.get('*/system/v4/settings', () =>
      HttpResponse.json({ ...settings(), external_ai: { enabled: true } }),
    ),
  );
  renderPage('consulta', 'privacidad');
  const toggle = await screen.findByRole('checkbox', { name: 'Envío a IA externa' });
  expect(toggle).toBeChecked();
  expect(toggle).toBeDisabled();
});

it('lets an administrator save and clear the project location the maps open on', async () => {
  const user = userEvent.setup();
  const sent: unknown[] = [];
  let current: Record<string, unknown> = settings();
  server.use(
    http.get('*/system/v4/settings', () => HttpResponse.json(current)),
    http.put('*/system/v4/settings', async ({ request }) => {
      const body = (await request.json()) as { location?: unknown };
      sent.push(body);
      current = {
        ...current,
        location: body.location,
        updated_at: `2026-10-19T12:0${sent.length}:00Z`,
      };
      return HttpResponse.json(current);
    }),
  );
  renderPage('admin');
  const locationCard = async () =>
    (await screen.findByRole('heading', { name: 'Ubicación del proyecto' })).closest(
      'section',
    ) as HTMLElement;
  const card = await locationCard();
  expect(within(card).getByText(/Sin ubicación guardada/)).toBeInTheDocument();
  await user.type(within(card).getByLabelText('Lugar'), 'Tambogrande, Piura');
  await user.type(within(card).getByLabelText('Oeste (longitud)'), '-80.548');
  await user.type(within(card).getByLabelText('Sur (latitud)'), '-5.057');
  await user.type(within(card).getByLabelText('Este (longitud)'), '-80.218');
  await user.type(within(card).getByLabelText('Norte (latitud)'), '-4.880');
  await user.click(within(card).getByRole('button', { name: 'Guardar ubicación' }));
  expect(await screen.findByText('Ubicación del proyecto guardada.')).toBeInTheDocument();
  expect(sent[0]).toEqual({
    location: { place: 'Tambogrande, Piura', extent: [-80.548, -5.057, -80.218, -4.88] },
  });
  // The form remounts with the saved settings.
  const saved = await locationCard();
  expect(within(saved).getByText(/Guardada: Tambogrande, Piura/)).toBeInTheDocument();
  await user.click(within(saved).getByRole('button', { name: 'Quitar ubicación' }));
  expect(await screen.findByText('Ubicación del proyecto quitada.')).toBeInTheDocument();
  expect(sent[1]).toEqual({ location: null });
});

it('shows the project location read-only to other roles', async () => {
  server.use(
    http.get('*/system/v4/settings', () =>
      HttpResponse.json({
        ...settings(),
        location: { place: 'Tambogrande, Piura', extent: [-80.548, -5.057, -80.218, -4.88] },
      }),
    ),
  );
  renderPage('consulta');
  expect(await screen.findByLabelText('Lugar')).toHaveValue('Tambogrande, Piura');
  expect(screen.getByLabelText('Lugar')).toHaveAttribute('readonly');
  expect(screen.queryByRole('button', { name: 'Guardar ubicación' })).toBeNull();
});
