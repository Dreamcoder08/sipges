import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { server } from '../../test/server.ts';
import { AutomationPage } from './AutomationPage.tsx';

const context = {
  scope: 'ACME/P1',
  projectId: 'P1',
  projectLabel: 'Proyecto Uno',
  username: 'admin',
  fullName: 'Admin Demo',
};

const overview = {
  sources: [
    { module: 'Alertas', label: 'Alertas' },
    { module: 'Vinculos', label: 'Vínculos entre registros' },
  ],
  actions: ['CREATE', 'UPDATE', 'DELETE'],
  operators: ['eq', 'neq', 'contains', 'gte', 'lte', 'present', 'absent'],
  rules: [
    {
      id: 1,
      name: 'Alertas altas',
      enabled: true,
      module: 'Alertas',
      actions: ['CREATE'],
      conditions: [{ field: 'Nivel', op: 'eq', value: 'Alto' }],
      steps: [
        { kind: 'notify', title: 'Alerta {id}' },
        { kind: 'channel', channel_id: 4, title: 'Alerta {id}' },
      ],
      created_by: 'admin',
      updated_at: '2026-10-14T10:00:00Z',
    },
  ],
  channels: [
    {
      id: 4,
      kind: 'slack',
      name: 'Equipo social',
      target_hint: 'hooks.slack.com',
      created_by: 'admin',
      created_at: '2026-10-14T09:00:00Z',
    },
  ],
  runs: [
    {
      id: 9,
      rule_id: 1,
      rule_name: 'Alertas altas',
      kind: 'channel',
      status: 'pending',
      attempts: 2,
      last_error: 'Canal slack: respuesta HTTP 503',
      event: {
        audit_id: 30,
        at: '2026-10-14T10:01:00Z',
        module: 'Alertas',
        record_id: 'AL-1',
        action: 'CREATE',
        detail: 'Registro creado',
      },
      created_at: '2026-10-14T10:01:00Z',
      finished_at: null,
      next_attempt_at: '2026-10-14T10:05:00Z',
    },
  ],
};

const renderPage = (role: 'admin' | 'analista' = 'admin') =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <AutomationPage {...context} role={role} />
    </QueryClientProvider>,
  );

it('describes rules, channels and runs in plain language', async () => {
  server.use(http.get('*/system/automations', () => HttpResponse.json(overview)));
  renderPage();
  expect(
    await screen.findByText(
      'Cuando hay creación en Alertas y Nivel es igual a «Alto»: aviso en la bandeja + mensaje a Equipo social.',
    ),
  ).toBeInTheDocument();
  expect(screen.getByText('Slack · hooks.slack.com')).toBeInTheDocument();
  expect(screen.getByText('Pendiente (2 intentos)')).toBeInTheDocument();
  expect(screen.getByText('Canal slack: respuesta HTTP 503')).toBeInTheDocument();
});

it('creates a channel with write-only settings and a rule that uses it', async () => {
  const user = userEvent.setup();
  const posted: { path: string; body: unknown }[] = [];
  server.use(
    http.get('*/system/automations', () => HttpResponse.json({ ...overview, rules: [], runs: [] })),
    http.post('*/system/automations/:kind', async ({ request, params }) => {
      posted.push({ path: String(params.kind), body: await request.json() });
      return HttpResponse.json({ ok: true, id: 5 });
    }),
  );
  renderPage();
  await screen.findByText('Aún no hay reglas. Crea la primera con el formulario.');

  await user.selectOptions(screen.getByLabelText('Tipo de canal'), 'telegram');
  await user.type(screen.getByLabelText('Nombre del canal'), 'Guardia');
  await user.type(screen.getByLabelText('Token del bot'), '123456:secret');
  await user.type(screen.getByLabelText('ID del chat o @canal'), '-100123');
  await user.click(screen.getByRole('button', { name: 'Crear canal' }));
  expect(await screen.findByText('Canal creado.')).toBeInTheDocument();
  expect(posted[0]).toEqual({
    path: 'channels',
    body: {
      kind: 'telegram',
      name: 'Guardia',
      settings: { bot_token: '123456:secret', chat_id: '-100123' },
    },
  });

  await user.type(screen.getByLabelText('Nombre de la regla'), 'Demandas urgentes');
  await user.click(screen.getByRole('button', { name: 'Añadir condición' }));
  await user.type(screen.getByLabelText(/^Campo/), 'Prioridad');
  await user.type(screen.getByLabelText('Valor'), 'Alta');
  await user.selectOptions(screen.getByLabelText('Acción'), 'Enviar a Equipo social');
  await user.click(screen.getByRole('button', { name: 'Crear regla' }));
  expect(await screen.findByText('Regla creada.')).toBeInTheDocument();
  expect(posted[1]).toEqual({
    path: 'rules',
    body: {
      name: 'Demandas urgentes',
      enabled: true,
      module: 'Alertas',
      actions: ['CREATE'],
      conditions: [{ field: 'Prioridad', op: 'eq', value: 'Alta' }],
      steps: [{ kind: 'channel', channel_id: 4, title: '{modulo} {id}: nuevo registro' }],
    },
  });
});

it('stays closed to other roles without calling the API', () => {
  let calls = 0;
  server.use(
    http.get('*/system/automations', () => {
      calls++;
      return HttpResponse.json(overview);
    }),
  );
  renderPage('analista');
  expect(screen.getByText(/solo las configura el rol administrador/)).toBeInTheDocument();
  expect(calls).toBe(0);
});
