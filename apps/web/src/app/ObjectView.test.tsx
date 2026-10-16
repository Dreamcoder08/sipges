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

it('corrects a pending classification from its 360° file and preserves imported fields', async () => {
  const { payloads } = installRecordsApi({
    'DEMO/PRJ-DEMO/actores': [
      {
        _id: 'A-2',
        'Nombre_Actor/Organizacion': 'Actor de prueba',
        Influencia: 'Alta',
        Posicion_Proyecto: 'Favorable',
        Territorio: '',
        Dato_Original: 'Conservar íntegro',
      },
    ],
  });
  window.history.replaceState(null, '', '/objeto/actores/A-2');
  render(<App />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Editar datos del registro' }));
  await user.type(screen.getByLabelText('Territorio'), 'Territorio documentado');
  await user.click(screen.getByRole('button', { name: 'Guardar registro' }));
  expect(await screen.findByText('Registro guardado.')).toBeVisible();
  expect(screen.getByText('Territorio documentado')).toBeVisible();
  expect(payloads.at(-1)).toMatchObject({
    Territorio: 'Territorio documentado',
    Dato_Original: 'Conservar íntegro',
  });
});

it('keeps the 360° correction controls hidden for consultation users', async () => {
  resetApi({ me: { username: 'reader', full_name: 'Consulta de prueba', role: 'consulta' } });
  installRecordsApi({
    'DEMO/PRJ-DEMO/actores': [{ _id: 'A-3', 'Nombre_Actor/Organizacion': 'Consulta' }],
  });
  window.history.replaceState(null, '', '/objeto/actores/A-3');
  render(<App />);
  expect(await screen.findByText('Consulta')).toBeVisible();
  expect(
    screen.queryByRole('button', { name: 'Editar datos del registro' }),
  ).not.toBeInTheDocument();
});
