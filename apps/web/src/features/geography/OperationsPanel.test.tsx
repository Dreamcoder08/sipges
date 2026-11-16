import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, expect, it, vi } from 'vitest';
import { server } from '../../test/server.ts';
import { OperationsPanel } from './OperationsPanel.tsx';

afterEach(() => vi.useRealTimers());

// Synthetic records: one event originates an alert that two actions attend.
const node = (module: string, id: string, title: string, fields: Record<string, string>) => ({
  module,
  id,
  type_label: module,
  title,
  date: null,
  marking: 'interno',
  fields,
});
const edge = (id: number, link_type: string, source: string[], target: string[]) => ({
  id,
  link_type,
  source: { module: source[0], id: source[1] },
  target: { module: target[0], id: target[1] },
  inferred: false,
  via: null,
  note: '',
  created_by: 'admin',
  created_at: null,
});

it('marks overdue on the Lima calendar day, not the UTC one', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // 23:30 in Lima (UTC−5) is already the 14th in UTC.
  vi.setSystemTime(new Date('2026-11-13T23:30:00-05:00'));
  server.use(
    http.post('/system/graph/neighbourhood', () =>
      HttpResponse.json({
        seeds: [{ module: 'eventos', id: 'EV-1' }],
        nodes: [
          node('eventos', 'EV-1', 'Evento sintético', {}),
          node('alertas', 'AL-1', 'Alerta sintética', { Estado: 'Abierta' }),
          node('acciones', 'AC-1', 'Acción que vence hoy', {
            Estado: 'Pendiente',
            Fecha_Vencimiento: '2026-11-13',
          }),
          node('acciones', 'AC-2', 'Acción que venció ayer', {
            Estado: 'Pendiente',
            Fecha_Vencimiento: '2026-11-12',
          }),
        ],
        edges: [
          edge(1, 'origina', ['eventos', 'EV-1'], ['alertas', 'AL-1']),
          edge(2, 'atiende', ['acciones', 'AC-1'], ['alertas', 'AL-1']),
          edge(3, 'atiende', ['acciones', 'AC-2'], ['alertas', 'AL-1']),
        ],
        truncated: false,
      }),
    ),
  );
  render(
    <QueryClientProvider client={new QueryClient()}>
      <OperationsPanel
        scope="DEMO/PRJ-DEMO"
        seeds={[{ module: 'eventos', id: 'EV-1' }]}
        context="Territorio sintético"
        capped={false}
      />
    </QueryClientProvider>,
  );
  const alerts = within(await screen.findByRole('region', { name: 'Alertas y su sustento' }));
  const item = async (title: string) =>
    (await alerts.findByRole('link', { name: title })).closest('li');
  expect(await item('Acción que venció ayer')).toHaveTextContent('· vencida');
  expect(await item('Acción que vence hoy')).not.toHaveTextContent('vencida');
});
