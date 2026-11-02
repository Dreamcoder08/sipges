import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConflictRiskResponse } from '@sipges/contracts';
import { server } from '../../test/server.ts';
import type { FeatureContext } from '../../shared/api/feature-context.ts';
import { ConflictRiskPage } from './index.ts';

// Synthetic localities, actors and records only.
const context: FeatureContext = {
  scope: 'SIPGES/PRJ-SECHURA',
  projectId: 'PRJ-SECHURA',
  projectLabel: 'Sechura',
  role: 'consulta',
  username: 'ana',
  fullName: 'Ana',
};

const bins = [
  { range: '0–15 %', n: 0, predicted: null, observed: null },
  { range: '15–40 %', n: 0, predicted: null, observed: null },
  { range: '40–100 %', n: 0, predicted: null, observed: null },
];
const thin = (horizon: 30 | 90) => ({
  horizon,
  calibrated: false,
  reason: 'Historial insuficiente para calibrar: 4 muestras y 1 escalamientos en 3 cortes.',
  cutoffs: 3,
  from: '2026-05-01',
  to: '2026-07-01',
  train: { samples: 3, events: 1 },
  test: { samples: 1, events: 0 },
  brier: null,
  brierReference: null,
  skill: null,
  bins,
});
const unit = (name: string, kind: 'locality' | 'actor', score: number, band: 'alta' | 'baja') => ({
  key: `${kind === 'locality' ? 'L' : 'A'}:${name.toLowerCase()}`,
  kind,
  name,
  score,
  signals: 3,
  horizons: { '30': { probability: null, band }, '90': { probability: null, band } },
  confidence: 'baja' as const,
  confidenceReason: 'Historial insuficiente para calibrar.',
  factors: [
    {
      id: 'alerts',
      label: 'Alertas (últimos 90 días, por nivel)',
      count: 2,
      value: 1.1,
      contribution: 0.99,
      records: [{ module: 'Alertas', id: 'AL-7', title: 'Bloqueo de vía', date: '2026-10-30' }],
    },
    {
      id: 'alerts_t',
      label: 'Alertas territoriales',
      count: 1,
      value: 0.7,
      contribution: 0.6,
      records: [
        {
          module: 'Alertas_Territoriales',
          id: 'ta1',
          title: 'Alerta territorial Alta',
          date: '2026-10-29',
        },
      ],
    },
  ],
});
const thinReport: ConflictRiskResponse = {
  generatedOn: '2026-11-02',
  status: 'ok',
  method: 'Puntaje transparente de factores con pesos fijos.',
  backtest: { '30': thin(30), '90': thin(90) },
  localities: [
    unit('Pampa Alta', 'locality', 3.1, 'alta'),
    unit('Loma Verde', 'locality', 0.4, 'baja'),
  ],
  actors: [unit('Comité de Riego Norte', 'actor', 1.2, 'baja')],
  limitations: ['Es una ayuda para priorizar, no un pronóstico de hechos.'],
};

const respond = (body: ConflictRiskResponse) =>
  server.use(http.get('*/system/conflict-risk', () => HttpResponse.json(body)));

const mount = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ConflictRiskPage {...context} />
    </QueryClientProvider>,
  );

afterEach(() => window.history.replaceState(null, '', '/'));

