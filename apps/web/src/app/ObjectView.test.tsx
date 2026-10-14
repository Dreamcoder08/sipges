import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it } from 'vitest';
import { installRecordsApi } from '../test/records-api.ts';
import { resetApi } from '../test/server.ts';
import { App } from './App.tsx';

beforeEach(() =>
  resetApi({ me: { username: 'demo', full_name: 'Persona de prueba', role: 'admin' } }),
);

it('opens the 360° view of a record from its file card', async () => {
  installRecordsApi({
    'DEMO/PRJ-DEMO/actores': [{ _id: 'A-1', 'Nombre_Actor/Organizacion': 'Comunidad Norte' }],
  });
  window.history.replaceState(null, '', '/actores');
  render(<App />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Ver A-1' }));
  await user.click(await screen.findByRole('link', { name: 'Vista 360°' }));
  expect(window.location.pathname).toBe('/objeto/actores/A-1');
  expect(await screen.findByRole('heading', { name: 'Vínculos' })).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Historial de cambios' })).toBeVisible();
  expect(screen.getByText('Comunidad Norte')).toBeVisible();
});

it('explains an unknown object type', async () => {
  installRecordsApi();
  window.history.replaceState(null, '', '/objeto/planetas/X');
  render(<App />);
  expect(await screen.findByText('Tipo de registro no válido')).toBeVisible();
});
