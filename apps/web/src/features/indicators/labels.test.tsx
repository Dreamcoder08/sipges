import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { server } from '../../test/server.ts';
import type { FeatureContext } from '../../shared/api/feature-context.ts';
import { IrsaPage, MethodologyPage } from './index.ts';

/** A stored key on screen (functional-10 T3): snake_case or Capitalised_Words. */
const STORED_KEY = /[a-z]+_[a-z]+|[A-Z][a-z]+_[A-Z]/;

const scores = { G: 15, A: 20, D: 0, N: 0, E: 0, I: 0 };
const contributions = {
  active_alert: 18,
  high_event: 8,
  critical_event: 12,
  open_demand: 7,
  pending_action: 5,
  unverified_narrative: 6,
};
const config = {
  weights: { G: 0.2, A: 0.2, D: 0.2, N: 0.1, E: 0.1, I: 0.2 },
  thresholds: { Verde: [0, 30], Rojo: [30, 100] },
  contributions,
};
const indicator = {
  code: 'I5',
  score: 40,
  confidence: 'Alta',
  method: 'Riesgo inverso del porcentaje de registros clave con Fuente_ID o evidencia asociada.',
  evidence_count: 2,
  explanation: 'Dos registros sintéticos',
  availability: 'Disponible',
  name: 'Trazabilidad documental',
  definition: 'Definición sintética',
  dimension: 'I',
  dimension_label: 'Institucional',
};
const report = {
  irsa: 7,
  level: 'Verde',
  scores,
  drivers: [],
  config_version: '0.4-indicators',
  weights: config.weights,
  thresholds: config.thresholds,
  details: { G: [], A: [], D: [], N: [], E: [], I: [] },
  availability: scores,
  indicators: [indicator],
  status: 'PROVISIONAL',
  notes: [],
};
const context: FeatureContext = {
  scope: 'SIPGES/PRJ-SECHURA',
  projectId: 'PRJ-SECHURA',
  projectLabel: 'Proyecto sintético',
  role: 'admin',
  username: 'synthetic',
  fullName: 'Persona sintética',
};
let saved: unknown[] = [];
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
  saved = [];
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
          scores,
          config_version: '0.4-indicators',
          note: 'Corte sintético',
        },
      ]),
    ),
    http.get('*/system/indicators', () =>
      HttpResponse.json({
        dimensions: report.details,
        dimension_scores: scores,
        availability: scores,
        indicators: [indicator],
        method_note: 'Reglas provisionales',
        validation_status: 'PROVISIONAL',
      }),
    ),
    http.get('*/system/model-status', () =>
      HttpResponse.json({
        version: 'SIPGES 1.1.0 · Prototipo final de tesis',
        content_validation: 'Pendiente de expertos',
        release_rule: 'Requiere revisión',
      }),
    ),
    http.post('*/system/irsa/config', async ({ request }) => {
      saved.push(await request.json());
      return HttpResponse.json({ ok: true, config });
    }),
  );
});

describe('IRSA sin claves almacenadas en pantalla (functional-10 T3)', () => {
  it('nombra en español las contribuciones del prototipo y guarda las mismas claves', async () => {
    renderPage(<IrsaPage {...context} />);
    const group = await screen.findByRole('group', { name: 'Contribuciones del prototipo' });
    for (const label of [
      'Contribución de alerta activa',
      'Contribución de evento de nivel alto',
      'Contribución de evento crítico',
      'Contribución de demanda abierta',
      'Contribución de acción pendiente',
      'Contribución de narrativa no verificada',
    ])
      expect(within(group).getByLabelText(label)).toBeInTheDocument();
    expect(group.textContent).not.toMatch(STORED_KEY);
    await userEvent.click(screen.getByRole('button', { name: 'Guardar configuración' }));
    await waitFor(() => expect(saved).toEqual([{ payload: config }]));
  });

  it('muestra la versión del corte como «Método IRSA v0.4»', async () => {
    renderPage(<IrsaPage {...context} />);
    const history = await screen.findByRole('region', { name: 'Historial IRSA' });
    expect(await within(history).findByText('Método IRSA v0.4')).toBeInTheDocument();
    expect(within(history).getByRole('columnheader', { name: 'Método IRSA' })).toBeInTheDocument();
    await screen.findByText(/7,0 \/ 100 · Verde/);
    expect(document.body).not.toHaveTextContent('0.4-indicators');
    expect(screen.getByText('Método IRSA v0.4', { selector: 'details p' })).toBeInTheDocument();
  });

  it('no muestra ninguna clave almacenada en el texto de la pantalla', async () => {
    renderPage(<IrsaPage {...context} />);
    await screen.findByText(/7,0 \/ 100 · Verde/);
    await screen.findByText('Corte sintético');
    await screen.findByRole('group', { name: 'Contribuciones del prototipo' });
    expect(document.body.textContent).not.toMatch(STORED_KEY);
  });

  it('pone el nombre de cada dimensión junto a su letra en gráfico, tabla y pesos', async () => {
    renderPage(<IrsaPage {...context} />);
    const table = await screen.findByRole('region', { name: 'Puntuaciones por dimensión' });
    const names = [
      'G · Gobernanza',
      'A · Actores',
      'D · Demandas',
      'N · Narrativas',
      'E · Ambiental-territorial',
      'I · Institucional',
    ];
    expect(
      within(table)
        .getAllByRole('rowheader')
        .map((cell) => cell.textContent),
    ).toEqual([...names, 'Total']);
    const legend = screen.getByRole('list', { name: 'Dimensiones del gráfico' });
    expect(
      within(legend)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(names);
    for (const name of names)
      expect(await screen.findByLabelText(`Peso ${name}`)).toBeInTheDocument();
  });

  it('la lista de pesos de solo lectura también nombra cada dimensión', async () => {
    renderPage(<IrsaPage {...context} role="consulta" />);
    const list = await screen.findByRole('list', { name: 'Pesos de dimensiones' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Peso G · Gobernanza: 20,0\u00a0%',
      'Peso A · Actores: 20,0\u00a0%',
      'Peso D · Demandas: 20,0\u00a0%',
      'Peso N · Narrativas: 10,0\u00a0%',
      'Peso E · Ambiental-territorial: 10,0\u00a0%',
      'Peso I · Institucional: 20,0\u00a0%',
    ]);
  });
});

describe('Metodología en lenguaje llano (functional-10 T3, T5)', () => {
  it('no imprime el nombre del campo Fuente_ID en el método de un indicador', async () => {
    renderPage(<MethodologyPage {...context} />);
    expect(
      await screen.findByText(
        'Riesgo inverso del porcentaje de registros clave con referencia de fuente o evidencia asociada.',
      ),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(STORED_KEY);
  });

  it('explica en español qué es el puntaje de Brier', async () => {
    renderPage(<MethodologyPage {...context} />);
    const card = (
      await screen.findByRole('heading', {
        name: 'Cómo se calcula el riesgo de conflicto',
      })
    ).closest('section') as HTMLElement;
    expect(card).toHaveTextContent(
      'puntaje de Brier: el error medio entre la probabilidad estimada y lo que ocurrió; cuanto más bajo, mejor',
    );
  });
});
