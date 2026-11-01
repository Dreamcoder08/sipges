import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { server } from '../../test/server.ts';
import type { FeatureContext } from '../../shared/api/feature-context.ts';
import { IrsaPage, MethodologyPage, ValidationPage } from './index.ts';
import { validationCsv } from './ValidationPage.tsx';
import { ValidationTemplate } from '@sipges/contracts';

const numbers = { G: 15, A: 20, D: 0, N: 0, E: 0, I: 0 };
const dimensions = { G: [], A: [], D: [], N: [], E: [], I: [] };
const item = {
  code: 'G1',
  score: 15,
  confidence: 'Baja',
  method: 'Proxy de representación',
  evidence_count: 2,
  explanation: 'Dos registros sintéticos',
  availability: 'Disponible',
  name: 'Representación sintética',
  definition: 'Definición sintética',
  dimension: 'G',
  dimension_label: 'Gobernanza',
};
const config = {
  weights: { G: 0.2, A: 0.2, D: 0.2, N: 0.1, E: 0.1, I: 0.2 },
  thresholds: { Verde: [0, 30], Rojo: [30, 100] },
  contributions: { eventos: 2 },
};
const report = {
  irsa: 7,
  level: 'Verde',
  scores: numbers,
  drivers: [
    {
      dimension: 'G',
      dimension_label: 'Gobernanza',
      id: 'G1',
      label: 'Representación sintética',
      points: 15,
    },
  ],
  config_version: '0.4-indicators',
  weights: config.weights,
  thresholds: config.thresholds,
  details: dimensions,
  availability: numbers,
  indicators: [item],
  status: 'PROVISIONAL',
  notes: ['Datos insuficientes se excluyen.'],
};
const context: FeatureContext = {
  scope: 'SIPGES/PRJ-SECHURA',
  projectId: 'PRJ-SECHURA',
  projectLabel: 'Proyecto sintético',
  role: 'admin',
  username: 'synthetic',
  fullName: 'Persona sintética',
};
let calls: { path: string; scope: string | null; body: unknown }[] = [];
const renderPage = (page: React.ReactNode) =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      {page}
    </QueryClientProvider>,
  );
