import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, expect, it, vi } from 'vitest';
import { server } from '../../../test/server.ts';
import { AlertOverview } from './AlertOverview.tsx';

afterEach(() => vi.useRealTimers());

it('ends the period in the Lima month on the evening of its last day', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // 23:30 in Lima on 30 November is already 1 December in UTC.
  vi.setSystemTime(new Date('2026-11-30T23:30:00-05:00'));
  server.use(
    http.get('/api/alertas', () =>
      HttpResponse.json([
        { _id: 'AL-1', Fecha: '2026-11-30', Nivel_Preliminar: 'Rojo', Estado: 'Abierta' },
        { _id: 'AL-2', Fecha: '2026-06-15', Nivel_Preliminar: 'Naranja', Estado: 'Abierta' },
      ]),
    ),
  );
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AlertOverview scope="DEMO/PRJ-DEMO" onShowList={() => {}} />
    </QueryClientProvider>,
  );
  // Six months ending in November: June to November, both alerts inside.
  const total = await screen.findByText('Total de alertas');
  expect(total.nextElementSibling).toHaveTextContent('2');
  expect(screen.getByText(/1 en nov frente a 0 en oct/)).toBeInTheDocument();
});
