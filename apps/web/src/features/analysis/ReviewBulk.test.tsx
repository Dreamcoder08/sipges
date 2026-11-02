import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '../../test/server.ts';
import type { FeatureContext } from '../../shared/api/feature-context.ts';
import { ReviewInbox } from './ReviewInbox.tsx';

// T26 (odd/tasks/functional-closure.md S14): select and decide many review items at once,
// confirming with the dry-run counts first. Synthetic data only.

const context: FeatureContext = {
  scope: 'SIPGES/PRJ-SECHURA',
  projectId: 'PRJ-SECHURA',
  projectLabel: 'Sechura',
  role: 'analista',
  username: 'ana',
  fullName: 'Ana',
};
const item = (n: number, status = 'pendiente') => ({
  id: `review${n}`,
  project_id: context.projectId,
  source_file: 'acta-sintetica.txt',
  source_sha256: 'a'.repeat(64),
  location: `Línea ${n}`,
  theme: 'Demandas e intereses',
  excerpt: `Fragmento sintético ${n}.`,
  action: 'Contrastar.',
  status,
  reviewer: '',
  note: '',
  created_at: '2026-11-02T00:00:00Z',
  updated_at: '2026-11-02T00:00:00Z',
  target: { module: 'demandas', label: 'Demandas' },
  record: null,
});
const counts = (decided: number, dryRun: boolean, remaining = 0) => ({
  ok: true,
  dry_run: dryRun,
  decided,
  records_created: decided,
  skipped: 0,
  remaining,
  modules: [{ module: 'demandas', label: 'Demandas', nuevos: decided, ya_existentes: 0 }],
  problems: [],
});

const serve = (items: ReturnType<typeof item>[]) => {
  const bodies: Record<string, unknown>[] = [];
  server.use(
    http.get('*/system/document-lab/review', () =>
      HttpResponse.json({
        items,
        total: items.length,
        limit: 50,
        offset: 0,
        themes: { 'Demandas e intereses': items.length },
        limitations: 'Revisado no implica verdad certificada.',
      }),
    ),
    http.post('*/system/document-lab/review/bulk', async ({ request }) => {
      expect(request.headers.get('X-SIPGES-Scope')).toBe(context.scope);
      const body = (await request.json()) as Record<string, unknown>;
      bodies.push(body);
      const size = Array.isArray(body.ids) ? body.ids.length : 1200;
      const decided = Math.min(size, 1000);
      return HttpResponse.json(counts(decided, body.dry_run === true, size - decided));
    }),
  );
  return bodies;
};

const mount = (role: FeatureContext['role'] = 'analista') =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <ReviewInbox {...context} role={role} />
    </QueryClientProvider>,
  );

describe('bulk review decision in the inbox (T26)', () => {
  it('selects visible pending items and approves them after the preview', async () => {
    const bodies = serve([item(1), item(2), item(3), item(4, 'descartado')]);
    mount();
    const bar = await screen.findByRole('group', { name: 'Decisión en lote' });
    const approve = within(bar).getByRole('button', { name: 'Aprobar seleccionados (0)' });
    expect(approve).toBeDisabled();
    // Decided items have no checkbox.
    expect(screen.getAllByRole('checkbox', { name: /^Seleccionar hallazgo/ })).toHaveLength(3);

    await userEvent.click(
      within(bar).getByRole('checkbox', { name: 'Seleccionar todos los visibles' }),
    );
    await userEvent.click(
      screen.getByRole('checkbox', { name: 'Seleccionar hallazgo Línea 2 de acta-sintetica.txt' }),
    );
    await userEvent.click(within(bar).getByRole('button', { name: 'Aprobar seleccionados (2)' }));

    const dialog = await screen.findByRole('alertdialog', { name: 'Aprobar en lote' });
    await within(dialog).findByText(/Se aprobarán 2 hallazgos pendientes seleccionados/);
    expect(dialog).toHaveTextContent('se crearán 2 registros: Demandas 2.');
    expect(bodies).toEqual([
      { ids: ['review1', 'review3'], status: 'aceptado_para_revision', dry_run: true },
    ]);
    // Focus starts on «Cancelar».
    expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toHaveFocus();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Aprobar 2' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(bodies[1]).toEqual({
      ids: ['review1', 'review3'],
      status: 'aceptado_para_revision',
      dry_run: false,
    });
    expect(
      await screen.findByText('Se decidieron 2 hallazgos y se crearon 2 registros.'),
    ).toBeInTheDocument();
  });

  it('discards the selection and cancels without writing', async () => {
    const bodies = serve([item(1), item(2)]);
    mount();
    const bar = await screen.findByRole('group', { name: 'Decisión en lote' });
    await userEvent.click(
      screen.getByRole('checkbox', { name: 'Seleccionar hallazgo Línea 1 de acta-sintetica.txt' }),
    );
    await userEvent.click(within(bar).getByRole('button', { name: 'Descartar seleccionados' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Descartar en lote' });
    await within(dialog).findByText(/Se descartarán 1 hallazgos pendientes seleccionados/);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(bodies.map((body) => body.dry_run)).toEqual([true]);
  });

  it('approves every pending item of a theme or a document, showing what remains', async () => {
    const bodies = serve([item(1)]);
    mount();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Aprobar todos los pendientes de este tema' }),
    );
    let dialog = await screen.findByRole('alertdialog');
    await within(dialog).findByText(/Se aprobarán 1,000 hallazgos pendientes del tema/);
    expect(dialog).toHaveTextContent('Quedan 200 para otra tanda (máximo 1,000 por vez).');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Aprobar 1,000' }));
    expect(
      await screen.findByText(/Quedan 200 pendientes: repita la acción para la siguiente tanda\./),
    ).toBeInTheDocument();
    expect(bodies[1]).toEqual({
      theme: 'Demandas e intereses',
      status: 'aceptado_para_revision',
      dry_run: false,
    });

    await userEvent.click(
      screen.getByRole('button', { name: 'Aprobar todos los pendientes de este documento' }),
    );
    dialog = await screen.findByRole('alertdialog');
    await within(dialog).findByText(/del documento «acta-sintetica\.txt»/);
    expect(bodies[2]).toEqual({
      source_sha256: 'a'.repeat(64),
      status: 'aceptado_para_revision',
      dry_run: true,
    });
  });

  it('shows no bulk controls to read-only roles', async () => {
    serve([item(1)]);
    mount('consulta');
    await screen.findByText('Fragmento sintético 1.');
    expect(screen.queryByRole('group', { name: 'Decisión en lote' })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
});
