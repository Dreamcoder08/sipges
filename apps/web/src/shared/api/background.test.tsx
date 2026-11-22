import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { render, renderHook, screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runtimeQuery } from '../../features/automation/api.ts';
import { LiveUpdates } from '../../features/live/LiveUpdates.tsx';
import { useUnreadNotifications } from '../../features/notifications/AvisosPanel.tsx';
import { resetApi, server } from '../../test/server.ts';
import {
  BACKGROUND_HEADER,
  SESSION_REMAINING_HEADER,
  onSessionRemaining,
  request,
  runInBackground,
} from './client.ts';

/** Every request's path and its background header, in arrival order. */
const seen: { path: string; background: string | null }[] = [];
const record = ({ request: req }: { request: Request }) => {
  seen.push({ path: new URL(req.url).pathname, background: req.headers.get(BACKGROUND_HEADER) });
};
const headerOf = (path: string) => seen.filter((s) => s.path === path).map((s) => s.background);

beforeEach(() => {
  resetApi({ me: { username: 'persona', full_name: 'Persona Sintética', role: 'admin' } });
  seen.length = 0;
  server.events.on('request:start', record);
});
afterEach(() => server.events.removeListener('request:start', record));

const wrapper = (client: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };

describe('background requests (world-class-local T8f)', () => {
  it('marks a request as background only when asked', async () => {
    server.use(http.get('/echo', () => HttpResponse.json({ ok: true })));
    await request('/echo');
    await request('/echo', { background: true });
    await runInBackground(() => request('/echo'));
    expect(headerOf('/echo')).toEqual([null, '1', '1']);
  });

  it('reports the session time the server tells, background answers included', async () => {
    const answer = (remaining: string | null) => () =>
      HttpResponse.json(
        { ok: true },
        remaining === null ? {} : { headers: { [SESSION_REMAINING_HEADER]: remaining } },
      );
    server.use(
      http.get('/told', answer('3300')),
      http.get('/told-later', answer('3600')),
      http.get('/silent', answer(null)),
      http.get('/garbled', answer('soon')),
      http.get('/gone', () => HttpResponse.json({ detail: 'x' }, { status: 401 })),
    );
    const told: number[] = [];
    const off = onSessionRemaining((seconds) => told.push(seconds));
    await request('/told');
    await request('/told-later', { background: true });
    await request('/silent');
    await request('/garbled');
    await request('/system/auth/me');
    await expect(request('/gone')).rejects.toMatchObject({ status: 401 });
    off();
    await request('/told');
    expect(told).toEqual([3300, 3600]);
  });

  it('polls the inbox and the automation runtime as background requests', async () => {
    server.use(
      http.get('/system/automations/runtime', () =>
        HttpResponse.json({ status: 'idle', last_tick_at: null, last_report: null }),
      ),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useUnreadNotifications('DEMO/PRJ-DEMO'), { wrapper: wrapper(client) });
    renderHook(() => useQuery(runtimeQuery('DEMO/PRJ-DEMO')), { wrapper: wrapper(client) });
    await waitFor(() => expect(headerOf('/system/notifications')).toEqual(['1']));
    await waitFor(() => expect(headerOf('/system/automations/runtime')).toEqual(['1']));
  });

  it('opens the live stream and refreshes after its activity as background requests', async () => {
    server.use(
      http.get(
        '/system/events',
        () =>
          new HttpResponse('event: activity\nid: 8\ndata: {}\n\n', {
            headers: { 'content-type': 'text/event-stream' },
          }),
      ),
      http.get('/records-probe', () => HttpResponse.json({ ok: true })),
    );
    const Probe = () => {
      const query = useQuery({
        queryKey: ['records', 'ACME/P1'],
        queryFn: async () => (await request('/records-probe')).json() as Promise<unknown>,
      });
      return <p>{query.isSuccess ? 'Listo' : 'Cargando'}</p>;
    };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Probe />
        <LiveUpdates scope="ACME/P1" />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Listo')).toBeInTheDocument();
    // The first load is the user's; the refetches the stream triggers are not.
    await waitFor(() => expect(headerOf('/records-probe').length).toBeGreaterThan(1), {
      timeout: 3000,
    });
    const [first, ...refetches] = headerOf('/records-probe');
    expect(first).toBeNull();
    expect(new Set(refetches)).toEqual(new Set(['1']));
    expect(new Set(headerOf('/system/events'))).toEqual(new Set(['1']));
  });
});
