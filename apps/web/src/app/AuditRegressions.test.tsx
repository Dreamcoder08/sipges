import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { installRecordsApi } from '../test/records-api.ts';
import { resetApi, server } from '../test/server.ts';
import { App } from './App.tsx';

/**
 * Regression tests for the functional audit (odd/tasks/functional-audit-correction.md).
 * Every record here is synthetic; demo rows carry the markers of `demo:seed`.
 */
beforeEach(() =>
  resetApi({ me: { username: 'demo', full_name: 'Persona de prueba', role: 'admin' } }),
);
const open = (module: string) => {
  window.history.replaceState(null, '', `/${module}`);
  render(<App />);
};
const DEMO = { Dato_Sintetico: true, Demo_Dataset: 'mascli-academic-v1' };
const demand = {
  _id: 'D-1',
  ID_Demanda: 'D-1',
  Fecha_Registro: '2026-10-01',
  'Actor/Grupo': 'Junta sintética',
  Tema: 'Agua',
  Descripcion: 'Solicitud sintética de información sobre el monitoreo de agua.',
  Estado: 'En diálogo',
  Respuesta_Empresa: 'Respuesta registrada en la matriz',
  Seguimiento: { hitos: 2 },
};

describe('error 02: demo records are separated from real ones', () => {
  it('hides demo rows by default and shows them, badged, on request', async () => {
    installRecordsApi({
      'DEMO/PRJ-DEMO/demandas': [
        demand,
        {
          _id: 'DEMO-D-03',
          ...DEMO,
          Descripcion: 'Solicitud 3: Información sobre tránsito y ruido con criterios.',
        },
      ],
    });
    open('demandas');
    expect(await screen.findByText(demand.Descripcion)).toBeVisible();
    expect(screen.queryByText(/tránsito y ruido/)).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('1 real(es) · 1 de demostración');
    await userEvent.setup().selectOptions(screen.getByLabelText('Origen'), 'demo');
    const row = (await screen.findByText(/tránsito y ruido/)).closest('tr');
    expect(row).not.toBeNull();
    // The stored code is shown verbatim, with an explicit badge.
    expect(within(row as HTMLElement).getByText('Demostración')).toBeVisible();
    expect(within(row as HTMLElement).getByRole('button', { name: 'Ver DEMO-D-03' })).toBeVisible();
  });

  it('explains an empty real list instead of looking empty', async () => {
    installRecordsApi({
      'DEMO/PRJ-DEMO/directorio': [{ _id: 'DEMO-DIR-01', ...DEMO, Nombre: 'Vocería 01' }],
    });
    open('directorio');
    expect(
      await screen.findByText('No hay registros reales de directorio territorial.'),
    ).toBeVisible();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Ver 1 de demostración' }));
    expect(await screen.findByText('Vocería 01')).toBeVisible();
  });
});

describe('error 03: «Ver» opens the record and returns to the list', () => {
  it('shows the full record in place of the list and restores focus on return', async () => {
    installRecordsApi({ 'DEMO/PRJ-DEMO/demandas': [demand] });
    open('demandas');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Ver D-1' }));
    const heading = await screen.findByRole('heading', { name: 'Ficha D-1' });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByText(demand.Descripcion)).toBeVisible();
    expect(screen.getByText('Junta sintética')).toBeVisible();
    expect(screen.queryByRole('table')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Volver a la lista' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Ver D-1' })).toHaveFocus());
  });

  it('reports a record that no longer exists', async () => {
    installRecordsApi({ 'DEMO/PRJ-DEMO/demandas': [demand] });
    server.use(
      http.get('/api/demandas/D-1', () =>
        HttpResponse.json({ detail: 'Registro no encontrado' }, { status: 404 }),
      ),
    );
    open('demandas');
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Ver D-1' }));
    expect(await screen.findByText('Registro no encontrado')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Volver a la lista' })).toBeEnabled();
  });

  it('lists the commitments that follow up the demand', async () => {
    installRecordsApi({
      'DEMO/PRJ-DEMO/demandas': [demand],
      'DEMO/PRJ-DEMO/compromisos': [
        { _id: 'C-1', Demanda_Asociada: 'D-1', Descripcion: 'Mesa técnica', Estado: 'En proceso' },
        { _id: 'C-2', Demanda_Asociada: 'D-9', Descripcion: 'Otro compromiso' },
      ],
    });
    open('demandas');
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Ver D-1' }));
    const section = (
      await screen.findByRole('heading', { name: 'Compromisos de seguimiento' })
    ).closest('section') as HTMLElement;
    expect(await within(section).findByText(/Mesa técnica · En proceso/)).toBeVisible();
    expect(within(section).queryByText(/Otro compromiso/)).toBeNull();
  });
});

