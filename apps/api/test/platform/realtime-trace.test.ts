import { describe, expect, it } from 'vitest';
import {
  outboundTraceHeaders,
  parseTraceparent,
  startTrace,
} from '../../src/platform/observability/trace.ts';
import { runWithRequestContext } from '../../src/platform/request-context.ts';
import { createTestApp } from '../support/test-app.ts';

/** Reads SSE frames from a streaming response until `done` says enough. */
const readEvents = async (
  res: Response,
  done: (events: { event: string; data: string; id: string }[]) => boolean,
) => {
  if (!res.body) throw new Error('No stream body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events: { event: string; data: string; id: string }[] = [];
  let buffer = '';
  while (!done(events)) {
    const { value, done: ended } = await reader.read();
    if (ended) break;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const field = (name: string) =>
        frame
          .split('\n')
          .find((line) => line.startsWith(`${name}:`))
          ?.slice(name.length + 1)
          .trim() ?? '';
      if (field('event'))
        events.push({ event: field('event'), data: field('data'), id: field('id') });
    }
  }
  await reader.cancel();
  return events;
};

describe('live activity stream', () => {
  it('streams module and action of new activity, without record ids', async () => {
    const t = await createTestApp({}, { activity: { pollMs: 20, maxMs: 5_000 } });
    const admin = await t.login('admin', 'admin-password-123');
    const res = await t.request('/system/events', { headers: { cookie: admin.cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const events = readEvents(res, (seen) => seen.some((e) => e.event === 'activity'));
    await new Promise((resolve) => setTimeout(resolve, 60));
    await t.request('/api/demandas', {
      method: 'POST',
      headers: { cookie: admin.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ payload: { ID_Demanda: 'D-SECRETA', Demanda: 'Sintética' } }),
    });
    const seen = await events;
    expect(seen[0]?.event).toBe('ready');
    const activity = seen.find((e) => e.event === 'activity');
    expect(JSON.parse(activity?.data ?? '{}')).toEqual({ module: 'Demandas', action: 'CREATE' });
    expect(activity?.data).not.toContain('D-SECRETA');
    expect(Number(activity?.id)).toBeGreaterThan(Number(seen[0]?.id));
  });

  it('resumes after Last-Event-ID and needs a session', async () => {
    const t = await createTestApp({}, { activity: { pollMs: 20, maxMs: 5_000 } });
    expect((await t.request('/system/events')).status).toBe(401);
    const admin = await t.login('admin', 'admin-password-123');
    await t.request('/api/eventos', {
      method: 'POST',
      headers: { cookie: admin.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ payload: { ID_Evento: 'EV-1', Descripcion_Hecho: 'Sintético' } }),
    });
    const res = await t.request('/system/events', {
      headers: { cookie: admin.cookie, 'last-event-id': '0' },
    });
    // Activity written before the stream opened is replayed after the given id.
    const seen = await readEvents(res, (s) => s.some((e) => e.event === 'activity'));
    expect(seen.some((e) => e.event === 'activity')).toBe(true);
  });
});

describe('W3C trace context', () => {
  it('joins a valid caller trace and answers with its own span', async () => {
    const t = await createTestApp();
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const res = await t.request('/health', {
      headers: { traceparent: `00-${traceId}-00f067aa0ba902b7-01` },
    });
    expect(res.headers.get('traceresponse')).toMatch(new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`));
    const fresh = await t.request('/health', { headers: { traceparent: 'garbage' } });
    expect(fresh.headers.get('traceresponse')).not.toContain(traceId);
  });

  it('rejects malformed or zero ids and continues the trace on outbound calls', () => {
    expect(parseTraceparent(`00-${'0'.repeat(32)}-00f067aa0ba902b7-01`)).toBeNull();
    expect(parseTraceparent(`00-4bf92f3577b34da6a3ce929d0e0e4736-${'0'.repeat(16)}-01`)).toBeNull();
    expect(parseTraceparent('01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')).toBeNull();
    const trace = startTrace('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00');
    const header = runWithRequestContext(
      { requestId: 'req-12345678', trace, actor: null, clearance: 'full' },
      () => outboundTraceHeaders().traceparent,
    );
    expect(header).toMatch(/^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-00$/);
    expect(header.split('-')[2]).not.toBe(trace.spanId);
    expect(outboundTraceHeaders().traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });
});
