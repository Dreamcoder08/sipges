import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { server } from '../../test/server.ts';
import type { FeatureContext } from '../../shared/api/feature-context.ts';
import { SituationalPage, StrategyPage } from './index.ts';
import { DocumentLab } from './DocumentLab.tsx';

vi.mock('../../shared/api/download.ts', () => ({
  downloadFile: vi.fn().mockResolvedValue(undefined),
}));
const context: FeatureContext = {
  scope: 'MASCLI/PRJ-SECHURA',
  projectId: 'PRJ-SECHURA',
  projectLabel: 'Sechura',
  role: 'admin',
  username: 'ana',
  fullName: 'Ana',
};
const counts = { intereses: 1, dialogos: 0, oportunidades: 0, hechos: 1, aarc: 0 };
const finding = {
  id: 'H001',
  tema: 'Demandas e intereses',
  ubicacion: 'Línea 1',
  fragmento: 'Solicitud de empleo para la comunidad.',
  terminos: ['empleo'],
  accion_sugerida: 'Contrastar fuentes.',
  estado: 'Candidato no verificado',
};
const analysis = {
  version: '2.1',
  project_id: context.projectId,
  filename: 'acta.txt',
  sha256: 'a'.repeat(64),
  generated_at: '2026-10-13T00:00:00Z',
  text_sections: 1,
  items: [finding],
  themes: { 'Demandas e intereses': 1 },
  recommendations: [],
  method: 'Detección léxica local',
  limitations: ['No hechos corroborados.'],
};
const review = {
  id: 'review1',
  project_id: context.projectId,
  source_file: 'acta.txt',
  source_sha256: 'a'.repeat(64),
  location: 'Línea 1',
  theme: finding.tema,
  excerpt: finding.fragmento,
  action: finding.accion_sugerida,
  status: 'pendiente',
  reviewer: '',
  note: '',
  created_at: analysis.generated_at,
  updated_at: analysis.generated_at,
};
const mount = (element: React.ReactNode) =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      {element}
    </QueryClientProvider>,
  );
const inbox = () =>
  server.use(
    http.get('*/system/document-lab/review', () =>
      HttpResponse.json({
        items: [review],
        total: 1,
        limit: 50,
        offset: 0,
        themes: { [review.theme]: 1 },
        limitations: 'Revisión no certifica verdad.',
      }),
    ),
  );

/** Serves a 120-item queue (2 themes) honouring limit, offset, theme and status. */
const pagedInbox = (requests: URL[]) =>
  server.use(
    http.get('*/system/document-lab/review', ({ request }) => {
      const url = new URL(request.url);
      requests.push(url);
      const limit = Number(url.searchParams.get('limit') ?? 50);
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const theme = url.searchParams.get('theme');
      const all = Array.from({ length: 120 }, (_, n) => ({
        ...review,
        id: `review${n}`,
        theme: n < 100 ? 'Compromisos' : 'Demandas',
      })).filter((row) => !theme || row.theme === theme);
      return HttpResponse.json({
        items: all.slice(offset, offset + limit),
        total: all.length,
        limit,
        offset,
        themes: { Compromisos: 100, Demandas: 20 },
        limitations: 'Revisión no certifica verdad.',
      });
    }),
  );

