import { render, screen } from '@testing-library/react';
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
