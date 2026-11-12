import { render, screen, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { IRSA_PENDING_LABEL } from '../shared/ui/IrsaPendingBadge.tsx';
import { installRecordsApi } from '../test/records-api.ts';
import { resetApi, server } from '../test/server.ts';
import { App } from './App.tsx';

beforeEach(() =>
  resetApi({ me: { username: 'demo', full_name: 'Persona de prueba', role: 'admin' } }),
);
const at = (path: string) => window.history.replaceState(null, '', path);
const scores = { G: 10, A: 20, D: 30, N: 0, E: 0, I: 0 };
/** Synthetic IRSA report that both the Dashboard summary and the full IRSA page accept. */
const report = {
  irsa: 42.25,
  level: 'Amarillo',
  scores,
  drivers: [],
  config_version: '0.4-indicators',
  weights: { G: 0.2, A: 0.2, D: 0.2, N: 0.1, E: 0.1, I: 0.2 },
  thresholds: { Verde: [0, 100] },
  details: { G: [], A: [], D: [], N: [], E: [], I: [] },
  availability: scores,
  indicators: [],
  status: 'PROVISIONAL',
  notes: [],
  coverage: { G: 1, A: 1, D: 1, N: 0, E: 0, I: 0 },
  insufficient_data: false,
};

/**
 * One source for the pending-methodology badge (odd/tasks/irsa-insufficient-data.md L3, L4): the
 * Dashboard and Análisis › IRSA read the same text, so it cannot drift between the two screens.
 */
describe('IRSA pending-methodology badge', () => {
  it(
    'reads the same shared text on the Dashboard and on Análisis › IRSA',
    { timeout: 20_000 },
    async () => {
      installRecordsApi();
      server.use(
        http.get('/system/irsa', () => HttpResponse.json(report)),
        http.get('/system/irsa/history', () => HttpResponse.json([])),
      );
      at('/');
      const dashboard = render(<App />);
      const badges = await screen.findAllByText(IRSA_PENDING_LABEL);
      expect(badges[0]).toBeVisible();
      dashboard.unmount();

      at('/analisis?vista=irsa');
      render(<App />);
      const card = (await screen.findByRole('heading', { name: 'IRSA actual' })).closest('section');
      expect(card).not.toBeNull();
      expect(await within(card as HTMLElement).findByText(IRSA_PENDING_LABEL)).toBeVisible();
      expect(IRSA_PENDING_LABEL).toBe('Metodología pendiente de validación');
    },
  );
});
