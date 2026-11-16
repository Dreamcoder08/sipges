import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { installRecordsApi } from '../test/records-api.ts';
import { resetApi } from '../test/server.ts';
import { App } from './App.tsx';

beforeEach(() =>
  resetApi({ me: { username: 'demo', full_name: 'Persona de prueba', role: 'admin' } }),
);
const at = (path: string) => window.history.replaceState(null, '', path);

/** functional-10 T6 (F17): real not-found pages with a heading and a way back. */
// Longer than findBy's 5 s wait, so a missing element fails as an assertion, not a timeout.
describe('not-found pages', { timeout: 15_000 }, () => {
  it('a missing page has an h1 and a link back to Inicio', async () => {
    installRecordsApi();
    at('/pagina-que-no-existe');
    render(<App />);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Página no encontrada' }),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Volver al inicio' })).toHaveAttribute(
      'href',
      '/inicio',
    );
    expect(screen.queryByText(/dashboard/i)).toBeNull();
  });

  // functional-10 T13 (F31): signed in, the missing page keeps the app's navigation around it.
  it('a missing page renders inside the app shell when signed in', async () => {
    installRecordsApi();
    at('/pagina-que-no-existe');
    render(<App />);
    // The way back shows with or without the shell; then the shell is asserted at once.
    await screen.findByRole('link', { name: 'Volver al inicio' });
    const notice = screen.getByRole('heading', { name: 'Página no encontrada', level: 2 });
    expect(screen.getByRole('navigation', { name: 'Secciones' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toContainElement(notice);
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual([
      'Página no encontrada',
    ]);
    expect(document.title).toBe('Página no encontrada | SIPGES');
    expect(screen.getByRole('link', { name: 'Volver al inicio' })).toHaveAttribute(
      'href',
      '/inicio',
    );
  });

  it('a missing page asks a signed-out person to sign in first', async () => {
    resetApi();
    at('/pagina-que-no-existe');
    render(<App />);
    // Either screen settles first (the old bare notice or the sign-in form); then the path is read.
    await waitFor(() =>
      expect(
        screen.queryByRole('link', { name: 'Volver al inicio' }) ??
          screen.queryByLabelText('Usuario'),
      ).not.toBeNull(),
    );
    expect(window.location.pathname).toBe('/login');
    expect(screen.getByLabelText('Usuario')).toBeVisible();
  });

  it('a missing record of a valid type says the record was not found, not the type', async () => {
    installRecordsApi({ 'DEMO/PRJ-DEMO/eventos': [{ _id: 'EV-1' }] });
    at('/objeto/eventos/NO-EXISTE');
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Registro no encontrado' })).toBeVisible();
    expect(screen.getByText(/NO-EXISTE/)).toBeVisible();
    expect(screen.queryByText('Tipo de registro no válido')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Ficha del registro' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Volver al inicio' })).toHaveAttribute(
      'href',
      '/inicio',
    );
  });

  it('reads the record type of the address without regard to case', async () => {
    installRecordsApi({ 'DEMO/PRJ-DEMO/eventos': [{ _id: 'EV-1' }] });
    at('/objeto/Eventos/NO-EXISTE');
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Registro no encontrado' })).toBeVisible();
  });

  it('an unknown record type says so, with a heading and a way back', async () => {
    installRecordsApi();
    at('/objeto/planetas/X');
    render(<App />);
    expect(
      await screen.findByRole('heading', { name: 'Tipo de registro no válido' }),
    ).toBeVisible();
    expect(screen.queryByText('Registro no encontrado')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Ficha del registro' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Volver al inicio' })).toHaveAttribute(
      'href',
      '/inicio',
    );
  });
});