describe('ConflictRiskPage', () => {
  it('ranks localities with band, confidence, factors linked to their records and the back-test', async () => {
    respond(thinReport);
    mount();
    const items = await screen.findAllByRole('article');
    expect(items.map((i) => within(i).getByRole('heading', { level: 4 }).textContent)).toEqual([
      'Pampa Alta',
      'Loma Verde',
    ]);
    const top = items[0];
    if (!top) throw new Error('missing item');
    expect(within(top).getByText('Riesgo alto')).toBeInTheDocument();
    expect(within(top).getByText(/sin porcentaje/i)).toBeInTheDocument();
    expect(within(top).getByText(/Confianza baja/)).toBeInTheDocument();
    expect(within(top).getByRole('link', { name: /Bloqueo de vía/ })).toHaveAttribute(
      'href',
      '/objeto/alertas/AL-7',
    );
    expect(within(top).getByRole('link', { name: /Alerta territorial Alta/ })).toHaveAttribute(
      'href',
      '/bandeja?vista=alertas',
    );
    expect(
      screen.getByText(/Historial insuficiente para calibrar: 4 muestras/),
    ).toBeInTheDocument();
  });

  it('switches to actors and to the 30-day horizon', async () => {
    respond(thinReport);
    mount();
    await screen.findAllByRole('article');
    await userEvent.click(screen.getByRole('button', { name: 'Actores' }));
    expect(screen.getByRole('heading', { name: 'Comité de Riego Norte' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '30 días' }));
    expect(screen.getByRole('button', { name: '30 días' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows the band, percentage and back-test of the chosen horizon', async () => {
    const top = unit('Pampa Alta', 'locality', 3.1, 'alta');
    respond({
      ...thinReport,
      backtest: { '30': thin(30), '90': { ...thin(90), reason: 'Razón propia de 90 días.' } },
      localities: [
        {
          ...top,
          horizons: {
            '30': { probability: 0.1, band: 'baja' },
            '90': { probability: 0.45, band: 'alta' },
          },
        },
      ],
    });
    mount();
    const card = await screen.findByRole('article');
    expect(within(card).getByText('Riesgo alto')).toBeInTheDocument();
    expect(within(card).getByText('45 %')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Último back-test a 90 días' })).toBeInTheDocument();
    expect(screen.getByText('Razón propia de 90 días.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '30 días' }));
    expect(within(card).getByText('Riesgo bajo')).toBeInTheDocument();
    expect(within(card).getByText('10 %')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Último back-test a 30 días' })).toBeInTheDocument();
    expect(screen.queryByText('Razón propia de 90 días.')).toBeNull();
  });

  it('shows the probability and the calibration when the history supports it', async () => {
    const calibrated = {
      ...thin(90),
      calibrated: true,
      reason: null,
      train: { samples: 120, events: 30 },
      test: { samples: 50, events: 12 },
      brier: 0.12,
      brierReference: 0.18,
      skill: 0.333,
      bins: [
        { range: '0–15 %', n: 20, predicted: 0.08, observed: 0.05 },
        { range: '15–40 %', n: 18, predicted: 0.25, observed: 0.22 },
        { range: '40–100 %', n: 12, predicted: 0.6, observed: 0.58 },
      ],
    };
    const top = unit('Pampa Alta', 'locality', 3.1, 'alta');
    respond({
      ...thinReport,
      backtest: { '30': thin(30), '90': calibrated },
      localities: [
        {
          ...top,
          horizons: {
            '30': { probability: null, band: 'alta' },
            '90': { probability: 0.45, band: 'alta' },
          },
          confidence: 'alta',
        },
      ],
    });
    mount();
    expect(await screen.findByText('45 %')).toBeInTheDocument();
    expect(screen.getByText(/Brier 0.12/)).toBeInTheDocument();
    expect(screen.getByText(/170 muestras/)).toBeInTheDocument();
  });

  it('says «Sin datos suficientes» instead of an empty ranking', async () => {
    respond({ ...thinReport, status: 'sin datos suficientes', localities: [], actors: [] });
    mount();
    expect(await screen.findByText('Sin datos suficientes')).toBeInTheDocument();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
  });

  it('focuses the locality named in the link from the territorial map', async () => {
    window.history.replaceState(null, '', '/analisis?vista=riesgo&localidad=Loma%20Verde');
    respond(thinReport);
    mount();
    const items = await screen.findAllByRole('article');
    expect(items).toHaveLength(1);
    expect(within(items[0] as HTMLElement).getByRole('heading', { level: 4 }).textContent).toBe(
      'Loma Verde',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Ver todas' }));
    expect(screen.getAllByRole('article')).toHaveLength(2);
  });
});
