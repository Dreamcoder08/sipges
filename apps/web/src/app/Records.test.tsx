import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { installRecordsApi } from '../test/records-api.ts';
import { api, resetApi, server } from '../test/server.ts';
import { App } from './App.tsx';

beforeEach(() =>
  resetApi({ me: { username: 'demo', full_name: 'Persona de prueba', role: 'admin' } }),
);
const at = (path: string) => window.history.replaceState(null, '', path);
const open = (module: string) => {
  at(`/${module}`);
  render(<App />);
};

const modules = [
  ['eventos', 'Descripcion_Hecho', 'Hecho sintético'],
  ['actores', 'Nombre_Actor/Organizacion', 'Actor sintético'],
  ['directorio', 'Nombre', 'Contacto sintético'],
  ['demandas', 'Descripcion', 'Demanda sintética'],
  ['narrativas', 'Descripcion', 'Narrativa sintética'],
  ['fuentes', 'Archivo_Fuente', 'Fuente sintética'],
] as const;

describe('territorial records', () => {
  it.each(modules)(
    'lists %s and offers its specific creation form',
    async (module, field, value) => {
      installRecordsApi({ [`DEMO/PRJ-DEMO/${module}`]: [{ _id: 'R-1', [field]: value }] });
      open(module);
      expect(await screen.findByText(value)).toBeVisible();
      await userEvent.setup().click(screen.getByRole('button', { name: 'Nuevo registro' }));
      expect(screen.getByRole('button', { name: 'Guardar registro' })).toBeVisible();
      expect(screen.queryByText('En migración')).toBeNull();
    },
  );

  it('creates an event in the active project and searches the refreshed list', async () => {
    const state = installRecordsApi();
    open('eventos');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Nuevo registro' }));
    await user.type(
      screen.getByLabelText('Descripción del hecho'),
      'Reunión territorial sintética',
    );
    await user.click(screen.getByRole('button', { name: 'Guardar registro' }));
    expect(await screen.findByText('Reunión territorial sintética')).toBeVisible();
    expect(state.payloads[0]).toMatchObject({
      Proyecto_ID: 'PRJ-DEMO',
      Descripcion_Hecho: 'Reunión territorial sintética',
    });
    await user.type(screen.getByLabelText('Buscar registros'), 'sin coincidencias');
    await user.click(screen.getByRole('button', { name: 'Buscar' }));
    expect(await screen.findByText('Sin registros para esta búsqueda.')).toBeVisible();
  });

  it('preserves unknown fields, IDs and attachment metadata when editing', async () => {
    const state = installRecordsApi({
      'DEMO/PRJ-DEMO/actores': [
        {
          _id: 'A-1',
          ID_Actor: 'A-1',
          _updated_at: '2026-10-13',
          'Nombre_Actor/Organizacion': 'Actor original',
          Tipo_Actor: 'Categoría importada',
          Extra: { tags: [1, 2] },
          Adjuntos: [{ id: 'ADJ-1', archivo: 'acta.txt' }],
        },
      ],
    });
    open('actores');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Editar A-1' }));
    expect(screen.getByLabelText('Tipo de actor')).toHaveValue('Categoría importada');
    await user.clear(screen.getByLabelText('Nombre del actor u organización'));
    await user.type(screen.getByLabelText('Nombre del actor u organización'), 'Actor actualizado');
    await user.click(screen.getByRole('button', { name: 'Guardar registro' }));
    expect(await screen.findByText('Actor actualizado')).toBeVisible();
    expect(state.payloads[0]).toMatchObject({
      ID_Actor: 'A-1',
      Extra: { tags: [1, 2] },
      Adjuntos: [{ id: 'ADJ-1', archivo: 'acta.txt' }],
    });
    expect(state.payloads[0]).not.toHaveProperty('_id');
    expect(state.payloads[0]).not.toHaveProperty('_updated_at');
  });

  it('reads imported directory aliases without losing the original fields', async () => {
    installRecordsApi({
      'DEMO/PRJ-DEMO/directorio': [
        {
          _id: 'DIR-1',
          'Nombre actualizado 2026': 'Contacto importado',
          'Institución / Organización': 'Entidad importada',
        },
      ],
    });
    open('directorio');
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Editar DIR-1' }));
    expect(screen.getByLabelText('Nombre')).toHaveValue('Contacto importado');
    expect(screen.getByLabelText('Institución')).toHaveValue('Entidad importada');
  });

  it('requires confirmation before deleting and supports cancel', async () => {
    const state = installRecordsApi({
      'DEMO/PRJ-DEMO/demandas': [{ _id: 'D-1', Descripcion: 'Demanda a conservar' }],
    });
    open('demandas');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Eliminar D-1' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Eliminar registro' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    expect(state.rows['DEMO/PRJ-DEMO/demandas']).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Eliminar D-1' }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', {
        name: 'Confirmar eliminación',
      }),
    );
    await waitFor(() => expect(state.rows['DEMO/PRJ-DEMO/demandas']).toHaveLength(0));
    expect(await screen.findByText('Sin registros para esta búsqueda.')).toBeVisible();
  });

  it('offers commitments within the demands screen', async () => {
    installRecordsApi({
      'DEMO/PRJ-DEMO/compromisos': [{ _id: 'C-1', Descripcion: 'Compromiso sintético' }],
    });
    open('demandas');
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Compromisos' }));
    expect(await screen.findByText('Compromiso sintético')).toBeVisible();
  });

  it('shows records as text and hides writes for read-only users', async () => {
    api.me = { username: 'lector', full_name: 'Lector', role: 'consulta' };
    installRecordsApi({
      'DEMO/PRJ-DEMO/narrativas': [{ _id: 'N-1', Descripcion: '<img src=x onerror=alert(1)>' }],
    });
    open('narrativas');
    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Nuevo registro' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Editar N-1' })).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('keeps a failed save editable and shows the server error', async () => {
    installRecordsApi();
    server.use(
      http.post('/api/eventos', () =>
        HttpResponse.json({ detail: 'Operación restringida' }, { status: 403 }),
      ),
    );
    open('eventos');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Nuevo registro' }));
    await user.type(screen.getByLabelText('Descripción del hecho'), 'Evento en borrador');
    await user.click(screen.getByRole('button', { name: 'Guardar registro' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Operación restringida');
    expect(screen.getByLabelText('Descripción del hecho')).toHaveValue('Evento en borrador');
  });

  it('closes the old draft and loads separate records after a project switch', async () => {
    api.scopes.push({ company_id: 'DEMO', project_id: 'PRJ-NORTE', label: 'Proyecto Norte' });
    installRecordsApi({
      'DEMO/PRJ-DEMO/eventos': [{ _id: 'EV-1', Descripcion_Hecho: 'Evento Demo' }],
      'DEMO/PRJ-NORTE/eventos': [{ _id: 'EV-1', Descripcion_Hecho: 'Evento Norte' }],
    });
    open('eventos');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Nuevo registro' }));
    await user.type(screen.getByLabelText('Descripción del hecho'), 'Borrador Demo');
    await user.selectOptions(screen.getByLabelText('Proyecto activo'), 'DEMO/PRJ-NORTE');
    expect(await screen.findByText('Evento Norte')).toBeVisible();
    expect(screen.queryByDisplayValue('Borrador Demo')).toBeNull();
    expect(screen.queryByText('Evento Demo')).toBeNull();
  });
});

it('retains evidence added after the editor was opened', async () => {
  const state = installRecordsApi({
    'DEMO/PRJ-DEMO/actores': [
      { _id: 'A-1', 'Nombre_Actor/Organizacion': 'Actor original', Adjuntos: [] },
    ],
  });
  open('actores');
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Editar A-1' }));
  await screen.findByLabelText('Nombre del actor u organización');
  const stored = state.rows['DEMO/PRJ-DEMO/actores']?.[0];
  if (!stored) throw new Error('Missing synthetic row');
  stored.Adjuntos = [{ id: 'NEW', archivo: 'nueva.txt' }];
  await user.click(screen.getByRole('button', { name: 'Guardar registro' }));
  await waitFor(() => expect(state.payloads).toHaveLength(1));
  expect(state.payloads[0]?.Adjuntos).toEqual([{ id: 'NEW', archivo: 'nueva.txt' }]);
});

it('pins a pending write to its original project while the selection changes', async () => {
  api.scopes.push({ company_id: 'DEMO', project_id: 'PRJ-NORTE', label: 'Proyecto Norte' });
  const state = installRecordsApi();
  let finish: () => void = () => undefined;
  let started = false;
  let writeScope: string | null = null;
  server.use(
    http.post('/api/eventos', async ({ request }) => {
      writeScope = request.headers.get('X-MASCLI-Scope');
      const body = (await request.json()) as { payload: Record<string, unknown> };
      started = true;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      state.rows[`${writeScope}/eventos`] = [{ _id: 'EV-SLOW', ...body.payload }];
      return HttpResponse.json({ ok: true, id: 'EV-SLOW' });
    }),
  );
  open('eventos');
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Nuevo registro' }));
  await user.type(screen.getByLabelText('Descripción del hecho'), 'Evento lento Demo');
  await user.click(screen.getByRole('button', { name: 'Guardar registro' }));
  await waitFor(() => expect(started).toBe(true));
  await user.selectOptions(screen.getByLabelText('Proyecto activo'), 'DEMO/PRJ-NORTE');
  await waitFor(() => expect(screen.queryByDisplayValue('Evento lento Demo')).toBeNull());
  finish();
  await waitFor(() => expect(state.rows['DEMO/PRJ-DEMO/eventos']).toHaveLength(1));
  expect(writeScope).toBe('DEMO/PRJ-DEMO');
  expect(state.rows['DEMO/PRJ-NORTE/eventos']).toBeUndefined();
  expect(screen.queryByText('Evento lento Demo')).toBeNull();
});

it('rejects executable publication links and does not render them as anchors', async () => {
  installRecordsApi({
    'DEMO/PRJ-DEMO/narrativas': [
      { _id: 'N-1', Descripcion: 'Señal importada', URL_Publicacion: 'javascript:alert(1)' },
    ],
  });
  open('narrativas');
  await userEvent.setup().click(await screen.findByRole('button', { name: 'Ver N-1' }));
  expect(await screen.findByText('javascript:alert(1)')).toBeVisible();
  expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
});

it('does not offer record mutation controls to coordinators', async () => {
  api.me = { username: 'coord', full_name: 'Coordinador', role: 'coordinador' };
  installRecordsApi({
    'DEMO/PRJ-DEMO/eventos': [{ _id: 'EV-1', Descripcion_Hecho: 'Evento consultable' }],
  });
  open('eventos');
  expect(await screen.findByText('Evento consultable')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Nuevo registro' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Eliminar EV-1' })).toBeNull();
});

