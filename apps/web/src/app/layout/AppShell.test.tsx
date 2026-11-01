import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installRecordsApi } from '../../test/records-api.ts';
import { api, resetApi, server } from '../../test/server.ts';
import { App } from '../App.tsx';
import { DESTINATIONS, SCREENS } from '../navigation.ts';

const at = (path: string) => window.history.replaceState(null, '', path);
const names = (items: HTMLElement[]) => items.map((item) => item.textContent);

const renderAt = async (path: string) => {
  api.me = { username: 'persona', full_name: 'Persona Sintética', role: 'admin' };
  at(path);
  render(<App />);
  const nav = await screen.findByRole('navigation', { name: 'Secciones' });
  return { nav, user: userEvent.setup() };
};

/** Every item of a menu in reading order. */
const menuItems = (menu: HTMLElement) => within(menu).queryAllByRole('menuitem');

const accountButton = () => screen.getByRole('button', { name: /^Cuenta de / });

beforeEach(() => resetApi());
afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

describe('desktop sidebar', () => {
  it('lists the five destinations, then Integraciones, with no collapsible groups', async () => {
    const { nav } = await renderAt('/inicio');
    const links = within(nav).getAllByRole('link');
    expect(names(links.slice(0, 6))).toEqual([
      'Inicio',
      'Registros',
      'Territorio',
      'Bandeja',
      'Análisis',
      'Integraciones',
    ]);
    expect(links.slice(0, 6).map((link) => link.getAttribute('href'))).toEqual([
      '/inicio',
      '/registros',
      '/territorio',
      '/bandeja',
      '/analisis',
      '/automatizaciones',
    ]);
    expect(within(nav).queryByRole('button')).toBeNull();
    expect(within(nav).queryByText('Fijados')).toBeNull();
  });

  it('marks a hub as current, and also the old screens it absorbs', async () => {
    const hub = await renderAt('/registros?tipo=actores');
    expect(within(hub.nav).getByRole('link', { name: 'Registros' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(hub.nav).getByRole('link', { name: 'Inicio' })).not.toHaveAttribute(
      'aria-current',
    );
    cleanup();
    const old = await renderAt('/alertas');
    expect(within(old.nav).getByRole('link', { name: 'Bandeja' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(old.nav).getByRole('link', { name: 'Registros' })).not.toHaveAttribute(
      'aria-current',
    );
    cleanup();
    const home = await renderAt('/');
    expect(within(home.nav).getByRole('link', { name: 'Inicio' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('marks Integraciones, not a destination, on the automations screen', async () => {
    const { nav } = await renderAt('/automatizaciones');
    expect(within(nav).getByRole('link', { name: 'Integraciones' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getAllByRole('link', { current: 'page' })).toHaveLength(1);
  });

  it('lists the last four visited screens and tabs under «Recientes», newest first', async () => {
    const { nav } = await renderAt('/registros?tipo=actores');
    const recents = () => within(within(nav).getByRole('region', { name: 'Recientes' }));
    for (const href of ['/irsa', '/registros?tipo=demandas', '/alertas', '/mapa']) {
      window.history.pushState(null, '', href);
      window.dispatchEvent(new PopStateEvent('popstate'));
      await screen.findByRole('heading', { level: 1 });
    }
    await waitFor(() =>
      expect(names(recents().getAllByRole('link'))).toEqual([
        'Mapa territorial',
        'Alertas',
        'Registros · Demandas',
        'IRSA-SIPGES',
      ]),
    );
    // Recents last for the tab only: nothing persists on the device (03-tenancy checks localStorage).
    expect(JSON.parse(window.sessionStorage.getItem('sipges.recents') ?? '[]')).toHaveLength(4);
    expect(window.localStorage.getItem('sipges.recents')).toBeNull();
    expect(recents().getByRole('link', { name: 'Registros · Demandas' })).toHaveAttribute(
      'href',
      '/registros?tipo=demandas',
    );
  });

  it('reaches all 26 screens: hub tabs, the Integraciones link or the account menu', async () => {
    installRecordsApi();
    const { nav, user } = await renderAt('/');
    const reached = new Set<string>();
    for (const hub of DESTINATIONS) {
      await user.click(within(nav).getByRole('link', { name: hub.label }));
      // Registros shows its types as chips with a count (and Todos first), not as plain tabs.
      const records = hub.path === '/registros';
      const tabs = await screen.findByRole('group', {
        name: records ? 'Tipo de registro' : hub.label,
      });
      for (const tab of hub.tabs) {
        expect(
          within(tabs).getByRole('button', {
            name: records ? new RegExp(`^${tab.label}\\b`) : tab.label,
          }),
        ).toBeVisible();
        reached.add(tab.screen);
      }
    }
    await user.click(accountButton());
    const menu = screen.getByRole('menu', { name: 'Cuenta' });
    // Automatizaciones is reached from the Integraciones link, checked below.
    for (const [label, path] of [
      ['Configuración', '/version-4'],
      ['Administración', '/administracion'],
      ['Auditoría', '/auditoria'],
      ['Ayuda y metodología', '/metodologia'],
    ] as const) {
      expect(within(menu).getByRole('menuitem', { name: label })).toHaveAttribute('href', path);
      reached.add(path);
    }
    reached.add('/automatizaciones');
    expect(reached).toEqual(new Set(SCREENS.map((item) => item.path)));
    expect(within(nav).getByRole('link', { name: 'Integraciones' })).toHaveAttribute(
      'href',
      '/automatizaciones',
    );
  });

  it('opens the existing search palette from the composer', async () => {
    const { nav, user } = await renderAt('/');
    const sidebar = nav.closest('aside');
    if (!sidebar) throw new Error('Missing sidebar');
    const composer = within(sidebar).getByRole('button', { name: /^Buscar/ });
    expect(composer).toHaveTextContent('Ctrl K');
    expect(composer).toHaveAttribute('aria-haspopup', 'dialog');
    await user.click(composer);
    expect(await screen.findByRole('dialog', { name: 'Búsqueda global' })).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Buscar en todo el proyecto' })).toHaveFocus();
  });
});

describe('wide layout: tools live in the sidebar, not in the top bar', () => {
  const topBar = async () => {
    const heading = await screen.findByRole('heading', { level: 1, name: 'Dashboard ejecutivo' });
    const bar = heading.closest('header');
    if (!bar) throw new Error('Missing top bar');
    return bar;
  };

  it('keeps only the project eyebrow and the title in the top bar', async () => {
    await renderAt('/');
    const bar = await topBar();
    expect(await within(bar).findByText('Proyecto Demo')).toBeVisible();
    expect(within(bar).queryByRole('button', { name: /^Buscar/ })).toBeNull();
    expect(within(bar).queryByRole('button', { name: /^Notificaciones/ })).toBeNull();
    expect(within(bar).queryByLabelText('Proyecto activo')).toBeNull();
    expect(within(bar).queryByRole('button', { name: /Cuenta/ })).toBeNull();
    expect(within(bar).queryByRole('button')).toBeNull();
  });

  it('holds the project select, search, bell and account in the sidebar', async () => {
    const { nav } = await renderAt('/');
    const sidebar = nav.closest('aside');
    if (!sidebar) throw new Error('Missing sidebar');
    expect(within(sidebar).getByLabelText('Proyecto activo')).toHaveValue('DEMO/PRJ-DEMO');
    expect(within(sidebar).getByRole('button', { name: /^Buscar/ })).toBeVisible();
    expect(within(sidebar).getByRole('button', { name: /^Notificaciones/ })).toBeVisible();
    expect(within(sidebar).getByRole('button', { name: /^Cuenta de / })).toBeVisible();
  });

  it('switches project from the sidebar through the same request as before', async () => {
    api.scopes.push({ company_id: 'DEMO', project_id: 'PRJ-NORTE', label: 'Proyecto Norte' });
    const { nav, user } = await renderAt('/');
    const select = within(nav.closest('aside') as HTMLElement).getByLabelText('Proyecto activo');
    await waitFor(() => expect(select).toBeEnabled());
    await user.selectOptions(select, 'DEMO/PRJ-NORTE');
    await waitFor(() => expect(api.scope).toBe('DEMO/PRJ-NORTE'));
    expect(api.requests).toContain('POST /select-project');
    await waitFor(() => expect(select).toHaveValue('DEMO/PRJ-NORTE'));
  });

  it('opens the notification inbox from the sidebar bell', async () => {
    const { nav, user } = await renderAt('/');
    const sidebar = nav.closest('aside') as HTMLElement;
    const bell = within(sidebar).getByRole('button', { name: /^Notificaciones/ });
    await user.click(bell);
    expect(bell).toHaveAttribute('aria-expanded', 'true');
    expect(within(sidebar).getByRole('region', { name: 'Notificaciones' })).toBeVisible();
    await user.keyboard('{Escape}');
    expect(bell).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('compact layout keeps its top bar', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(max-width: 60rem)',
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('has no sidebar and still offers search, project and account in the bar', async () => {
    api.me = { username: 'persona', full_name: 'Persona Sintética', role: 'admin' };
    at('/');
    render(<App />);
    const heading = await screen.findByRole('heading', { level: 1, name: 'Dashboard ejecutivo' });
    expect(document.querySelector('aside')).toBeNull();
    const bar = document.querySelector('header');
    if (!bar) throw new Error('Missing top bar');
    expect(within(bar).getByRole('button', { name: /^Buscar/ })).toBeVisible();
    expect(within(bar).getByRole('button', { name: /^Cuenta de Persona Sintética/ })).toBeVisible();
    expect(within(bar).getByRole('button', { name: /Cambiar de proyecto/ })).toBeVisible();
    expect(heading).toBeVisible();
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('account menu in the sidebar', () => {
  it('names the row with the person and what the menu holds', async () => {
    await renderAt('/');
    const trigger = accountButton();
    expect(trigger).toHaveAccessibleName(/Persona Sintética\s*Configuración y sesión/);
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens with Enter, moves with the arrows, Home and End, and closes with Escape', async () => {
    const { user } = await renderAt('/');
    const trigger = accountButton();
    trigger.focus();
    await user.keyboard('{Enter}');
    const menu = screen.getByRole('menu', { name: 'Cuenta' });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const items = menuItems(menu);
    expect(names(items)).toEqual([
      'ConfiguraciónCtrl+,',
      'Administración',
      'Auditoría',
      'Ayuda y metodología',
      'Cerrar sesión',
    ]);
    expect(within(menu).queryByRole('menuitem', { name: 'Automatizaciones' })).toBeNull();
    expect(within(menu).queryByText('Tema')).toBeNull();
    expect(within(menu).queryByRole('menuitemradio')).toBeNull();
    expect(items[0]).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(items[1]).toHaveFocus();
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(items.at(-1)).toHaveFocus();
    await user.keyboard('{Home}');
    expect(items[0]).toHaveFocus();
    await user.keyboard('{End}');
    expect(items.at(-1)).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens with Space and with ArrowUp on the last item', async () => {
    const { user } = await renderAt('/');
    const trigger = accountButton();
    trigger.focus();
    await user.keyboard(' ');
    expect(menuItems(screen.getByRole('menu'))[0]).toHaveFocus();
    await user.keyboard('{Escape}');
    await user.keyboard('{ArrowUp}');
    expect(
      within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Cerrar sesión' }),
    ).toHaveFocus();
  });

  it('closes on an outside click', async () => {
    const { user } = await renderAt('/');
    await user.click(accountButton());
    expect(screen.getByRole('menu')).toBeVisible();
    await user.click(screen.getByRole('main'));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('links to the screens it keeps and marks the current one', async () => {
    server.use(http.get('/system/audit', () => HttpResponse.json([])));
    const { user } = await renderAt('/auditoria');
    const trigger = accountButton();
    expect(trigger).toHaveAttribute('data-current', 'true');
    await user.click(trigger);
    const menu = screen.getByRole('menu', { name: 'Cuenta' });
    const links = within(menu)
      .getAllByRole('menuitem')
      .filter((item) => item.hasAttribute('href'));
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/version-4',
      '/administracion',
      '/auditoria',
      '/metodologia',
    ]);
    expect(within(menu).getByRole('menuitem', { name: 'Auditoría' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await user.click(within(menu).getByRole('menuitem', { name: 'Ayuda y metodología' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Metodología SIPGES' }),
    ).toBeVisible();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('heads the menu with the full name and the username, and hints the Configuración shortcut', async () => {
    const { user } = await renderAt('/');
    await user.click(accountButton());
    const menu = screen.getByRole('menu', { name: 'Cuenta' });
    expect(within(menu).getByText('Persona Sintética')).toBeVisible();
    expect(within(menu).getByText('persona')).toBeVisible();
    const settings = within(menu).getByRole('menuitem', { name: 'Configuración' });
    expect(within(settings).getByText('Ctrl+,')).toBeVisible();
    expect(settings).toHaveAttribute('aria-keyshortcuts', 'Control+, Meta+,');
  });

  it('opens Configuración with Ctrl+, and Cmd+, from anywhere', async () => {
    const { user } = await renderAt('/');
    await user.keyboard('{Control>},{/Control}');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Configuración del proyecto' }),
    ).toBeVisible();
    at('/');
    cleanup();
    const second = await renderAt('/');
    await second.user.keyboard('{Meta>},{/Meta}');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Configuración del proyecto' }),
    ).toBeVisible();
  });

  it('ignores Ctrl+, while typing in a text field', async () => {
    const { user } = await renderAt('/');
    const field = document.createElement('input');
    document.body.append(field);
    field.focus();
    await user.keyboard('{Control>},{/Control}');
    expect(window.location.pathname).toBe('/');
    field.remove();
  });

  it('reaches Apariencia from the account menu and changes the theme there', async () => {
    const { user } = await renderAt('/');
    await user.click(accountButton());
    await user.click(screen.getByRole('menuitem', { name: 'Configuración' }));
    const group = await screen.findByRole('group', { name: 'Tema' });
    await user.click(within(group).getByRole('radio', { name: 'Oscuro' }));
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(window.localStorage.getItem('sipges.theme')).toBe('dark');
  });

  it('signs out with the existing sign-out request', async () => {
    const { user } = await renderAt('/');
    await user.click(accountButton());
    await user.click(screen.getByRole('menuitem', { name: 'Cerrar sesión' }));
    await waitFor(() => expect(api.requests).toContain('POST /logout'));
    await waitFor(() => expect(window.location.pathname).toBe('/login'));
  });
});
