import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('offers Google sign-in only when the server has it configured', async () => {
    at('/login');
    const { unmount } = render(<App />);
    await screen.findByLabelText('Usuario');
    expect(screen.queryByRole('link', { name: 'Entrar con Google' })).toBeNull();
    unmount();

    server.use(http.get('/system/auth/providers', () => HttpResponse.json({ google: true })));
    at('/login');
    render(<App />);
    expect(await screen.findByRole('link', { name: 'Entrar con Google' })).toHaveAttribute(
      'href',
      '/auth/google',
    );
  });

  it('explains why a Google sign-in was refused and ignores unknown reasons', async () => {
    at('/login?google=not_linked');
    const { unmount } = render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Esa cuenta de Google no está autorizada en MASCLI',
    );
    unmount();

    at('/login?google=%3Cscript%3E');
    render(<App />);
    await screen.findByLabelText('Usuario');
    expect(screen.queryByRole('alert')).toBeNull();
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
    await user.click(await screen.findByRole('button', { name: /^Cuenta de Persona Sintética/ }));
    const sheet = screen.getByRole('dialog', { name: 'Cuenta' });
    expect(within(sheet).getByText('Persona Sintética')).toBeVisible();
    await user.click(within(sheet).getByRole('button', { name: 'Cerrar sesión' }));
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
    // Regression (functional audit, error 01): each counter shows its rule.
    const demands = screen.getByText('Demandas abiertas').closest('div');
    expect(demands).toHaveTextContent('3');
    expect(demands).toHaveTextContent('estado distinto de «Cerrada»');
    expect(
      within(demands as HTMLElement).getByRole('link', { name: 'Ver registros' }),
    ).toHaveAttribute('href', '/demandas');
    expect(await screen.findByText('42.3')).toBeVisible();
    expect(screen.getByText('Amarillo', { selector: 'p > span' })).toBeVisible();
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

  it('marks the current page, moves focus to its heading and opens rebuilt screens', async () => {
    signIn();
    at('/');
    render(<App />);
    const user = userEvent.setup();
    const nav = await screen.findByRole('navigation', { name: 'Secciones' });
    expect(within(nav).getByRole('link', { name: 'Dashboard' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    server.use(http.get('/system/audit', () => HttpResponse.json([])));
    await user.click(within(nav).getByRole('link', { name: 'Auditoría' }));
    const heading = await screen.findByRole('heading', { level: 1, name: 'Auditoría' });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(within(nav).getByRole('link', { name: 'Auditoría' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.queryByText('En migración')).toBeNull();
    expect(document.title).toBe('Auditoría | MASCLI');
  });

  it('offers a skip link and keeps sign-out out of the desktop top bar', async () => {
    signIn();
    at('/');
    render(<App />);
    expect(
      await screen.findByRole('link', { name: 'Saltar al contenido principal' }),
    ).toHaveAttribute('href', '#contenido');
    expect(screen.queryByRole('button', { name: 'Salir' })).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Navegación principal' })).toBeNull();
  });
});

describe('phone shell', () => {
  // The phone layout follows `matchMedia`, which jsdom lacks (docs/adr/0015).
  beforeEach(() => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(max-width: 60rem)',
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows the project as context and five destinations in a bottom bar', async () => {
    signIn();
    at('/');
    render(<App />);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Dashboard ejecutivo' }),
    ).toBeVisible();
    expect(screen.queryByRole('navigation', { name: 'Secciones' })).toBeNull();
    expect(screen.queryByLabelText('Proyecto activo')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Notificaciones/ })).toBeNull();
    const bar = screen.getByRole('navigation', { name: 'Navegación principal' });
    expect(
      within(bar)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Inicio', 'Monitoreo', 'Alertas', 'Territorio', 'Más']);
    expect(within(bar).getByRole('link', { name: 'Inicio' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('opens the remaining sections in a sheet and returns focus when it closes', async () => {
    signIn();
    at('/');
    render(<App />);
    const user = userEvent.setup();
    const more = await screen.findByRole('button', { name: 'Más' });
    await user.click(more);
    const sheet = screen.getByRole('dialog', { name: 'Más secciones' });
    const nav = within(sheet).getByRole('navigation', { name: 'Secciones' });
    expect(within(nav).getByRole('link', { name: 'Actores' })).toHaveFocus();
    expect(screen.getByRole('main', { hidden: true }).closest('[inert]')).not.toBeNull();
    expect(document.body.style.overflow).toBe('hidden');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(more).toHaveFocus();
    expect(document.querySelector('[inert]')).toBeNull();
    expect(document.body.style.overflow).toBe('');

    server.use(http.get('/system/audit', () => HttpResponse.json([])));
    await user.click(more);
    await user.click(screen.getByRole('link', { name: 'Auditoría' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Auditoría' })).toBeVisible();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: /^Más.*sección actual: Auditoría/ })).toHaveAttribute(
      'data-active',
      'true',
    );
  });

  it('opens on the "Hoy" summary with counters, alerts that need action and shortcuts', async () => {
    signIn();
    at('/');
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Resumen del proyecto' })).toBeVisible();
    expect(screen.queryByText(/Riesgo socioambiental con evidencia/)).toBeNull();
    const tiles = screen.getByRole('region', { name: 'Indicadores del día' });
    await waitFor(() =>
      expect(within(tiles).getByRole('link', { name: /Alertas activas/ })).toHaveTextContent('1'),
    );
    const urgent = (await screen.findByRole('heading', { name: 'Requiere atención' })).closest(
      'section',
    );
    if (!urgent) throw new Error('missing alerts block');
    expect(await within(urgent).findByRole('link', { name: /Naranja/ })).toHaveAttribute(
      'href',
      '/objeto/alertas/AL-1',
    );
    const shortcuts = screen.getByRole('navigation', { name: 'Accesos rápidos' });
    expect(within(shortcuts).getAllByRole('link')).toHaveLength(4);
    expect(await screen.findByText('Conflicto por agua')).toBeVisible();
  });

  it('keeps the project selector, inbox and sign-out one tap away', async () => {
    signIn();
    at('/');
    render(<App />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Cambiar de proyecto/ }));
    const project = screen.getByRole('dialog', { name: 'Cambiar de proyecto' });
    expect(within(project).getByLabelText('Proyecto activo')).toBeVisible();
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: /^Cuenta de Persona Sintética/ }));
    const account = screen.getByRole('dialog', { name: 'Cuenta' });
    expect(within(account).getByText('Notificaciones')).toBeVisible();
    expect(within(account).getByRole('button', { name: 'Cerrar sesión' })).toBeVisible();
  });
});
