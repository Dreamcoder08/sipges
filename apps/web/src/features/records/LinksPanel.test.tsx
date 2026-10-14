import type { OntologyCatalog } from '@mascli/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '../../test/server.ts';
import { LinksPanel, linkOptions } from './LinksPanel.tsx';

const catalog: OntologyCatalog = {
  object_types: [],
  link_types: [
    {
      id: 'plantea',
      label: 'plantea',
      inverse_label: 'es planteada por',
      sources: ['actores'],
      targets: ['demandas'],
      symmetric: false,
    },
    {
      id: 'aliado_de',
      label: 'es aliado de',
      inverse_label: 'es aliado de',
      sources: ['actores'],
      targets: ['actores'],
      symmetric: true,
    },
    {
      id: 'sustenta',
      label: 'sustenta',
      inverse_label: 'se sustenta en',
      sources: ['fuentes'],
      targets: null,
      symmetric: false,
    },
  ],
};

const summary = (module: string, id: string, title: string, typeLabel: string) => ({
  module,
  id,
  type_label: typeLabel,
  title,
  date: null,
  marking: 'interno',
  fields: {},
});

describe('linkOptions', () => {
  it('reads every link type in this record’s direction', () => {
    expect(linkOptions(catalog, 'actores').map((o) => [o.label, o.modules])).toEqual([
      ['plantea', ['demandas']],
      ['es aliado de', ['actores']],
      ['se sustenta en', ['fuentes']],
    ]);
    expect(linkOptions(catalog, 'demandas').map((o) => o.label)).toEqual([
      'es planteada por',
      'se sustenta en',
    ]);
  });
});

describe('LinksPanel', () => {
  it('lists links, removes explicit ones and creates new ones', async () => {
    const links = [
      {
        edge: {
          id: 7,
          link_type: 'plantea',
          source: { module: 'actores', id: 'A-1' },
          target: { module: 'demandas', id: 'D-1' },
          inferred: false,
          via: null,
          note: 'Mesa 1',
          created_by: 'admin',
          created_at: '2026-10-14T00:00:00Z',
        },
        direction: 'out',
        label: 'plantea',
        other: summary('demandas', 'D-1', 'Agua potable', 'Demanda'),
      },
      {
        edge: {
          id: null,
          link_type: 'sustenta',
          source: { module: 'fuentes', id: 'F-1' },
          target: { module: 'actores', id: 'A-1' },
          inferred: true,
          via: 'Fuente_ID',
          note: '',
          created_by: null,
          created_at: null,
        },
        direction: 'in',
        label: 'se sustenta en',
        other: summary('fuentes', 'F-1', 'Acta', 'Fuente'),
      },
    ];
    const deleted: string[] = [];
    const created: unknown[] = [];
    server.use(
      http.get('/system/ontology', () => HttpResponse.json(catalog)),
      http.get('/system/links', () =>
        HttpResponse.json({ record: summary('actores', 'A-1', 'Comunidad', 'Actor'), links }),
      ),
      http.delete('/system/links/:id', ({ params }) => {
        deleted.push(String(params.id));
        return HttpResponse.json({ ok: true });
      }),
      http.get('/api/demandas', () =>
        HttpResponse.json([{ _id: 'D-2', Descripcion: 'Empleo local' }]),
      ),
      http.post('/system/links', async ({ request }) => {
        created.push(await request.json());
        return HttpResponse.json({ ok: true, id: 8 });
      }),
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <LinksPanel module="actores" id="A-1" scope="A/B" writable />
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    const demand = await screen.findByRole('link', { name: 'Agua potable' });
    expect(demand).toHaveAttribute('href', '/objeto/demandas/D-1');
    expect(screen.getByText(/inferido del campo Fuente_ID/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Quitar vínculo/ })).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Quitar vínculo con Agua potable' }));
    await waitFor(() => expect(deleted).toEqual(['7']));

    const form = screen.getByRole('form', { name: 'Nuevo vínculo' });
    await user.selectOptions(
      await within(form).findByLabelText('Registro'),
      await within(form).findByRole('option', { name: 'Empleo local (D-2)' }),
    );
    await user.type(within(form).getByLabelText('Nota (opcional)'), 'Taller');
    await user.click(within(form).getByRole('button', { name: 'Vincular' }));
    await waitFor(() =>
      expect(created).toEqual([
        {
          link_type: 'plantea',
          source: { module: 'actores', id: 'A-1' },
          target: { module: 'demandas', id: 'D-2' },
          note: 'Taller',
        },
      ]),
    );
  });
});
