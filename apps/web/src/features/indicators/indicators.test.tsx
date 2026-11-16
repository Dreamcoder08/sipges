import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
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
  it('aclara que las contribuciones del prototipo no intervienen en el IRSA V0.4', async () => {
    renderPage(<IrsaPage {...context} />);
    const group = await screen.findByRole('group', { name: 'Contribuciones del prototipo' });
    expect(group).toHaveTextContent('No intervienen en el cálculo del IRSA V0.4');
    expect(group).toHaveTextContent('para comparar con el prototipo SIPGES.');
  });
  it('valida pesos antes de guardar y no modifica parámetros no editados', async () => {
    renderPage(<IrsaPage {...context} />);
    const weight = await screen.findByLabelText('Peso G · Gobernanza');
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
  it('sin evidencia muestra «Sin datos suficientes», sin nivel ni color de riesgo (S3)', async () => {
    server.use(
      http.get('*/system/irsa', () =>
        HttpResponse.json({
          ...report,
          coverage: { G: 0, A: 0, D: 0, N: 0, E: 0, I: 0 },
          insufficient_data: true,
        }),
      ),
    );
    renderPage(<IrsaPage {...context} />);
    const current = (await screen.findByRole('heading', { name: 'IRSA actual' })).closest(
      'section',
    ) as HTMLElement;
    expect(await within(current).findByText('Sin datos suficientes')).toBeVisible();
    expect(
      within(current).getByText('Carga registros del proyecto para calcular el IRSA.'),
    ).toBeVisible();
    expect(current).not.toHaveTextContent('7,0 / 100');
    expect(current).not.toHaveTextContent('Verde');
  });
  it('con datos muestra el valor y el nivel, sin el aviso de falta de datos (S3, S5)', async () => {
    renderPage(<IrsaPage {...context} />);
    const current = (await screen.findByRole('heading', { name: 'IRSA actual' })).closest(
      'section',
    ) as HTMLElement;
    await waitFor(() => expect(current).toHaveTextContent('7,0 / 100 · Verde'));
    expect(screen.queryByText('Sin datos suficientes')).not.toBeInTheDocument();
  });
  // functional-10 T1 (F2) and T2 (F4–F6).
  it('escribe los valores con coma, los pesos como partes que suman 100 % y los cortes en hora de Lima', async () => {
    const sixth = 0.1666667;
    const weights = { G: sixth, A: sixth, D: sixth, N: sixth, E: sixth, I: 0.1666665 };
    server.use(
      http.get('*/system/irsa', () =>
        HttpResponse.json({
          ...report,
          irsa: 10.75,
          weights,
          availability: { ...numbers, G: 100 },
        }),
      ),
      http.get('*/system/irsa/history', () =>
        HttpResponse.json([
          {
            id: 2,
            ts: '2026-11-15T03:32:56Z',
            irsa: 2.8,
            level: 'Verde',
            scores: numbers,
            config_version: '0.4-indicators',
            note: 'Corte nocturno',
          },
          {
            id: 1,
            ts: '2026-10-13T15:00:00Z',
            irsa: 7,
            level: 'Verde',
            scores: numbers,
            config_version: '0.4-indicators',
            note: 'Corte anterior',
          },
        ]),
      ),
    );
    renderPage(<IrsaPage {...context} />);
    const current = (await screen.findByRole('heading', { name: 'IRSA actual' })).closest(
      'section',
    ) as HTMLElement;
    // Wait for the value, then read it: a wrong format fails at once instead of timing out.
    expect(await within(current).findByText(/\/ 100 · Verde/)).toHaveTextContent(
      '10,8 / 100 · Verde',
    );
    const table = within(current).getByRole('table', { name: /Puntuación y disponibilidad/ });
    const row = (name: string) =>
      within(table).getByRole('rowheader', { name }).closest('tr') as HTMLElement;
    expect(row('G · Gobernanza')).toHaveTextContent(/G · Gobernanza\s*15,0\s*16,7\s%\s*100,0\s%/);
    expect(row('I · Institucional')).toHaveTextContent(
      /I · Institucional\s*0,0\s*16,6\s%\s*0,0\s%/,
    );
    expect(row('Total')).toHaveTextContent(/Total\s*100,0\s%/);
    expect(table).not.toHaveTextContent('0.1666');

    const history = screen
      .getByRole('heading', { name: 'Historial de cortes' })
      .closest('section') as HTMLElement;
    const cuts = await within(history).findByRole('table', {
      name: 'Últimos 50 cortes del proyecto',
    });
    await within(cuts).findByText('Corte nocturno');
    expect(history).toHaveTextContent('Último corte guardado: 2,8 / Verde · 14 nov. 2026, 22:32');
    expect(cuts).toHaveTextContent('14 nov. 2026, 22:32');
    expect(cuts).toHaveTextContent('2,8 / Verde');
    expect(cuts).not.toHaveTextContent('2026-11-15T03:32:56Z');
    expect(cuts.querySelector('time')).toHaveAttribute('datetime', '2026-11-15T03:32:56Z');
  });
  it('marca la metodología pendiente de validación junto al valor (S3)', async () => {
    server.use(
      http.get('*/system/irsa/config', () =>
        HttpResponse.json({ ...config, status: 'PENDIENTE_DE_VALIDACION_METODOLOGICA' }),
      ),
    );
    renderPage(<IrsaPage {...context} />);
    expect(await screen.findByText('Metodología pendiente de validación')).toBeVisible();
  });
  it('muestra un solo aviso junto al valor y deja la metodología tras un desplegable', async () => {
    server.use(
      http.get('*/system/irsa', () =>
        HttpResponse.json({
          ...report,
          status: 'PROVISIONAL / PENDIENTE DE VALIDACIÓN DE EXPERTOS',
          notes: ['Los métodos actuales requieren validación y calibración.'],
        }),
      ),
      http.get('*/system/irsa/config', () =>
        HttpResponse.json({ ...config, status: 'PENDIENTE_DE_VALIDACION_METODOLOGICA' }),
      ),
    );
    const user = userEvent.setup();
    renderPage(<IrsaPage {...context} />);
    const current = (await screen.findByRole('heading', { name: 'IRSA actual' })).closest(
      'section',
    ) as HTMLElement;
    expect(await within(current).findByText('Metodología pendiente de validación')).toBeVisible();
    const caveats = () =>
      within(current)
        .queryAllByText(/pendiente de validaci|validación y calibración/i)
        // Text inside a closed disclosure is not shown next to the value.
        .filter((node) => !node.closest('details:not([open])'));
    expect(caveats().map((node) => node.textContent)).toEqual([
      'Metodología pendiente de validación',
    ]);
    await user.click(within(current).getByText('Cómo se calcula'));
    expect(
      within(current).getByText('PROVISIONAL / PENDIENTE DE VALIDACIÓN DE EXPERTOS'),
    ).toBeVisible();
    expect(
      within(current).getByText('Los métodos actuales requieren validación y calibración.'),
    ).toBeVisible();
  });
  it('no marca la metodología como pendiente cuando la configuración no lo dice (S3)', async () => {
    renderPage(<IrsaPage {...context} />);
    await screen.findByText(/7,0 \/ 100/);
    expect(screen.queryByText('Metodología pendiente de validación')).not.toBeInTheDocument();
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
    const weight = await screen.findByLabelText('Peso G · Gobernanza');
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
    expect(screen.getByLabelText('Peso G · Gobernanza')).toHaveValue('0.5');
  });
});

