import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { installRecordsApi } from '../test/records-api.ts';
import { resetApi } from '../test/server.ts';
import { App } from './App.tsx';

beforeEach(() =>
  resetApi({ me: { username: 'demo', full_name: 'Persona de prueba', role: 'admin' } }),
);
const at = (path: string) => window.history.replaceState(null, '', path);

/** functional-10 T6 (F16): Configuración has its own address and a heading per section. */
// Longer than findBy's 5 s wait, so a missing element fails as an assertion, not a timeout.
describe('Configuración at /configuracion', { timeout: 15_000 }, () => {
  it('opens at /configuracion with a heading that names the section shown', async () => {
    installRecordsApi();
    at('/configuracion');
    render(<App />);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Configuración · Apariencia' }),
    ).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Configuración del proyecto' })).toBeNull();
    expect(document.title).toBe('Configuración · Apariencia | SIPGES');
    const nav = await screen.findByRole('navigation', { name: 'Secciones de Configuración' });
    expect(within(nav).getByRole('link', { name: 'Proyecto' })).toHaveAttribute(
      'href',
      '/configuracion?seccion=proyecto',
    );
    await userEvent.setup().click(within(nav).getByRole('link', { name: 'Proyecto' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Configuración · Proyecto' }),
    ).toBeVisible();
    expect(window.location.pathname).toBe('/configuracion');
    expect(window.location.search).toBe('?seccion=proyecto');
  });

  it('redirects an old /version-4 link, section included, to /configuracion', async () => {
    installRecordsApi();
    at('/version-4?seccion=privacidad');
    render(<App />);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Configuración · Privacidad y datos' }),
    ).toBeVisible();
    await waitFor(() => expect(window.location.pathname).toBe('/configuracion'));
    expect(window.location.search).toBe('?seccion=privacidad');
  });

  it('redirects a bare /version-4 to Apariencia', async () => {
    installRecordsApi();
    at('/version-4');
    render(<App />);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Configuración · Apariencia' }),
    ).toBeVisible();
    await waitFor(() => expect(window.location.pathname).toBe('/configuracion'));
  });
});