describe('error 04: «Editar» shows and saves every stored field', () => {
  it('edits the description and the matrix columns without losing other data', async () => {
    const state = installRecordsApi({ 'DEMO/PRJ-DEMO/demandas': [demand] });
    open('demandas');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Editar D-1' }));
    expect(await screen.findByLabelText('Descripción')).toHaveValue(demand.Descripcion);
    expect(screen.getByLabelText('Estado')).toHaveValue('En diálogo');
    const extra = screen.getByLabelText('Respuesta_Empresa');
    expect(extra).toHaveValue('Respuesta registrada en la matriz');
    expect(screen.getByText('{"hitos":2}')).toBeVisible();
    await user.clear(extra);
    await user.type(extra, 'Respuesta actualizada');
    await user.selectOptions(screen.getByLabelText('Estado'), 'Atendida');
    await user.click(screen.getByRole('button', { name: 'Guardar registro' }));
    expect(await screen.findByText(/Registro D-1 guardado/)).toBeVisible();
    expect(state.payloads[0]).toMatchObject({
      Descripcion: demand.Descripcion,
      Estado: 'Atendida',
      Respuesta_Empresa: 'Respuesta actualizada',
      Seguimiento: { hitos: 2 },
      ID_Demanda: 'D-1',
    });
  });

  it('shows the extra fields when reading the record', async () => {
    installRecordsApi({ 'DEMO/PRJ-DEMO/demandas': [demand] });
    open('demandas');
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Ver D-1' }));
    const extras = (
      await screen.findByRole('heading', { name: 'Otros datos del registro' })
    ).closest('section') as HTMLElement;
    expect(within(extras).getByText('Respuesta registrada en la matriz')).toBeVisible();
  });
});

describe('error 05: stored reports open inside the app', () => {
  const attachment = {
    id: 'ADJ-1',
    original_name: 'informe.pdf',
    content_type: 'application/pdf',
    size_bytes: 2048,
    sha256: 'b'.repeat(64),
    linked_module: 'fuentes',
    linked_record_id: 'F-1',
    document_type: 'Informe',
    author: 'Equipo sintético',
    verification: 'C - Parcial',
    notes: '',
    project_id: 'PRJ-DEMO',
    project_name: 'Demo',
    created_at: '2026-10-13T12:00:00Z',
    download_url: '/system/uploads/ADJ-1/download',
  };
  it('marks sources with files and shows the report text with its pages', async () => {
    installRecordsApi({
      'DEMO/PRJ-DEMO/fuentes': [{ _id: 'F-1', Archivo_Fuente: 'Informe sintético' }],
    });
    server.use(
      http.get('/system/uploads', () => HttpResponse.json([attachment])),
      http.get('/system/uploads/ADJ-1/preview', () =>
        HttpResponse.json({
          kind: 'text',
          format: 'pdf',
          pages: ['Primera página del informe sintético', 'Conclusiones sintéticas'],
          truncated: false,
          attachment,
        }),
      ),
    );
    open('fuentes');
    expect(await screen.findByText('1 archivo(s) · abrir con «Ver»')).toBeVisible();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Ver F-1' }));
    await user.click(await screen.findByRole('button', { name: 'Ver contenido de informe.pdf' }));
    const viewer = await screen.findByRole('region', { name: 'Contenido de informe.pdf' });
    expect(await within(viewer).findByText('Primera página del informe sintético')).toBeVisible();
    expect(within(viewer).getByRole('heading', { name: 'Página 2' })).toBeVisible();
    expect(screen.getByText(/Informe · C - Parcial · Equipo sintético · 2026-10-13/)).toBeVisible();
  });

  it('says when a file is no longer stored', async () => {
    installRecordsApi({
      'DEMO/PRJ-DEMO/fuentes': [{ _id: 'F-1', Archivo_Fuente: 'Informe sintético' }],
    });
    server.use(
      http.get('/system/uploads', () => HttpResponse.json([attachment])),
      http.get('/system/uploads/ADJ-1/preview', () =>
        HttpResponse.json(
          { detail: 'El archivo ya no está disponible en este almacenamiento' },
          { status: 410 },
        ),
      ),
    );
    open('fuentes');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Ver F-1' }));
    await user.click(await screen.findByRole('button', { name: 'Ver contenido de informe.pdf' }));
    expect(
      await screen.findByText('El archivo ya no está disponible en este almacenamiento'),
    ).toBeVisible();
  });
});

describe('error 07: the directory shows its contacts and filters', () => {
  it('reads place, position and phone (also from legacy columns) and filters by place', async () => {
    installRecordsApi({
      'DEMO/PRJ-DEMO/directorio': [
        {
          _id: 'DIR-1',
          'Nombre actualizado 2026': 'Contacto uno',
          Cargo: 'Alcalde distrital',
          Ciudad: 'Vice',
          Celular: '900 000 001',
          Prioridad: 'Alta',
        },
        {
          _id: 'DIR-2',
          Nombre: 'Contacto dos',
          Cargo: 'Teniente gobernador',
          Territorio: 'Bernal',
        },
      ],
    });
    open('directorio');
    const first = (await screen.findByText('Contacto uno')).closest('tr') as HTMLElement;
    expect(within(first).getByText('Alcalde distrital')).toBeVisible();
    expect(within(first).getByText('Vice')).toBeVisible();
    expect(within(first).getByText('900 000 001')).toBeVisible();
    expect(screen.getByRole('columnheader', { name: 'Territorio / ciudad' })).toBeVisible();
    await userEvent.setup().selectOptions(screen.getByLabelText('Territorio / ciudad'), 'Bernal');
    expect(screen.queryByText('Contacto uno')).toBeNull();
    expect(screen.getByText('Contacto dos')).toBeVisible();
  });
});