describe('analysis pages', () => {
  it('shows actual situational counts, source excerpts and limitations; downloads scoped report', async () => {
    server.use(
      http.get('*/system/situational-analysis', ({ request }) => {
        expect(request.headers.get('X-MASCLI-Scope')).toBe(context.scope);
        return HttpResponse.json({
          project_id: context.projectId,
          project_name: 'Sechura',
          generated_at: analysis.generated_at,
          method: 'Reglas locales',
          counts: {
            eventos: 2,
            actores: 1,
            demandas: 1,
            compromisos: 0,
            narrativas: 0,
            alertas: 0,
            acciones: 0,
            fuentes: 1,
          },
          alertas_activas: 0,
          demandas_pendientes: 1,
          territorios: [['Sechura', 2]],
          temas_demanda: [['Trabajo', 1]],
          niveles_alerta: [],
          eventos_recientes: [{ id: 'E1', Titulo: 'Reunión vecinal' }],
          alertas_prioritarias: [],
          demandas_abiertas: [],
          actores: [],
          observaciones: ['Revisar demanda abierta.'],
          escenarios: [{ nombre: 'Continuidad', supuesto: 'Seguimiento de fuentes' }],
          recomendaciones: ['Contrastar testimonios.'],
          limitations: ['No certifica riesgo.'],
        });
      }),
    );
    mount(<SituationalPage {...context} />);
    expect(await screen.findByText('Reunión vecinal')).toBeVisible();
    expect(screen.getByText('No certifica riesgo.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Descargar informe situacional' }));
    const { downloadFile } = await import('../../shared/api/download.ts');
    expect(downloadFile).toHaveBeenCalledWith(
      context.scope,
      '/system/situational-report.docx',
      'MASCLI_Analisis_Situacional.docx',
    );
  });
  it('renders strategic recommendations as proposals and composes requested record editor', async () => {
    server.use(
      http.get('*/system/strategic-assessment', () =>
        HttpResponse.json({
          project_id: context.projectId,
          generated_at: analysis.generated_at,
          counts,
          facts_pending: 1,
          opportunities_open: 0,
          dialogues_open: 0,
          aarc_complete: 0,
          attention: ['Verificar hecho pendiente'],
          limitations: ['Revisión humana.'],
        }),
      ),
      http.get('*/system/consensus-engine', () =>
        HttpResponse.json({
          project_id: context.projectId,
          generated_at: analysis.generated_at,
          method: 'Reglas',
          counts,
          recommendations: [
            {
              tipo: 'Revisión',
              titulo: 'Contrastar fuentes',
              motivo: 'Falta evidencia',
              accion_sugerida: 'Solicitar acta',
              origen: 'H1',
              registros_relacionados: ['H1'],
              prioridad_orientativa: 'Alta',
              estado: 'Propuesta',
              autorizacion: 'Requiere revisión humana',
            },
          ],
          summary: { total: 1, alta: 1 },
          limitations: ['No ejecuta acciones.'],
        }),
      ),
      http.get('*/system/integrated-analysis', () =>
        HttpResponse.json({
          project_id: context.projectId,
          generated_at: analysis.generated_at,
          version: '1.9',
          summary: { cruces_candidatos: 0, acciones_sugeridas: 0, registros_estrategicos: 2 },
          candidate_links: [],
          action_plan: [],
          scenarios: [],
          limitations: ['Cruces no corroborados.'],
        }),
      ),
    );
    inbox();
    mount(<StrategyPage {...context} renderRecords={(module) => <p>Editor {module}</p>} />);
    expect(await screen.findByText('Verificar hecho pendiente')).toBeVisible();
    expect(await screen.findByText('Requiere revisión humana')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Hechos por verificar' }));
    expect(screen.getByText('Editor hechos')).toBeVisible();
  });
  it('allows retry after a report error', async () => {
    server.use(
      http.get('*/system/situational-analysis', () =>
        HttpResponse.json({ detail: 'Servicio temporalmente ocupado' }, { status: 503 }),
      ),
    );
    mount(<SituationalPage {...context} />);
    expect(await screen.findByText('Servicio temporalmente ocupado')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Actualizar análisis' })).toBeEnabled();
  });
});

describe('document lab', () => {
  it('pins analysis and import to active project and imports matching source fingerprint only once', async () => {
    inbox();
    const imported: unknown[] = [];
    server.use(
      http.post('*/system/document-lab/analyze', async ({ request }) => {
        expect(request.headers.get('X-MASCLI-Scope')).toBe(context.scope);
        const form = await request.formData();
        expect(form.get('project_id')).toBe(context.projectId);
        expect(form.get('file')).toBeInstanceOf(File);
        return HttpResponse.json(analysis);
      }),
      http.post('*/system/document-lab/review/import', async ({ request }) => {
        expect(request.headers.get('X-MASCLI-Scope')).toBe(context.scope);
        imported.push(await request.json());
        return HttpResponse.json({ ok: true, new_items: 1, message: 'Extractos importados.' });
      }),
    );
    mount(<DocumentLab {...context} />);
    fireEvent.change(screen.getByLabelText('Documento para lectura'), {
      target: { files: [new File(['Solicitud de empleo'], 'acta.txt', { type: 'text/plain' })] },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Analizar documento' }));
    expect(await screen.findByText('No hechos corroborados.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Enviar candidatos a revisión' }));
    await screen.findByText('Extractos importados.');
    expect(imported).toEqual([
      {
        project_id: context.projectId,
        filename: analysis.filename,
        sha256: analysis.sha256,
        items: analysis.items,
      },
    ]);
    expect(screen.getByRole('button', { name: 'Enviar candidatos a revisión' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Documento para lectura'), {
      target: { files: [new File(['Otra fuente'], 'otro.txt')] },
    });
    expect(
      screen.queryByRole('button', { name: 'Enviar candidatos a revisión' }),
    ).not.toBeInTheDocument();
  });
  it('requires an evidence note to corroborate, pins decisions and does not permit consulta writes', async () => {
    inbox();
    const decisions: unknown[] = [];
    server.use(
      http.patch('*/system/document-lab/review/review1', async ({ request }) => {
        expect(request.headers.get('X-MASCLI-Scope')).toBe(context.scope);
        decisions.push(await request.json());
        return HttpResponse.json({
          ok: true,
          id: 'review1',
          status: 'corroborado_documentalmente',
        });
      }),
    );
    mount(<DocumentLab {...context} />);
    const row = await screen.findByRole('group', { name: 'Revisar hallazgo review1' });
    await userEvent.selectOptions(
      within(row).getByLabelText('Decisión'),
      'corroborado_documentalmente',
    );
    expect(within(row).getByRole('button', { name: 'Guardar decisión' })).toBeDisabled();
    await userEvent.type(
      within(row).getByLabelText('Nota sobre evidencia contrastada'),
      'Acta original contrastada con fecha y firma.',
    );
    await userEvent.click(within(row).getByRole('button', { name: 'Guardar decisión' }));
    await waitFor(() => expect(decisions).toHaveLength(1));
    expect(decisions[0]).toEqual({
      status: 'corroborado_documentalmente',
      reviewer: context.fullName,
      note: 'Acta original contrastada con fecha y firma.',
    });
  });
  it('pages the review queue and shows the total, page and item count', async () => {
    const requests: URL[] = [];
    pagedInbox(requests);
    mount(<DocumentLab {...context} />);
    expect(await screen.findByText('120 hallazgos en la bandeja del proyecto.')).toBeVisible();
    expect(screen.getByText('Página 1 de 3')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Anterior' })).toBeDisabled();
    expect(requests.at(-1)?.searchParams.get('offset')).toBe('0');
    await userEvent.click(screen.getByRole('button', { name: 'Siguiente' }));
    expect(await screen.findByText('Página 2 de 3')).toBeVisible();
    expect(requests.at(-1)?.searchParams.get('offset')).toBe('50');
    await userEvent.click(screen.getByRole('button', { name: 'Siguiente' }));
    expect(await screen.findByText('Página 3 de 3')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Siguiente' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Anterior' }));
    expect(await screen.findByText('Página 2 de 3')).toBeVisible();
  });
  it('filters by theme with counts and by status, returning to the first page', async () => {
    const requests: URL[] = [];
    pagedInbox(requests);
    mount(<DocumentLab {...context} />);
    const theme = await screen.findByLabelText('Filtrar tema');
    expect(
      await within(theme).findByRole('option', { name: 'Compromisos (100)' }),
    ).toBeInTheDocument();
    expect(within(theme).getByRole('option', { name: 'Demandas (20)' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Siguiente' }));
    expect(await screen.findByText('Página 2 de 3')).toBeVisible();
    await userEvent.selectOptions(theme, 'Demandas');
    expect(await screen.findByText('20 hallazgos en la bandeja del proyecto.')).toBeVisible();
    expect(screen.getByText('Página 1 de 1')).toBeVisible();
    const last = requests.at(-1);
    expect(last?.searchParams.get('theme')).toBe('Demandas');
    expect(last?.searchParams.get('offset')).toBe('0');
    await userEvent.selectOptions(
      screen.getByLabelText('Filtrar estado de revisión'),
      'descartado',
    );
    await waitFor(() => expect(requests.at(-1)?.searchParams.get('status')).toBe('descartado'));
    expect(requests.at(-1)?.searchParams.get('theme')).toBe('Demandas');
  });
  it('refetches the current page after a decision', async () => {
    const requests: URL[] = [];
    pagedInbox(requests);
    server.use(
      http.patch('*/system/document-lab/review/:id', ({ params }) =>
        HttpResponse.json({ ok: true, id: params.id, status: 'descartado' }),
      ),
    );
    mount(<DocumentLab {...context} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Siguiente' }));
    const row = await screen.findByRole('group', { name: 'Revisar hallazgo review50' });
    const before = requests.length;
    await userEvent.selectOptions(within(row).getByLabelText('Decisión'), 'descartado');
    await userEvent.click(within(row).getByRole('button', { name: 'Guardar decisión' }));
    await waitFor(() => expect(requests.length).toBeGreaterThan(before));
    expect(requests.at(-1)?.searchParams.get('offset')).toBe('50');
    expect(screen.getByText('Página 2 de 3')).toBeVisible();
  });
  it('compares files as candidates and exposes failure without discarding selected documents', async () => {
    inbox();
    let calls = 0;
    server.use(
      http.post('*/system/document-lab/compare', async ({ request }) => {
        const form = await request.formData();
        expect(form.get('file_a')).toBeInstanceOf(File);
        expect(form.get('file_b')).toBeInstanceOf(File);
        expect(request.headers.get('X-MASCLI-Scope')).toBe(context.scope);
        if (++calls === 1)
          return HttpResponse.json({ detail: 'No se puede leer el documento' }, { status: 422 });
        return HttpResponse.json({
          version: '2.1',
          project_id: context.projectId,
          documents: [
            { filename: 'a.txt', sha256: 'a'.repeat(64) },
            { filename: 'b.txt', sha256: 'b'.repeat(64) },
          ],
          comparaciones: [
            {
              tema: 'Demandas',
              a: { ubicacion: 'Línea 1', fragmento: 'Solicitud de empleo' },
              b: { ubicacion: 'Línea 2', fragmento: 'Empleo solicitado' },
              terminos_comunes: ['empleo'],
              coincidencia_lexica: 0.5,
              tipo: 'Coincidencia temática',
              advertencia: 'No demuestra acuerdo confirmado.',
            },
          ],
          total_candidatos: 1,
          method: 'Comparación léxica',
          limitations: ['No prueba contradicciones.'],
        });
      }),
    );
    mount(<DocumentLab {...context} />);
    for (const [label, name] of [
      ['Primer documento', 'a.txt'],
      ['Segundo documento', 'b.txt'],
    ] as const)
      fireEvent.change(screen.getByLabelText(label), {
        target: { files: [new File(['Empleo solicitado a la comunidad'], name)] },
      });
    await userEvent.click(screen.getByRole('button', { name: 'Comparar documentos' }));
    expect(await screen.findByText('No se puede leer el documento')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Comparar documentos' }));
    expect(await screen.findByText('No demuestra acuerdo confirmado.')).toBeVisible();
  });
  it('allows read-only analysis for consulta and omits import and review controls', async () => {
    inbox();
    mount(<DocumentLab {...context} role="consulta" />);
    await screen.findByText('Revisión no certifica verdad.');
    expect(screen.getByRole('button', { name: 'Analizar documento' })).toBeDisabled();
    expect(screen.queryByLabelText('Decisión')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Enviar candidatos a revisión' }),
    ).not.toBeInTheDocument();
  });
});

describe('document operation regressions', () => {
  it('locks the analyzed file and rejects duplicate submissions while a read is pending', async () => {
    inbox();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let calls = 0;
    server.use(
      http.post('*/system/document-lab/analyze', async () => {
        calls++;
        await gate;
        return HttpResponse.json(analysis);
      }),
    );
    mount(<DocumentLab {...context} />);
    const input = screen.getByLabelText('Documento para lectura');
    fireEvent.change(input, { target: { files: [new File(['Acta'], 'acta.txt')] } });
    const button = screen.getByRole('button', { name: 'Analizar documento' });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(calls).toBe(1));
    expect(input).toBeDisabled();
    fireEvent.change(input, { target: { files: [new File(['Nueva fuente'], 'otra.txt')] } });
    finish();
    await screen.findByText('No hechos corroborados.');
    expect(screen.getByRole('button', { name: 'Enviar candidatos a revisión' })).toBeEnabled();
    expect(calls).toBe(1);
  });
  it('retries a failed import without losing the matching candidate and original source fingerprint', async () => {
    inbox();
    let calls = 0;
    server.use(
      http.post('*/system/document-lab/analyze', () => HttpResponse.json(analysis)),
      http.post('*/system/document-lab/review/import', async ({ request }) => {
        expect(await request.json()).toMatchObject({
          filename: 'acta.txt',
          sha256: analysis.sha256,
          project_id: context.projectId,
        });
        if (++calls === 1)
          return HttpResponse.json(
            { detail: 'Escritura temporalmente indisponible' },
            { status: 503 },
          );
        return HttpResponse.json({ ok: true, new_items: 1, message: 'Importación recuperada.' });
      }),
    );
    mount(<DocumentLab {...context} />);
    fireEvent.change(screen.getByLabelText('Documento para lectura'), {
      target: { files: [new File(['Acta'], 'acta.txt')] },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Analizar documento' }));
    await screen.findByText('No hechos corroborados.');
    await userEvent.click(screen.getByRole('button', { name: 'Enviar candidatos a revisión' }));
    expect(await screen.findByText('Escritura temporalmente indisponible')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Enviar candidatos a revisión' }));
    expect(await screen.findByText('Importación recuperada.')).toBeVisible();
    expect(calls).toBe(2);
  });
  it('consulta can analyze authorized text without gaining write controls', async () => {
    inbox();
    server.use(http.post('*/system/document-lab/analyze', () => HttpResponse.json(analysis)));
    mount(<DocumentLab {...context} role="consulta" />);
    fireEvent.change(screen.getByLabelText('Documento para lectura'), {
      target: { files: [new File(['Acta'], 'acta.txt')] },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Analizar documento' }));
    expect(await screen.findByText('No hechos corroborados.')).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Enviar candidatos a revisión' }),
    ).not.toBeInTheDocument();
  });
  it('downloads the selected document using multipart and the scope of the original operation', async () => {
    inbox();
    mount(<DocumentLab {...context} />);
    const selected = new File(['Acta de reunión'], 'acta.txt');
    fireEvent.change(screen.getByLabelText('Documento para lectura'), {
      target: { files: [selected] },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Descargar lectura documental' }));
    const { downloadFile } = await import('../../shared/api/download.ts');
    const matching = vi
      .mocked(downloadFile)
      .mock.calls.find((call) => call[1] === '/system/document-lab/report.docx');
    expect(matching?.slice(0, 3)).toEqual([
      context.scope,
      '/system/document-lab/report.docx',
      'MASCLI_RC20_Lectura_Documental.docx',
    ]);
    expect(matching?.[3]?.method).toBe('POST');
    const body = matching?.[3]?.body;
    expect(body && 'multipart' in body ? body.multipart.get('project_id') : null).toBe(
      context.projectId,
    );
    expect(body && 'multipart' in body ? body.multipart.get('file') : null).toBe(selected);
  });
  it('a keyed project switch discards pending analysis and does not expose old candidates for import', async () => {
    inbox();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let started = false;
    server.use(
      http.post('*/system/document-lab/analyze', async ({ request }) => {
        expect(request.headers.get('X-MASCLI-Scope')).toBe(context.scope);
        started = true;
        await gate;
        return HttpResponse.json(analysis);
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const result = render(
      <QueryClientProvider client={client}>
        <DocumentLab key={context.scope} {...context} />
      </QueryClientProvider>,
    );
    fireEvent.change(screen.getByLabelText('Documento para lectura'), {
      target: { files: [new File(['Acta'], 'acta.txt')] },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Analizar documento' }));
    await waitFor(() => expect(started).toBe(true));
    const other = {
      ...context,
      scope: 'MASCLI/PRJ-NORTE',
      projectId: 'PRJ-NORTE',
      projectLabel: 'Norte',
    };
    result.rerender(
      <QueryClientProvider client={client}>
        <DocumentLab key={other.scope} {...other} />
      </QueryClientProvider>,
    );
    finish();
    await screen.findByText('Revisión no certifica verdad.');
    expect(screen.queryByText('No hechos corroborados.')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Enviar candidatos a revisión' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Analizar documento' })).toBeDisabled();
  });
});
