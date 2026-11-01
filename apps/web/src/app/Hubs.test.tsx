import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { installRecordsApi } from '../test/records-api.ts';
import { resetApi } from '../test/server.ts';
import { App } from './App.tsx';
import { DESTINATIONS } from './navigation.ts';

beforeEach(() =>
  resetApi({ me: { username: 'demo', full_name: 'Persona de prueba', role: 'admin' } }),
);
const at = (path: string) => window.history.replaceState(null, '', path);
const pressed = (group: HTMLElement) =>
  within(group)
    .getAllByRole('button')
    .filter((button) => button.getAttribute('aria-pressed') === 'true')
    .map((button) => button.textContent);

describe('destination hubs', () => {
  it.each(DESTINATIONS)('$label lists its tabs and shows the first one by default', async (hub) => {
    installRecordsApi();
    at(hub.path);
    render(<App />);
    expect(await screen.findByRole('heading', { level: 1, name: hub.label })).toBeVisible();
    const tabs = await screen.findByRole('group', { name: hub.label });
    expect(within(tabs).getAllByRole('button')).toHaveLength(hub.tabs.length);
    expect(pressed(tabs)).toEqual([hub.tabs[0]?.label]);
  });

  it('renders the record type named in the URL and keeps the project scope', async () => {
    installRecordsApi({
      'DEMO/PRJ-DEMO/actores': [{ _id: 'A-1', 'Nombre_Actor/Organizacion': 'Actor sintético' }],
    });
    at('/registros?tipo=actores');
    render(<App />);
    expect(within(await screen.findByRole('table')).getByText('Actor sintético')).toBeVisible();
    expect(pressed(screen.getByRole('group', { name: 'Registros' }))).toEqual(['Actores']);
  });

  it('falls back to the first tab when the URL names an unknown one', async () => {
    installRecordsApi();
    at('/registros?tipo=inexistente');
    render(<App />);
    const tabs = await screen.findByRole('group', { name: 'Registros' });
    expect(pressed(tabs)).toEqual(['Eventos']);
  });

  it('puts the chosen tab in the URL, and back/forward restore it', async () => {
    installRecordsApi({
      'DEMO/PRJ-DEMO/eventos': [{ _id: 'E-1', Descripcion_Hecho: 'Hecho sintético' }],
      'DEMO/PRJ-DEMO/demandas': [{ _id: 'D-1', Descripcion: 'Demanda sintética' }],
    });
    at('/registros');
    render(<App />);
    const user = userEvent.setup();
    const tabs = await screen.findByRole('group', { name: 'Registros' });
    await waitFor(() => expect(screen.getByText('Hecho sintético')).toBeVisible());

    await user.click(within(tabs).getByRole('button', { name: 'Demandas' }));
    await waitFor(() => expect(screen.getByText('Demanda sintética')).toBeVisible());
    expect(window.location.pathname + window.location.search).toBe('/registros?tipo=demandas');
    expect(pressed(tabs)).toEqual(['Demandas']);

    window.history.back();
    await waitFor(() => expect(pressed(tabs)).toEqual(['Eventos']));
    await waitFor(() => expect(screen.getByText('Hecho sintético')).toBeVisible());
    window.history.forward();
    await waitFor(() => expect(pressed(tabs)).toEqual(['Demandas']));
  });

  it('keeps the old routes working as deep links', async () => {
    installRecordsApi({
      'DEMO/PRJ-DEMO/eventos': [{ _id: 'E-1', Descripcion_Hecho: 'Hecho sintético' }],
    });
    at('/eventos');
    render(<App />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Eventos' })).toBeVisible();
    await waitFor(() => expect(screen.getByText('Hecho sintético')).toBeVisible());
  });
});