// functional-10 T13 (F30): the weight and band inputs write the decimal comma, accept a comma or a
// point, and store the same numbers as before when they are not edited.
describe('Parámetros del índice con coma decimal', () => {
  const sixth = 0.1666667;
  const thirds = {
    weights: { G: sixth, A: sixth, D: sixth, N: sixth, E: sixth, I: 0.1666665 },
    thresholds: { Verde: [0, 24.99], Amarillo: [25, 49.99], Naranja: [50, 74.99], Rojo: [75, 100] },
    contributions: { eventos: 2.5 },
  };
  const savedPayload = () =>
    calls.find((call) => call.path === 'config')?.body as { payload: typeof thirds } | undefined;
  beforeEach(() => {
    server.use(http.get('*/system/irsa/config', () => HttpResponse.json(thirds)));
  });

  it('muestra los pesos con coma como partes que suman 1, igual que las partes en %', async () => {
    renderPage(<IrsaPage {...context} />);
    const group = await screen.findByRole('group', { name: 'Pesos de dimensiones' });
    const values = within(group)
      .getAllByRole('textbox')
      .map((input) => (input as HTMLInputElement).value);
    expect(values).toEqual(['0,167', '0,167', '0,167', '0,167', '0,166', '0,166']);
    expect(group).toHaveTextContent('Suma de los pesos: 1,000');
    expect(group).not.toHaveTextContent('0.166');
  });

  it('muestra las bandas y las contribuciones con coma decimal', async () => {
    renderPage(<IrsaPage {...context} />);
    const bands = await screen.findByRole('group', { name: 'Bandas de riesgo' });
    expect(within(bands).getByLabelText('Límite superior Verde')).toHaveValue('24,99');
    expect(within(bands).getByLabelText('Límite inferior Amarillo')).toHaveValue('25');
    expect(within(bands).getByLabelText('Límite superior Naranja')).toHaveValue('74,99');
    const contributions = screen.getByRole('group', { name: 'Contribuciones del prototipo' });
    expect(within(contributions).getByRole('textbox')).toHaveValue('2,5');
    for (const input of screen.getAllByRole('textbox', { name: /^(Peso|Límite)/ }))
      expect(input).toHaveAttribute('inputmode', 'decimal');
  });

  it('guarda los mismos números cuando no se edita ningún campo', async () => {
    renderPage(<IrsaPage {...context} />);
    await screen.findByRole('group', { name: 'Pesos de dimensiones' });
    await userEvent.click(screen.getByRole('button', { name: 'Guardar configuración' }));
    await waitFor(() => expect(savedPayload()).toEqual({ payload: thirds }));
  });

  it('acepta la coma y el punto decimal al editar', async () => {
    renderPage(<IrsaPage {...context} />);
    const g = await screen.findByLabelText('Peso G · Gobernanza');
    const i = screen.getByLabelText('Peso I · Institucional');
    await userEvent.clear(g);
    await userEvent.type(g, '0,2');
    await userEvent.clear(i);
    await userEvent.type(i, '0.1333332');
    const upper = screen.getByLabelText('Límite superior Verde');
    await userEvent.clear(upper);
    await userEvent.type(upper, '24,5');
    await userEvent.click(screen.getByRole('button', { name: 'Guardar configuración' }));
    await waitFor(() =>
      expect(savedPayload()).toEqual({
        payload: {
          ...thirds,
          weights: { ...thirds.weights, G: 0.2, I: 0.1333332 },
          thresholds: { ...thirds.thresholds, Verde: [0, 24.5] },
        },
      }),
    );
  });

  it('rechaza un valor que no es un número, con coma o sin ella, sin guardar', async () => {
    renderPage(<IrsaPage {...context} />);
    const upper = await screen.findByLabelText('Límite superior Verde');
    await userEvent.clear(upper);
    await userEvent.type(upper, '24,9,9');
    await userEvent.click(screen.getByRole('button', { name: 'Guardar configuración' }));
    expect(
      await screen.findByText('Revise los valores numéricos y los límites de cada banda.'),
    ).toBeInTheDocument();
    expect(calls.filter((call) => call.path === 'config')).toHaveLength(0);
  });
});
