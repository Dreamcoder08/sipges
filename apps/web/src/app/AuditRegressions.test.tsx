import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { installRecordsApi } from '../test/records-api.ts';
import { resetApi, server } from '../test/server.ts';
import { App } from './App.tsx';

/**
 * Regression tests for the functional audit (odd/archive/functional-audit-correction.md).
 * Every record here is synthetic.
 */
beforeEach(() =>
  resetApi({ me: { username: 'demo', full_name: 'Persona de prueba', role: 'admin' } }),
);
const open = (module: string) => {
  window.history.replaceState(null, '', `/${module}`);
  render(<App />);
};
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
    await user.paste('Respuesta actualizada\nSeguimiento confirmado');
    await user.selectOptions(screen.getByLabelText('Estado'), 'Atendida');
    await user.click(screen.getByRole('button', { name: 'Guardar registro' }));
    expect(await screen.findByText(/Registro D-1 guardado/)).toBeVisible();
    expect(state.payloads[0]).toMatchObject({
      Descripcion: demand.Descripcion,
      Estado: 'Atendida',
      Respuesta_Empresa: 'Respuesta actualizada\nSeguimiento confirmado',
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
    // Phones and short choices stay on one line instead of splitting in two.
    expect(within(first).getByText('900 000 001')).toHaveClass(/compact/);
    expect(screen.getByRole('columnheader', { name: 'Territorio / ciudad' })).toBeVisible();
    // The place, type and priority selects live in the one «Filtros» sheet, not on the page.
    expect(screen.queryByLabelText('Territorio / ciudad')).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Filtros' }));
    const sheet = await screen.findByRole('dialog', { name: 'Filtros' });
    await user.selectOptions(within(sheet).getByLabelText('Territorio / ciudad'), 'Bernal');
    await user.keyboard('{Escape}');
    expect(screen.queryByText('Contacto uno')).toBeNull();
    expect(screen.getByText('Contacto dos')).toBeVisible();
    const chip = screen.getByRole('button', { name: 'Quitar filtro Territorio / ciudad: Bernal' });
    expect(screen.getByRole('button', { name: 'Filtros 1' })).toBeVisible();
    await user.click(chip);
    expect(screen.getByText('Contacto uno')).toBeVisible();
  });
});

describe('narratives: trend per day and category', () => {
  it('draws one line per category from the project narratives', async () => {
    installRecordsApi({
      'DEMO/PRJ-DEMO/narrativas': [
        { _id: 'N-1', Fecha_Inicio: '2026-10-01', Tema: 'Agua', Descripcion: 'Publicación' },
        { _id: 'N-2', Fecha_Inicio: '2026-10-03', Descripcion: 'Exigen empleo local' },
      ],
    });
    open('narrativas');
    expect(
      await screen.findByRole('heading', { name: 'Tendencia temporal de narrativas' }),
    ).toBeVisible();
    expect(await screen.findByRole('columnheader', { name: 'Fecha' })).toBeInTheDocument();
    for (const label of [
      'Medio ambiente',
      'Gobernanza',
      'Demandas y compromisos',
      'Actores e influencia',
      'Narrativas y señales digitales',
    ])
      expect(screen.getByRole('columnheader', { name: label })).toBeInTheDocument();
    expect(screen.queryByLabelText('Origen')).toBeNull();
  });
});