beforeEach(() => {
  calls = [];
  server.use(
    http.get('*/system/irsa', () => HttpResponse.json(report)),
    http.get('*/system/irsa/config', () => HttpResponse.json(config)),
    http.get('*/system/irsa/history', () =>
      HttpResponse.json([
        {
          id: 1,
          ts: '2026-10-13',
          irsa: 7,
          level: 'Verde',
          scores: numbers,
          config_version: '0.4-indicators',
          note: 'Corte anterior',
        },
      ]),
    ),
    http.get('*/system/indicators', () =>
      HttpResponse.json({
        dimensions,
        dimension_scores: numbers,
        availability: numbers,
        indicators: [item],
        method_note: 'Reglas provisionales',
        validation_status: 'PROVISIONAL',
      }),
    ),
    http.get('*/system/model-status', () =>
      HttpResponse.json({
        version: '0.4',
        content_validation: 'Pendiente de expertos',
        functional_validation: 'Paridad técnica',
        release_rule: 'Requiere revisión',
      }),
    ),
    http.get('*/system/validation-template', () =>
      HttpResponse.json({
        status: 'PENDIENTE',
        rows: [
          {
            dimension: 'G',
            code: 'G1',
            name: 'Representación sintética',
            definition: 'Definición sintética',
            expert_1: null,
            expert_2: null,
            expert_3: null,
            expert_4: null,
            expert_5: null,
            aiken_v: null,
            decision: 'Pendiente',
          },
        ],
      }),
    ),
    http.post('*/system/irsa/snapshot', async ({ request }) => {
      calls.push({
        path: 'snapshot',
        scope: request.headers.get('X-SIPGES-Scope'),
        body: await request.json(),
      });
      return HttpResponse.json({ ok: true, id: 2, ...report });
    }),
    http.post('*/system/irsa/config', async ({ request }) => {
      calls.push({
        path: 'config',
        scope: request.headers.get('X-SIPGES-Scope'),
        body: await request.json(),
      });
      return HttpResponse.json({ ok: true, config });
    }),
  );
});
describe('Indicadores e IRSA', () => {
  it('explica el reporte y guarda un corte con el proyecto fijado', async () => {
    renderPage(<IrsaPage {...context} />);
    expect(await screen.findByText('Datos insuficientes se excluyen.')).toBeInTheDocument();
    expect(await screen.findByText('Corte anterior')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Nota del corte'), 'Revisión sintética');
    await userEvent.click(screen.getByRole('button', { name: 'Guardar corte IRSA' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        path: 'snapshot',
        scope: context.scope,
        body: { payload: { note: 'Revisión sintética' } },
      }),
    );
    expect(await screen.findByText('Corte IRSA guardado.')).toBeInTheDocument();
  });
  it('consulta no tiene escrituras; analista puede guardar cortes pero no configuración', async () => {
    const view = renderPage(<IrsaPage {...context} role="consulta" />);
    await screen.findByText('Datos insuficientes se excluyen.');
    expect(screen.queryByRole('button', { name: 'Guardar corte IRSA' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Guardar configuración' })).not.toBeInTheDocument();
    view.unmount();
    renderPage(<IrsaPage {...context} role="analista" />);
    expect(await screen.findByRole('button', { name: 'Guardar corte IRSA' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Guardar configuración' })).not.toBeInTheDocument();
  });
  it('valida pesos antes de guardar y no modifica parámetros no editados', async () => {
    renderPage(<IrsaPage {...context} />);
    const weight = await screen.findByLabelText('Peso G');
    await userEvent.clear(weight);
    await userEvent.type(weight, '0.8');
    await userEvent.click(screen.getByRole('button', { name: 'Guardar configuración' }));
    expect(await screen.findByText('Los pesos deben sumar aproximadamente 1.')).toBeInTheDocument();
    expect(calls).toHaveLength(0);
    await userEvent.clear(weight);
    await userEvent.type(weight, '0.2');
    await userEvent.click(screen.getByRole('button', { name: 'Guardar configuración' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        path: 'config',
        scope: context.scope,
        body: { payload: config },
      }),
    );
  });
  it('presenta errores del servidor sin un resultado inventado', async () => {
    server.use(
      http.get('*/system/irsa', () =>
        HttpResponse.json({ detail: 'Reporte no disponible' }, { status: 503 }),
      ),
    );
    renderPage(<IrsaPage {...context} />);
    expect(await screen.findByText('Reporte no disponible')).toBeInTheDocument();
  });
  it('muestra plantilla pendiente sin controles de certificación', async () => {
    renderPage(<ValidationPage {...context} />);
    expect(await screen.findByText('Definición sintética')).toBeInTheDocument();
    expect(await screen.findByText('Pendiente de expertos')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Descargar plantilla CSV' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /certificar/i })).not.toBeInTheDocument();
  });
  it('presenta método, evidencia y disponibilidad de cada indicador', async () => {
    renderPage(<MethodologyPage {...context} />);
    expect(await screen.findByText('Proxy de representación')).toBeInTheDocument();
    expect(screen.getByText('Dos registros sintéticos')).toBeInTheDocument();
    expect(screen.getByText('Reglas provisionales')).toBeInTheDocument();
  });
  it('no transfiere notas ni resultados tardíos al cambiar de proyecto', async () => {
    let release!: () => void;
    let returned!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const finished = new Promise<void>((resolve) => {
      returned = resolve;
    });
    server.use(
      http.post('*/system/irsa/snapshot', async ({ request }) => {
        calls.push({
          path: 'snapshot',
          scope: request.headers.get('X-SIPGES-Scope'),
          body: await request.json(),
        });
        await gate;
        returned();
        return HttpResponse.json({ ok: true, id: 2, ...report });
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={client}>
        <IrsaPage {...context} />
      </QueryClientProvider>,
    );
    await screen.findByText('Datos insuficientes se excluyen.');
    await userEvent.type(screen.getByLabelText('Nota del corte'), 'Nota anterior');
    await userEvent.click(screen.getByRole('button', { name: 'Guardar corte IRSA' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(screen.getByLabelText('Nota del corte')).toBeDisabled();
    view.rerender(
      <QueryClientProvider client={client}>
        <IrsaPage {...context} scope="OTHER/PRJ-2" projectLabel="Otro proyecto" />
      </QueryClientProvider>,
    );
    await userEvent.type(screen.getByLabelText('Nota del corte'), 'Nuevo borrador');
    await act(async () => {
      release();
      await finished;
    });
    expect(screen.getByLabelText('Nota del corte')).toHaveValue('Nuevo borrador');
    expect(screen.queryByText('Corte IRSA guardado.')).not.toBeInTheDocument();
    expect(calls[0]?.scope).toBe(context.scope);
  });
  it('exporta columnas completas y neutraliza fórmulas sin cambiar la plantilla', () => {
    const template = ValidationTemplate.parse({
      status: 'PENDIENTE',
      rows: [
        {
          dimension: 'G',
          code: 'G1',
          name: '=SUM(1,2)',
          definition: 'Texto "literal", multilinea\nsegunda línea',
          expert_1: null,
          expert_2: null,
          expert_3: null,
          expert_4: null,
          expert_5: null,
          aiken_v: null,
          decision: 'Pendiente',
        },
      ],
    });
    const csv = validationCsv(template);
    expect(csv).toContain('expert_1,expert_2,expert_3,expert_4,expert_5,aiken_v,decision');
    expect(csv).toContain('"\'=SUM(1,2)"');
    expect(csv).toContain('"Texto ""literal"", multilinea\nsegunda línea"');
    expect(template.rows[0]?.name).toBe('=SUM(1,2)');
  });
  it('una recarga de configuración no borra un borrador sin guardar', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={client}>
        <IrsaPage {...context} />
      </QueryClientProvider>,
    );
    const weight = await screen.findByLabelText('Peso G');
    await userEvent.clear(weight);
    await userEvent.type(weight, '0.5');
    server.use(
      http.get('*/system/irsa/config', () =>
        HttpResponse.json({ ...config, weights: { ...config.weights, G: 0.3, A: 0.1 } }),
      ),
    );
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['indicators', context.scope, 'config'] });
    });
    view.rerender(
      <QueryClientProvider client={client}>
        <IrsaPage {...context} />
      </QueryClientProvider>,
    );
    expect(screen.getByLabelText('Peso G')).toHaveValue(0.5);
  });
});
