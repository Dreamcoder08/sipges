import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { expect, it } from 'vitest';
import { server } from '../../test/server.ts';
import { RuntimeCard } from './RuntimeCard.tsx';

// functional-10 T16 (ego-browser walk): Automatizaciones printed «2026-11-16T03:43:46».
it('shows the last attempt in Lima time', async () => {
  server.use(
    http.get('*/system/automations/runtime', () =>
      HttpResponse.json({
        event_processing: true,
        cron_configured: false,
        cron_schedule: null,
        interval_ms: 60000,
        latest_attempt: {
          started_at: '2026-11-16T03:43:46Z',
          finished_at: null,
          error: '',
          report: null,
          source: 'event',
          status: 'completed',
        },
      }),
    ),
  );
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <RuntimeCard scope="DEMO/PRJ-DEMO" />
    </QueryClientProvider>,
  );
  const at = await screen.findByText('15 nov. 2026, 22:43');
  expect(at).toHaveAttribute('datetime', '2026-11-16T03:43:46Z');
  expect(screen.getByText(/Último intento:/)).not.toHaveTextContent('2026-11-16');
});