it('blocks conflicting editors while a save is still running', async () => {
  installRecordsApi({
    'DEMO/PRJ-DEMO/actores': [
      { _id: 'A-1', 'Nombre_Actor/Organizacion': 'Actor uno' },
      { _id: 'A-2', 'Nombre_Actor/Organizacion': 'Actor dos' },
    ],
  });
  let release: () => void = () => undefined;
  let started = false;
  server.use(
    http.put('/api/actores/A-1', async () => {
      started = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return HttpResponse.json({ ok: true });
    }),
  );
  open('actores');
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Editar A-1' }));
  await screen.findByLabelText('Nombre del actor u organización');
  await user.click(screen.getByRole('button', { name: 'Guardar registro' }));
  await waitFor(() => expect(started).toBe(true));
  try {
    expect(screen.getByRole('button', { name: 'Editar A-2' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Eliminar A-2' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cerrar ficha' })).toBeDisabled();
  } finally {
    release();
  }
});

it('uses the granted project name on creation and preserves existing names on edit', async () => {
  const state = installRecordsApi({
    'DEMO/PRJ-DEMO/actores': [
      {
        _id: 'A-1',
        'Nombre_Actor/Organizacion': 'Actor existente',
        Proyecto: 'Nombre territorial conservado',
        Proyecto_ID: 'PRJ-DEMO',
      },
    ],
  });
  open('actores');
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Editar A-1' }));
  await screen.findByLabelText('Nombre del actor u organización');
  await user.click(screen.getByRole('button', { name: 'Guardar registro' }));
  await waitFor(() => expect(state.payloads).toHaveLength(1));
  expect(state.payloads[0]?.Proyecto).toBe('Nombre territorial conservado');
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Guardar registro' })).toBeNull(),
  );
  await user.click(screen.getByRole('button', { name: 'Nuevo registro' }));
  await user.type(screen.getByLabelText('Nombre del actor u organización'), 'Actor nuevo');
  await user.click(screen.getByRole('button', { name: 'Guardar registro' }));
  await waitFor(() => expect(state.payloads).toHaveLength(2));
  expect(state.payloads[1]?.Proyecto).toBe('Proyecto Demo');
});

it('keeps an imported telephone cleared after saving and reopening', async () => {
  installRecordsApi({
    'DEMO/PRJ-DEMO/directorio': [{ _id: 'DIR-1', Nombre: 'Contacto', Celular: '555123' }],
  });
  open('directorio');
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Editar DIR-1' }));
  await user.clear(await screen.findByLabelText('Teléfono'));
  await user.click(screen.getByRole('button', { name: 'Guardar registro' }));
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Guardar registro' })).toBeNull(),
  );
  await user.click(screen.getByRole('button', { name: 'Editar DIR-1' }));
  expect(await screen.findByLabelText('Teléfono')).toHaveValue('');
});
