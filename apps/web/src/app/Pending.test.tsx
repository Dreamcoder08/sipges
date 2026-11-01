import { render, screen, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { installRecordsApi } from '../test/records-api.ts';
import { resetApi, server } from '../test/server.ts';
import { App } from './App.tsx';

beforeEach(() =>
  resetApi({ me: { username: 'demo', full_name: 'Persona de prueba', role: 'admin' } }),
);

describe('Bandeja › Pendientes', () => {
  it('is the first tab of Bandeja and includes the data-quality review of the records screens', async () => {
    installRecordsApi({
      'DEMO/PRJ-DEMO/actores': [{ _id: 'AC-1', 'Nombre_Actor/Organizacion': 'Actor sintético' }],
    });
    server.use(
      http.get('*/system/intelligence/territorial-alerts', () => HttpResponse.json([])),
      http.get('*/system/validation-template', () =>
        HttpResponse.json({ status: 'PENDIENTE', rows: [] }),
      ),
      http.get('*/system/v4/situations', () =>
        HttpResponse.json({
          generated_at: '2026-10-21T00:00:00Z',
          today: '2026-10-21',
          window_days: 90,
          considered: 0,
          undated: 0,
          situations: [],
          narratives: { total: 0, recent: 0, topics: [], platforms: [], tone: null },
          method: 'Reglas',
          limitations: [],
        }),
      ),
    );
    window.history.replaceState(null, '', '/bandeja');
    render(<App />);
    const tabs = await screen.findByRole('group', { name: 'Bandeja' });
    expect(within(tabs).getByRole('button', { name: 'Pendientes', pressed: true })).toBeVisible();
    const item = await screen.findByRole('option', { name: /AC-1/ });
    expect(item).toHaveTextContent('Calidad');
  });
});
