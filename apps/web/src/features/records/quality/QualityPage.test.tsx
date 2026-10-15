import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, expect, it } from 'vitest';
import { App } from '../../../app/App.tsx';
import { installRecordsApi } from '../../../test/records-api.ts';
import { resetApi, server } from '../../../test/server.ts';

beforeEach(() =>
  resetApi({ me: { username: 'demo', full_name: 'Persona de prueba', role: 'admin' } }),
);
it('opens a review record and refreshes the queue after a persisted correction', async () => {
  installRecordsApi({
    'DEMO/PRJ-DEMO/actores': [
      {
        _id: 'A-Q',
        'Nombre_Actor/Organizacion': 'Actor de prueba',
        Tipo_Actor: 'Comunal',
        Influencia: 'Alta',
        Posicion_Proyecto: 'Favorable',
        Fuente_ID: 'F-Q',
      },
    ],
    'DEMO/PRJ-DEMO/fuentes': [{ _id: 'F-Q', Archivo_Fuente: 'Acta de prueba' }],
  });
  window.history.replaceState(null, '', '/calidad');
  render(<App />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('link', { name: 'Revisar A-Q: Territorio' }));
  await user.click(await screen.findByRole('button', { name: 'Editar datos del registro' }));
  await user.type(screen.getByLabelText('Territorio'), 'Zona documentada');
  await user.click(screen.getByRole('button', { name: 'Guardar registro' }));
  await screen.findByText('Registro guardado.');
  await user.click(screen.getByRole('link', { name: 'Volver a calidad de datos' }));
  expect(
    await screen.findByText(/0 observaciones en 0 registros por revisar.*1 registro revisado/),
  ).toBeVisible();
  expect(screen.queryByRole('link', { name: 'Revisar A-Q: Territorio' })).not.toBeInTheDocument();
  expect(screen.getByText('Sin archivo asociado')).toBeVisible();
});

it('reports a failed data source without displaying a false empty queue', async () => {
  installRecordsApi();
  server.use(
    http.get('/api/actores', () =>
      HttpResponse.json({ detail: 'Fallo de consulta' }, { status: 500 }),
    ),
  );
  window.history.replaceState(null, '', '/calidad');
  render(<App />);
  expect(await screen.findByText(/No se pudo completar la revisión/)).toBeVisible();
  expect(screen.getByRole('button', { name: 'Reintentar revisión' })).toBeVisible();
  expect(screen.queryByText(/0 observaciones/)).not.toBeInTheDocument();
});
