import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { expect, it } from 'vitest';
import { server } from '../../test/server.ts';
import { TimelinePage } from './TimelinePage.tsx';

const context = {
  scope: 'DEMO/PRJ-DEMO',
  projectId: 'PRJ-DEMO',
  projectLabel: 'Demo',
  role: 'consulta' as const,
  username: 'reader',
  fullName: 'Reader',
};

// functional-10 T16 (ego-browser walk): the chronology printed «2026-11-14» beside each entry.
it('shows each entry day as a Spanish date and keeps the stored day for machines', async () => {
  server.use(
    http.get('*/system/timeline', () =>
      HttpResponse.json({
        from: '',
        to: '',
        truncated: false,
        entries: [
          {
            module: 'alertas',
            id: 'AL-1',
            type_label: 'Alerta',
            title: 'Alerta sintética',
            date: '2026-11-14',
            marking: 'interno',
            fields: {},
          },
        ],
      }),
    ),
  );
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <TimelinePage {...context} />
    </QueryClientProvider>,
  );
  const day = await screen.findByText('14 nov. 2026');
  expect(day.tagName).toBe('TIME');
  expect(day).toHaveAttribute('datetime', '2026-11-14');
  expect(screen.queryByText('2026-11-14')).toBeNull();
});
