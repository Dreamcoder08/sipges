import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, resetApi } from '../../test/server.ts';
import { App } from '../App.tsx';

/** chat-first-ui T12 (S2, S3): the wide sidebar hides with a button or Ctrl+B and stays hidden. */
const KEY = 'sipges.sidebar';

const renderAt = async (path = '/') => {
  api.me = { username: 'persona', full_name: 'Persona Sintética', role: 'admin' };
  window.history.replaceState(null, '', path);
  render(<App />);
  await screen.findByRole('heading', { level: 1 });
  return userEvent.setup();
};

const sidebar = () => document.querySelector('aside');
const hideButton = () => screen.getByRole('button', { name: 'Ocultar barra lateral' });
const showButton = () => screen.getByRole('button', { name: 'Mostrar barra lateral' });

beforeEach(() => resetApi());
afterEach(() => window.localStorage.clear());

describe('wide sidebar can be hidden', () => {
  it('hides and shows with the button, which names what it controls and its state', async () => {
    const user = await renderAt();
    const aside = sidebar();
    expect(aside).toBeVisible();
    const hide = hideButton();
    expect(
      within(aside as HTMLElement).getByRole('button', { name: 'Ocultar barra lateral' }),
    ).toBe(hide);
    expect(hide).toHaveAttribute('aria-expanded', 'true');
    expect(hide).toHaveAttribute('aria-controls', aside?.id);
    expect(hide).toHaveAttribute('aria-keyshortcuts', 'Control+B Meta+B');
    expect(hide).toHaveAttribute('title', 'Ocultar barra lateral · Ctrl+B');
    expect(screen.queryByRole('button', { name: 'Mostrar barra lateral' })).toBeNull();

    await user.click(hide);
    // Gone entirely: no rail, no navigation left on screen.
    expect(screen.queryByRole('navigation', { name: 'Secciones' })).toBeNull();
    expect(sidebar()).not.toBeVisible();
    const show = showButton();
    expect(show).toHaveAttribute('aria-expanded', 'false');
    expect(show).toHaveAttribute('aria-controls', aside?.id);
    expect(show).toHaveAttribute('title', 'Mostrar barra lateral · Ctrl+B');
    expect(document.querySelector('[data-sidebar="hidden"]')).not.toBeNull();

    await user.click(show);
    expect(screen.getByRole('navigation', { name: 'Secciones' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Mostrar barra lateral' })).toBeNull();
  });

  it('moves focus to the show button after hiding and to the hide button after showing', async () => {
    const user = await renderAt();
    await user.click(hideButton());
    expect(showButton()).toHaveFocus();
    await user.click(showButton());
    expect(hideButton()).toHaveFocus();
  });

  it('toggles with Ctrl+B and Cmd+B, also from a plain text field, but not from rich text', async () => {
    const user = await renderAt();
    await user.keyboard('{Control>}b{/Control}');
    expect(screen.queryByRole('navigation', { name: 'Secciones' })).toBeNull();
    expect(showButton()).toHaveFocus();
    await user.keyboard('{Meta>}b{/Meta}');
    expect(screen.getByRole('navigation', { name: 'Secciones' })).toBeVisible();
    expect(hideButton()).toHaveFocus();

    // A plain field has no use for Ctrl+B, so the shortcut works and the typing keeps focus.
    const field = document.createElement('textarea');
    document.body.append(field);
    field.focus();
    await user.keyboard('{Control>}b{/Control}');
    expect(screen.queryByRole('navigation', { name: 'Secciones' })).toBeNull();
    expect(field).toHaveFocus();
    field.remove();

    // Rich text uses Ctrl+B for bold: the sidebar stays as it is.
    const rich = document.createElement('div');
    rich.setAttribute('contenteditable', 'true');
    rich.tabIndex = 0;
    document.body.append(rich);
    rich.focus();
    await user.keyboard('{Control>}b{/Control}');
    expect(screen.queryByRole('navigation', { name: 'Secciones' })).toBeNull();
    rich.remove();
  });

  it('keeps the choice in localStorage across a reload', async () => {
    const user = await renderAt();
    await user.click(hideButton());
    expect(window.localStorage.getItem(KEY)).toBe('hidden');
    cleanup();
    const again = await renderAt('/inicio');
    expect(showButton()).toBeVisible();
    expect(screen.queryByRole('navigation', { name: 'Secciones' })).toBeNull();
    await again.click(showButton());
    expect(window.localStorage.getItem(KEY)).toBe('shown');
    cleanup();
    await renderAt('/inicio');
    expect(hideButton()).toBeVisible();
  });
});

describe('compact layout keeps its drawer', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(max-width: 60rem)',
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('ignores the stored choice and Ctrl+B, and the drawer holds no hide button', async () => {
    window.localStorage.setItem(KEY, 'hidden');
    api.me = { username: 'persona', full_name: 'Persona Sintética', role: 'admin' };
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Panel ejecutivo' });
    const user = userEvent.setup();
    expect(screen.queryByRole('button', { name: 'Mostrar barra lateral' })).toBeNull();
    await user.keyboard('{Control>}b{/Control}');
    expect(window.localStorage.getItem(KEY)).toBe('hidden');
    expect(document.querySelector('aside')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Abrir menú' }));
    const drawer = screen.getByRole('dialog', { name: 'Menú' });
    expect(within(drawer).getByRole('navigation', { name: 'Secciones' })).toBeVisible();
    expect(within(drawer).queryByRole('button', { name: /barra lateral/ })).toBeNull();
  });
});
