import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { server } from '../../test/server.ts';
import { LiveUpdates, parseFrames } from './LiveUpdates.tsx';

it('parses complete frames and keeps the unfinished rest', () => {
  expect(
    parseFrames(
      'event: ready\nid: 4\ndata: {}\n\nevent: activity\r\nid: 5\r\ndata: {}\r\n\r\nevent: act',
    ),
  ).toEqual({
    frames: [
      { event: 'ready', id: '4' },
      { event: 'activity', id: '5' },
    ],
    rest: 'event: act',
  });
  expect(parseFrames(': ping\n\n')).toEqual({ frames: [], rest: '' });
});

const Counter = ({ scope }: { scope: string }) => {
  const query = useQuery({
    queryKey: ['records', scope, 'list'],
    queryFn: async () => (Number(sessionStorage.getItem('loads') ?? 0) + 1).toString(),
  });
  if (query.data) sessionStorage.setItem('loads', query.data);
  return <p>Cargas: {query.data}</p>;
};

it('refreshes the project queries when activity arrives, sending the project header', async () => {
  sessionStorage.clear();
  let scopeHeader: string | null = null;
  server.use(
    http.get('/system/events', ({ request }) => {
      scopeHeader = request.headers.get('X-MASCLI-Scope');
      return new HttpResponse(
        'event: ready\nid: 7\ndata: {}\n\nevent: activity\nid: 8\ndata: {"module":"Demandas","action":"CREATE"}\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }),
  );
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Counter scope="ACME/P1" />
      <LiveUpdates scope="ACME/P1" />
    </QueryClientProvider>,
  );
  expect(await screen.findByText('Cargas: 1')).toBeInTheDocument();
  expect(await screen.findByText('Cargas: 2', {}, { timeout: 3000 })).toBeInTheDocument();
  expect(scopeHeader).toBe('ACME/P1');
});
