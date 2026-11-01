import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, expect, it } from 'vitest';
import { server } from '../../test/server.ts';
import { AdministrationPage } from './AdministrationPage.tsx';

const context = {
  scope: 'ACME/P1',
  projectId: 'P1',
  projectLabel: 'Proyecto Uno',
  role: 'admin' as const,
  username: 'admin',
  fullName: 'Admin Demo',
};
const account = {
  username: 'analyst',
  full_name: 'Ana Demo',
  role: 'analista',
  active: 1,
  created_at: '2026-10-13T12:00:00Z',
  google_email: null,
};
const renderPage = (role: 'admin' | 'consulta' = 'admin') =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <AdministrationPage {...context} role={role} />
    </QueryClientProvider>,
  );
beforeEach(() =>
  server.use(
    http.get('*/system/auth/accounts', () => HttpResponse.json([account])),
    http.get('*/system/auth/scopes', () =>
      HttpResponse.json([{ company_id: 'ACME', project_id: 'P1', label: 'Proyecto Uno' }]),
    ),
  ),
);
it('never requests privileged account data for consulta', async () => {
  let calls = 0;
  server.use(
    http.get('*/system/auth/accounts', () => {
      calls++;
      return HttpResponse.json([account]);
    }),
  );
  renderPage('consulta');
  expect(await screen.findByText(/Administración restringida/)).toBeInTheDocument();
  expect(calls).toBe(0);
  expect(screen.queryByRole('button', { name: 'Crear cuenta' })).not.toBeInTheDocument();
});
it('creates real identity accounts with scope header and clears password', async () => {
  const user = userEvent.setup();
  let sent: unknown;
  let scope: string | null = null;
  server.use(
    http.post('*/system/auth/accounts', async ({ request }) => {
      sent = await request.json();
      scope = request.headers.get('X-SIPGES-Scope');
      return HttpResponse.json({ ok: true, username: 'new-user', role: 'consulta' });
    }),
  );
  renderPage();
  await screen.findByText('Ana Demo');
  await user.type(screen.getByLabelText('Usuario nuevo'), 'new-user');
  await user.type(screen.getByLabelText('Nombre completo'), 'Persona Nueva');
  await user.type(screen.getByLabelText('Contraseña inicial'), 'Synthetic-Only-2026!');
  await user.click(screen.getByRole('button', { name: 'Crear cuenta' }));
  await screen.findByText('Cuenta creada.');
  expect(sent).toEqual({
    username: 'new-user',
    full_name: 'Persona Nueva',
    password: 'Synthetic-Only-2026!',
    role: 'consulta',
  });
  expect(scope).toBe('ACME/P1');
  expect(screen.getByLabelText('Contraseña inicial')).toHaveValue('');
});
it('requires confirmation before deactivation and surfaces last administrator denial', async () => {
  const user = userEvent.setup();
  let calls = 0;
  server.use(
    http.post('*/system/auth/accounts/analyst/deactivate', () => {
      calls++;
      return HttpResponse.json(
        { detail: 'No se permite desactivar el último administrador' },
        { status: 409 },
      );
    }),
  );
  renderPage();
  await user.click(await screen.findByRole('button', { name: 'Desactivar analyst' }));
  expect(calls).toBe(0);
  await user.click(screen.getByRole('button', { name: 'Confirmar desactivación' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'No se permite desactivar el último administrador',
  );
  expect(calls).toBe(1);
});
it('uses DELETE for confirmed scoped access revocation', async () => {
  const user = userEvent.setup();
  let sent: unknown;
  server.use(
    http.delete('*/system/auth/grants', async ({ request }) => {
      sent = await request.json();
      return HttpResponse.json({ ok: true });
    }),
  );
  renderPage();
  await user.type(screen.getByLabelText('Usuario del acceso'), 'analyst');
  await user.type(screen.getByLabelText('Empresa del acceso'), 'ACME');
  await user.type(screen.getByLabelText('Proyecto del acceso'), 'P1');
  await user.click(screen.getByRole('button', { name: 'Revocar acceso' }));
  expect(sent).toBeUndefined();
  await user.click(screen.getByRole('button', { name: 'Confirmar revocación' }));
  await waitFor(() =>
    expect(sent).toEqual({ username: 'analyst', company_id: 'ACME', project_id: 'P1' }),
  );
});
it('enables own MFA and removes its secret after success', async () => {
  const user = userEvent.setup();
  server.use(
    http.post('*/system/auth/totp/setup', () =>
      HttpResponse.json({
        secret: 'SYNTHETICSECRET',
        otpauth_uri: 'otpauth://totp/SIPGES:admin?secret=SYNTHETICSECRET',
        instruction: 'Use una aplicación TOTP.',
      }),
    ),
    http.post('*/system/auth/totp/enable', async ({ request }) => {
      expect(await request.json()).toEqual({ code: '123456' });
      return HttpResponse.json({ ok: true, totp_enabled: true });
    }),
  );
  renderPage();
  await user.click(screen.getByRole('button', { name: 'Configurar mi MFA' }));
  expect(await screen.findByText('SYNTHETICSECRET')).toBeInTheDocument();
  await user.type(screen.getByLabelText('Código TOTP'), '123456');
  await user.click(screen.getByRole('button', { name: 'Activar MFA' }));
  await screen.findByText('MFA activado.');
  expect(screen.queryByText('SYNTHETICSECRET')).not.toBeInTheDocument();
});

it('creates a project with explicit initial access and refreshes authorized catalog', async () => {
  const user = userEvent.setup();
  let calls = 0;
  let sent: unknown;
  server.use(
    http.get('*/system/auth/scopes', () => {
      calls++;
      return HttpResponse.json([{ company_id: 'ACME', project_id: 'P1', label: 'Proyecto Uno' }]);
    }),
    http.post('*/system/auth/scopes', async ({ request }) => {
      expect(request.headers.get('X-SIPGES-Scope')).toBe('ACME/P1');
      sent = await request.json();
      return HttpResponse.json({ ok: true, scope: 'ACME/P2' });
    }),
  );
  renderPage();
  await user.type(screen.getByLabelText('Empresa nueva'), 'ACME');
  await user.type(screen.getByLabelText('Proyecto nuevo'), 'P2');
  await user.type(screen.getByLabelText('Nombre del proyecto'), 'Proyecto Dos');
  await user.type(screen.getByLabelText('Usuario con acceso inicial'), 'analyst');
  await user.click(screen.getByRole('button', { name: 'Crear proyecto' }));
  await screen.findByText('Proyecto creado con acceso inicial.');
  expect(sent).toEqual({
    company_id: 'ACME',
    project_id: 'P2',
    label: 'Proyecto Dos',
    username: 'analyst',
  });
  await waitFor(() => expect(calls).toBeGreaterThan(1));
});

it('blocks a duplicate mutation while the server is processing access', async () => {
  const user = userEvent.setup();
  let calls = 0;
  let resolve!: () => void;
  const gate = new Promise<void>((done) => {
    resolve = done;
  });
  server.use(
    http.post('*/system/auth/grants', async ({ request }) => {
      calls++;
      expect(await request.json()).toEqual({
        username: 'analyst',
        company_id: 'ACME',
        project_id: 'P1',
      });
      await gate;
      return HttpResponse.json({ ok: true });
    }),
  );
  renderPage();
  await user.type(screen.getByLabelText('Usuario del acceso'), 'analyst');
  await user.type(screen.getByLabelText('Empresa del acceso'), 'ACME');
  await user.type(screen.getByLabelText('Proyecto del acceso'), 'P1');
  await user.dblClick(screen.getByRole('button', { name: 'Conceder acceso' }));
  await waitFor(() => expect(calls).toBe(1));
  expect(screen.getByRole('button', { name: 'Conceder acceso' })).toBeDisabled();
  resolve();
  await screen.findByText('Acceso concedido.');
});

it('does not invalidate a new project after an old page mutation completes', async () => {
  const user = userEvent.setup();
  let resolve!: () => void;
  let started = false;
  let catalogCalls = 0;
  const gate = new Promise<void>((done) => {
    resolve = done;
  });
  server.use(
    http.get('*/system/auth/scopes', () => {
      catalogCalls++;
      return HttpResponse.json([]);
    }),
    http.post('*/system/auth/grants', async () => {
      started = true;
      await gate;
      return HttpResponse.json({ ok: true });
    }),
  );
  const view = renderPage();
  await user.type(screen.getByLabelText('Usuario del acceso'), 'analyst');
  await user.type(screen.getByLabelText('Empresa del acceso'), 'ACME');
  await user.type(screen.getByLabelText('Proyecto del acceso'), 'P1');
  await user.click(screen.getByRole('button', { name: 'Conceder acceso' }));
  await waitFor(() => expect(started).toBe(true));
  view.unmount();
  const before = catalogCalls;
  resolve();
  await gate;
  await new Promise<void>((done) => setTimeout(done, 30));
  expect(catalogCalls).toBe(before);
});
it('links and unlinks Google sign-in for an existing account', async () => {
  const user = userEvent.setup();
  const sent: { path: string; body: unknown }[] = [];
  server.use(
    http.post('*/system/auth/accounts/:username/google', async ({ request, params }) => {
      const body = (await request.json()) as { email: string };
      sent.push({ path: String(params.username), body });
      return HttpResponse.json({
        ok: true,
        username: String(params.username),
        google_email: body.email || null,
      });
    }),
  );
  renderPage();
  await screen.findByText('Ana Demo');
  await user.type(screen.getByLabelText('Usuario a vincular'), 'analyst');
  await user.type(screen.getByLabelText('Correo de Google'), 'ana.demo@example.com');
  await user.click(screen.getByRole('button', { name: 'Guardar vínculo' }));
  expect(
    await screen.findByText('analyst ya puede entrar con Google (ana.demo@example.com).'),
  ).toBeInTheDocument();
  expect(screen.getByLabelText('Usuario a vincular')).toHaveValue('');

  await user.type(screen.getByLabelText('Usuario a vincular'), 'analyst');
  await user.click(screen.getByRole('button', { name: 'Guardar vínculo' }));
  expect(await screen.findByText('Se quitó el ingreso con Google de analyst.')).toBeInTheDocument();
  expect(sent).toEqual([
    { path: 'analyst', body: { email: 'ana.demo@example.com' } },
    { path: 'analyst', body: { email: '' } },
  ]);
});
