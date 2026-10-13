import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { api, resetApi, server } from '../test/server.ts';
import { App } from './App.tsx';

const at = (path: string) => window.history.replaceState(null, '', path);
const signIn = () => {
  api.me = { username: 'persona', full_name: 'Persona Sintética', role: 'admin' };
};

beforeEach(() => resetApi());

describe('sign-in', () => {
  it('sends anonymous visitors to the login form and back to where they were', async () => {
    at('/irsa');
    render(<App />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Usuario'), 'persona');
    await user.type(screen.getByLabelText('Contraseña'), 'synthetic-pass-123');
    await user.click(screen.getByRole('button', { name: 'Ingresar' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'IRSA-MASCLI' })).toBeVisible();
    expect(window.location.pathname).toBe('/irsa');
    expect(api.requests).toContain('POST /login');
  });

  it('shows the server message and asks for the OTP only when required', async () => {
    api.otpRequired = true;
    at('/');
    render(<App />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Usuario'), 'persona');
    await user.type(screen.getByLabelText('Contraseña'), 'wrong-password');
    await user.click(screen.getByRole('button', { name: 'Ingresar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Credenciales inválidas');
    expect(screen.queryByLabelText('Código de autenticación')).toBeNull();

    await user.clear(screen.getByLabelText('Contraseña'));
    await user.type(screen.getByLabelText('Contraseña'), 'synthetic-pass-123');
    await user.click(screen.getByRole('button', { name: 'Ingresar' }));
    const otp = await screen.findByLabelText('Código de autenticación');
    await user.type(otp, '12a3456');
    expect(otp).toHaveValue('123456');
    await user.click(screen.getByRole('button', { name: 'Ingresar' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Dashboard ejecutivo' }),
    ).toBeVisible();
  });

  it('never redirects outside the app after sign-in', async () => {
    at('/login?redirect=%2F%2Fevil.example%2Fx');
    render(<App />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Usuario'), 'persona');
    await user.type(screen.getByLabelText('Contraseña'), 'synthetic-pass-123');
    await user.click(screen.getByRole('button', { name: 'Ingresar' }));
    await screen.findByRole('heading', { level: 1, name: 'Dashboard ejecutivo' });
    expect(window.location.pathname).toBe('/');
  });

  it('returns to the login form when the API reports an ended session', async () => {
    signIn();
    server.use(
      http.get('/api/dashboard', () =>
        HttpResponse.json({ detail: 'Inicie sesión para acceder a MASCLI' }, { status: 401 }),
      ),
    );
    at('/');
    render(<App />);
    expect(await screen.findByLabelText('Usuario')).toBeVisible();
    expect(window.location.search).toContain('redirect=%2F');
  });

  it('signs out through the API', async () => {
    signIn();
    at('/');
    render(<App />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Salir' }));
    expect(await screen.findByLabelText('Usuario')).toBeVisible();
    expect(api.requests).toContain('POST /logout');
  });
});

describe('active project', () => {
  it('asks for a project when several are granted and none is active', async () => {
    signIn();
    resetApi({
      me: api.me,
      scope: null,
      scopes: [
        { company_id: 'DEMO', project_id: 'PRJ-DEMO', label: 'Proyecto Demo' },
        { company_id: 'DEMO', project_id: 'PRJ-NORTE', label: 'Proyecto Norte' },
      ],
    });
    at('/');
    render(<App />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Proyecto Norte/ }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Dashboard ejecutivo' }),
    ).toBeVisible();
    expect(api.scope).toBe('DEMO/PRJ-NORTE');
    expect(screen.getByLabelText('Proyecto activo')).toHaveValue('DEMO/PRJ-NORTE');
  });

  it('switches project on the server and reloads the data', async () => {
    signIn();
    api.scopes.push({ company_id: 'DEMO', project_id: 'PRJ-NORTE', label: 'Proyecto Norte' });
    at('/');
    render(<App />);
    const user = userEvent.setup();
    const select = await screen.findByLabelText('Proyecto activo');
    await waitFor(() => expect(select).toBeEnabled());
    const before = api.requests.filter((r) => r === 'GET /api/dashboard').length;
    await user.selectOptions(select, 'DEMO/PRJ-NORTE');
    await waitFor(() => expect(select).toHaveValue('DEMO/PRJ-NORTE'));
    expect(api.requests).toContain('POST /select-project');
    await waitFor(() =>
      expect(api.requests.filter((r) => r === 'GET /api/dashboard').length).toBeGreaterThan(before),
    );
  });
});

describe('dashboard and navigation', () => {
  it('renders the counters, charts, IRSA and model status from the API', async () => {
    signIn();
    at('/');
    render(<App />);
    expect(await screen.findByText('Actores analíticos')).toBeVisible();
    const summary = screen.getByText('Actores analíticos').closest('div');
    expect(summary).toHaveTextContent('7');
    expect(await screen.findByText('42.3')).toBeVisible();
    expect(screen.getByText('Amarillo', { selector: 'span' })).toBeVisible();
    expect(await screen.findByText('Conflicto por agua')).toBeVisible();
    expect(await screen.findByText('Motor sintético')).toBeVisible();
    const alerts = (
      await screen.findByRole('heading', { name: 'Alertas abiertas del proyecto' })
    ).closest('section');
    if (!alerts) throw new Error('missing alerts card');
    await waitFor(() =>
      expect(within(alerts).getByText('Naranja').closest('div')).toHaveTextContent('1'),
    );
    expect(within(alerts).getByText('Rojo').closest('div')).toHaveTextContent('0');
  });

  it('marks the current page, moves focus to its heading and shows pending screens', async () => {
    signIn();
    at('/');
    render(<App />);
    const user = userEvent.setup();
    const nav = await screen.findByRole('navigation', { name: 'Secciones' });
    expect(within(nav).getByRole('link', { name: 'Dashboard' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await user.click(within(nav).getByRole('link', { name: 'Auditoría' }));
    const heading = await screen.findByRole('heading', { level: 1, name: 'Auditoría' });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(within(nav).getByRole('link', { name: 'Auditoría' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByText('En migración')).toBeVisible();
    expect(document.title).toBe('Auditoría | MASCLI');
  });

  it('offers a skip link and a menu toggle for small screens', async () => {
    signIn();
    at('/');
    render(<App />);
    expect(
      await screen.findByRole('link', { name: 'Saltar al contenido principal' }),
    ).toHaveAttribute('href', '#contenido');
    const user = userEvent.setup();
    const toggle = screen.getByRole('button', { name: 'Abrir menú' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(screen.getByRole('button', { name: 'Cerrar menú' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Abrir menú' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });
});
