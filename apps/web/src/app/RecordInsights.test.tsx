import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it } from 'vitest';
import { installRecordsApi } from '../test/records-api.ts';
import { resetApi } from '../test/server.ts';
import { App } from './App.tsx';

beforeEach(() =>
  resetApi({ me: { username: 'reader', full_name: 'Persona de prueba', role: 'consulta' } }),
);

it('opens an actual alert from the heatmap, resolves its event territory and restores cell focus', async () => {
  installRecordsApi({
    'DEMO/PRJ-DEMO/alertas': [
      {
        _id: 'AL-1',
        Causa: 'Alerta de prueba',
        Dimension: 'G',
        Nivel_Preliminar: 'Naranja',
        'Evento/Registro_Origen': 'EV-1',
      },
    ],
    'DEMO/PRJ-DEMO/eventos': [{ _id: 'EV-1', Territorio: 'Territorio de prueba' }],
  });
  window.history.replaceState(null, '', '/alertas');
  render(<App />);
  const user = userEvent.setup();
  const cell = await screen.findByRole('button', {
    name: 'G · Territorio de prueba: 1 alerta(s), Naranja',
  });
  await user.click(cell);
  await user.click(screen.getByRole('button', { name: 'Ficha de alerta AL-1' }));
  expect(await screen.findByRole('heading', { name: 'Ficha AL-1' })).toHaveFocus();
  await user.click(screen.getByRole('button', { name: 'Volver a la lista' }));
  expect(
    await screen.findByRole('button', { name: 'G · Territorio de prueba: 1 alerta(s), Naranja' }),
  ).toHaveFocus();
  expect(screen.queryByRole('button', { name: 'Nuevo registro' })).toBeNull();
});

it('draws an actor classification, keeps unknown influences accessible and opens the stored file', async () => {
  installRecordsApi({
    'DEMO/PRJ-DEMO/actores': [
      {
        _id: 'A-1',
        'Nombre_Actor/Organizacion': 'Actor de prueba',
        Tipo_Actor: 'Comunal',
        Influencia: 'Alta',
        Posicion_Proyecto: 'Favorable',
      },
      { _id: 'A-2', 'Nombre_Actor/Organizacion': 'Actor pendiente', Influencia: 'Por verificar' },
    ],
  });
  window.history.replaceState(null, '', '/actores');
  render(<App />);
  const user = userEvent.setup();
  const group = await screen.findByRole('button', {
    name: 'Comunal, influencia Alta: 1 actor(es)',
  });
  expect(screen.getByRole('button', { name: 'Ficha de actor A-2' })).toBeVisible();
  await user.click(group);
  await user.click(screen.getByRole('button', { name: 'Ficha de actor A-1' }));
  expect(await screen.findByRole('heading', { name: 'Ficha A-1' })).toHaveFocus();
  await user.click(screen.getByRole('button', { name: 'Volver a la lista' }));
  expect(await screen.findByRole('button', { name: 'Ficha de actor A-1' })).toHaveFocus();
});
