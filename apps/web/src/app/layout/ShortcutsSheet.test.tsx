import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, resetApi } from '../../test/server.ts';
import { App } from '../App.tsx';
import { GLOBAL_SHORTCUTS, SHORTCUT_GROUPS, comboText } from './shortcuts.ts';

/** chat-first-ui T14 (S2): one sheet lists every shortcut, from one list. */
const renderApp = async () => {
  api.me = { username: 'persona', full_name: 'Persona Sintética', role: 'admin' };
  render(<App />);
  await screen.findByRole('heading', { level: 1 });
  return userEvent.setup();
};

const sheet = () => screen.getByRole('dialog', { name: 'Atajos de teclado' });

beforeEach(() => resetApi());
afterEach(() => window.localStorage.clear());

describe('shortcuts sheet', () => {
  it('opens with Ctrl+/ and with Cmd+/', async () => {
    const user = await renderApp();
    expect(screen.queryByRole('dialog', { name: 'Atajos de teclado' })).toBeNull();
    await user.keyboard('{Control>}/{/Control}');
    expect(sheet()).toBeVisible();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Atajos de teclado' })).toBeNull();
    await user.keyboard('{Meta>}/{/Meta}');
    expect(sheet()).toBeVisible();
  });

  it('lists every shortcut of the single source, group by group, with its keys', async () => {
    const user = await renderApp();
    await user.keyboard('{Control>}/{/Control}');
    const dialog = sheet();
    const rows = SHORTCUT_GROUPS.flatMap((group) => {
      const region = within(dialog).getByRole('region', { name: group.title });
      return group.items.map((item) => {
        const label = within(region).getByText(item.label);
        const row = label.closest('div');
        if (!row) throw new Error(`Missing row for ${item.label}`);
        expect([...row.querySelectorAll('kbd')].map((key) => key.textContent)).toEqual(
          item.keys.map(comboText),
        );
        return row;
      });
    });
    expect(dialog.querySelectorAll('dt')).toHaveLength(rows.length);
    // The shortcuts that exist today, so the list cannot silently drop one.
    const all = SHORTCUT_GROUPS.flatMap((group) => group.items).flatMap((item) =>
      item.keys.map(comboText),
    );
    for (const keys of [
      'Ctrl+K',
      'Ctrl+B',
      'Ctrl+,',
      'Ctrl+/',
      'Ctrl+Mayús+O',
      'Esc',
      'Enter',
      'Mayús+Enter',
    ])
      expect(all).toContain(keys);
  });

  it('closes with Esc and gives focus back to what had it', async () => {
    const user = await renderApp();
    const hide = screen.getByRole('button', { name: 'Ocultar barra lateral' });
    hide.focus();
    await user.keyboard('{Control>}/{/Control}');
    expect(sheet()).toContainElement(document.activeElement as HTMLElement);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Atajos de teclado' })).toBeNull();
    expect(hide).toHaveFocus();
  });

  it('opens from the account menu, which shows the shortcut in place', async () => {
    const user = await renderApp();
    const account = screen.getByRole('button', { name: /^Cuenta de / });
    await user.click(account);
    const item = within(screen.getByRole('menu', { name: 'Cuenta' })).getByRole('menuitem', {
      name: 'Atajos de teclado',
    });
    expect(within(item).getByText('Ctrl+/')).toBeVisible();
    expect(item).toHaveAttribute('aria-keyshortcuts', 'Control+/ Meta+/');
    await user.click(item);
    expect(sheet()).toBeVisible();
    expect(screen.queryByRole('menu')).toBeNull();
    await user.keyboard('{Escape}');
    expect(account).toHaveFocus();
  });

  it('shows the sidebar shortcut from the same list next to its button', async () => {
    await renderApp();
    const hide = screen.getByRole('button', { name: 'Ocultar barra lateral' });
    expect(hide).toHaveAttribute(
      'title',
      `Ocultar barra lateral · ${comboText(GLOBAL_SHORTCUTS.sidebar.keys[0])}`,
    );
  });
});

describe('shortcuts sheet on the compact layout', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(max-width: 60rem)',
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('closes the drawer before opening, so one sheet holds focus, and Esc returns to the menu button', async () => {
    const user = await renderApp();
    const menu = screen.getByRole('button', { name: 'Abrir menú' });
    await user.click(menu);
    const drawer = screen.getByRole('dialog', { name: 'Menú' });
    await user.click(within(drawer).getByRole('button', { name: /^Cuenta de / }));
    await user.click(screen.getByRole('menuitem', { name: 'Atajos de teclado' }));
    expect(sheet()).toBeVisible();
    expect(screen.queryByRole('dialog', { name: 'Menú' })).toBeNull();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(menu).toHaveFocus();
  });
});
