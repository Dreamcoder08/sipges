import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { server } from '../../test/server.ts';
import { SituationsPage } from './SituationsPage.tsx';

const situation = {
  key: 'tema:empleo local',
  kind: 'tema',
  label: 'Empleo local',
  level: 'Naranja',
  score: 3.07,
  trend: 'en aumento',
  summary:
    'Naranja – Requiere intervención preventiva: existen 3 registros recientes relacionados con empleo local y participación de Comunidad Norte, en aumento.',
  reasons: [
    {
      text: '3 registros relacionados con el tema «Empleo local» en 5 día(s).',
      records: ['Demandas:D-1', 'Narrativas:N-1', 'Eventos:EV-1'],
    },
  ],
  recommendations: [
    'Coordinar una reunión con los actores involucrados.',
    'Verificar la información con las fuentes y el equipo de campo antes de escalar.',
  ],
  records: [
    { module: 'Demandas', id: 'D-1', title: 'Empleo local', date: '2026-10-18' },
    { module: 'Narrativas', id: 'N-1', title: 'Trabajo', date: '2026-10-16' },
    { module: 'Eventos', id: 'EV-1', title: 'Reunión', date: '2026-10-14' },
  ],
  actors: ['Comunidad Norte'],
  territories: ['Norte'],
  topics: [],
  last_date: '2026-10-18',
};
const report = {
  generated_at: '2026-10-19T12:00:00Z',
  today: '2026-10-19',
  window_days: 90,
  considered: 3,
  undated: 1,
  situations: [situation],
  narratives: {
    total: 4,
    recent: 2,
    topics: [{ name: 'Agua', count: 4, recent: 2 }],
    platforms: [{ name: 'Facebook', count: 3 }],
    tone: { now: 100, then: 0 },
  },
  method: 'Registros con fecha…',
  limitations: ['No modifica el IRSA.'],
};
const context = {
  scope: 'ACME/P1',
  projectId: 'P1',
  projectLabel: 'Proyecto Uno',
  username: 'ana',
  fullName: 'Ana Demo',
};
const renderPage = (role: 'analista' | 'consulta') =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <SituationsPage {...context} role={role} />
    </QueryClientProvider>,
  );

it('explains a situation with links to its records and suggested actions', async () => {
  server.use(
    http.get('*/system/v4/situations', () => HttpResponse.json(report)),
    http.get('*/api/alertas', () => HttpResponse.json([])),
  );
  renderPage('consulta');
  expect(await screen.findByText(situation.summary)).toBeInTheDocument();
  expect(screen.getByText(/1 sin fecha no se consideran/)).toBeInTheDocument();
  const why = screen.getByRole('region', { name: 'Por qué: Empleo local' });
  expect(within(why).getByRole('link', { name: /Demandas D-1/ })).toHaveAttribute(
    'href',
    '/objeto/demandas/D-1',
  );
  const actions = screen.getByRole('region', { name: 'Acciones sugeridas: Empleo local' });
  expect(within(actions).getByText(situation.recommendations[0] ?? '')).toBeInTheDocument();
  expect(
    within(actions).getByText('Solo orientan: la decisión final es suya.'),
  ).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Crear alerta/ })).not.toBeInTheDocument();
  expect(
    screen.getByText(
      'Cambio de narrativa: el tono negativo pasa de 0 % a 100 % en las publicaciones más recientes.',
    ),
  ).toBeInTheDocument();
  expect(screen.getByText('Agua: 4 publicación(es), 2 esta semana')).toBeInTheDocument();
});

it('creates the alert only when a person asks, with the explanation and cited records', async () => {
  const user = userEvent.setup();
  let sent: { payload?: Record<string, unknown> } = {};
  const alerts: Record<string, unknown>[] = [];
  server.use(
    http.get('*/system/v4/situations', () => HttpResponse.json(report)),
    http.get('*/api/alertas', () => HttpResponse.json(alerts)),
    http.post('*/api/alertas', async ({ request }) => {
      sent = (await request.json()) as typeof sent;
      alerts.push({ _id: 'AL-7', ...sent.payload });
      return HttpResponse.json({ ok: true, id: 'AL-7' });
    }),
  );
  renderPage('analista');
  await user.click(
    await screen.findByRole('button', { name: 'Crear alerta naranja con esta explicación' }),
  );
  expect(await screen.findByRole('link', { name: 'AL-7' })).toHaveAttribute(
    'href',
    '/objeto/alertas/AL-7',
  );
  expect(sent.payload).toEqual({
    Proyecto_ID: 'P1',
    Proyecto: 'Proyecto Uno',
    Fecha: '2026-10-19',
    Causa: situation.summary,
    Territorio: 'Norte',
    Nivel_Preliminar: 'Naranja',
    Estado: 'Abierta',
    Accion_Sugerida: situation.recommendations.join('\n'),
    Origen: 'MASCLI 4.0',
    Situacion: 'tema:empleo local',
    Explicacion: situation.reasons[0]?.text,
    Registros_Relacionados: ['Demandas:D-1', 'Narrativas:N-1', 'Eventos:EV-1'],
  });
  expect(screen.queryByRole('button', { name: /Crear alerta/ })).not.toBeInTheDocument();
});

it('does not offer a second alert for a situation that already has one', async () => {
  server.use(
    http.get('*/system/v4/situations', () => HttpResponse.json(report)),
    http.get('*/api/alertas', () =>
      HttpResponse.json([{ _id: 'AL-3', Origen: 'MASCLI 4.0', Situacion: 'tema:empleo local' }]),
    ),
  );
  renderPage('analista');
  expect(await screen.findByRole('link', { name: 'AL-3' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Crear alerta/ })).not.toBeInTheDocument();
});
it('shows lessons the team recorded earlier about the same situation', async () => {
  server.use(
    http.get('*/system/v4/situations', () =>
      HttpResponse.json({
        ...report,
        situations: [
          {
            ...situation,
            lessons: [
              {
                id: 'LEC-1',
                date: '2026-03-02',
                learned: 'Convocar a la junta de regantes antes de cualquier obra',
              },
            ],
          },
        ],
      }),
    ),
    http.get('*/api/alertas', () => HttpResponse.json([])),
  );
  renderPage('consulta');
  expect(await screen.findByText('Lecciones previas')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'LEC-1' })).toHaveAttribute(
    'href',
    '/objeto/lecciones/LEC-1',
  );
  expect(
    screen.getByText(/Convocar a la junta de regantes antes de cualquier obra/),
  ).toBeInTheDocument();
});
