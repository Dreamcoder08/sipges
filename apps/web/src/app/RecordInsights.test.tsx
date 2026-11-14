import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { limaToday } from '@sipges/kernel';
import { beforeEach, expect, it } from 'vitest';
import { installRecordsApi } from '../test/records-api.ts';
import { resetApi } from '../test/server.ts';
import { App } from './App.tsx';

beforeEach(() =>
  resetApi({ me: { username: 'reader', full_name: 'Persona de prueba', role: 'consulta' } }),
);

it('starts the alert centre on an overview whose heatmap opens the actual alert', async () => {
  installRecordsApi({
    'DEMO/PRJ-DEMO/alertas': [
      {
        _id: 'AL-1',
        Fecha: limaToday(),
        Causa: 'Alerta de prueba',
        Dimension: 'G',
        Nivel_Preliminar: 'Naranja',
        Accion_Sugerida: 'Acción de prueba',
        'Evento/Registro_Origen': 'EV-1',
      },
      {
        _id: 'AL-2',
        Fecha: limaToday(),
        Causa: 'Alerta sin ubicar',
        Dimension: 'E',
        Nivel_Preliminar: 'Rojo',
      },
    ],
    'DEMO/PRJ-DEMO/eventos': [{ _id: 'EV-1', Territorio: 'Territorio de prueba' }],
  });
  window.history.replaceState(null, '', '/alertas');
  render(<App />);
  const user = userEvent.setup();
  expect(await screen.findByRole('button', { name: 'Vista general' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const cell = await screen.findByRole('button', {
    name: 'G · Territorio de prueba: Medio-alto 1 alerta(s) (Naranja)',
  });
  expect(
    screen.getByRole('button', {
      name: 'E · Sin territorio registrado: Crítico 1 alerta(s) (Rojo)',
    }),
  ).toBeVisible();
  const ranking = screen.getByRole('region', { name: 'Comunidades prioritarias' });
  expect(ranking).toHaveTextContent('Territorio de prueba');
  expect(ranking).toHaveTextContent('1 alerta(s) activa(s) sin comunidad registrada');
  expect(screen.getByRole('region', { name: 'Alertas recientes' })).toHaveTextContent(
    'Acción de prueba',
  );
  await user.click(cell);
  await user.click(screen.getByRole('button', { name: 'Ficha de alerta AL-1' }));
  expect(window.location.pathname).toBe('/objeto/alertas/AL-1');
});

it('keeps the alert list one tab away, with its territory column', async () => {
  installRecordsApi({
    'DEMO/PRJ-DEMO/alertas': [
      { _id: 'AL-1', Causa: 'Alerta de prueba', Territorio: 'Comunidad de prueba' },
    ],
  });
  window.history.replaceState(null, '', '/alertas');
  render(<App />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Ver todas las alertas' }));
  expect(await screen.findByRole('columnheader', { name: 'Comunidad / territorio' })).toBeVisible();
  expect(screen.getByRole('cell', { name: 'Comunidad de prueba' })).toBeVisible();
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
  const node = await screen.findByRole('button', {
    name: 'Actor de prueba. Sociedad civil (inferido), anillo Control, posición Favorable. Abrir ficha',
  });
  expect(screen.getByRole('button', { name: 'Ficha de actor A-2' })).toBeVisible();
  await user.click(node);
  expect(await screen.findByRole('heading', { name: 'Ficha A-1' })).toHaveFocus();
  await user.click(screen.getByRole('button', { name: 'Volver a la lista' }));
  await user.click(screen.getByRole('button', { name: 'Ficha de actor A-1' }));
  expect(await screen.findByRole('heading', { name: 'Ficha A-1' })).toHaveFocus();
  await user.click(screen.getByRole('button', { name: 'Volver a la lista' }));
  expect(await screen.findByRole('button', { name: 'Ficha de actor A-1' })).toHaveFocus();
});
