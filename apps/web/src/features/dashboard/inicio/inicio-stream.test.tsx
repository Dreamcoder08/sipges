import type { ProjectSettings } from '@sipges/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { ProjectSettingsProvider } from '../../../shared/lib/project-settings.tsx';
import { resetApi, server } from '../../../test/server.ts';
import { InicioPage } from './InicioPage.tsx';
import { loadConversationView } from './answer-view.tsx';
import { AnalystThreadProvider } from './thread-context.tsx';

/* Inicio asks through the stream and shows each step as the pending turn's progress (T21). */

const LOG = { name: 'Conversación con el analista' };
const STREAM = '/system/analyst/ask/stream';
const encoder = new TextEncoder();

/** The open stream of the last question: the test sends its events. */
let stream: { send: (event: string, data: unknown) => void; end: () => void } | undefined;
let asked: string[] = [];

// The answer view is a lazy chunk (T20); load it once here so no single test pays for the import
// under CI load (inicio-lazy.test.tsx covers the loading itself).
beforeAll(async () => {
  await loadConversationView();
});

beforeEach(() => {
  resetApi({ me: { username: 'demo', full_name: 'Persona Demo', role: 'consulta' } });
  stream = undefined;
  asked = [];
  server.use(
    http.get('/system/analyst', () => HttpResponse.json({ available: true })),
    http.post(STREAM, () => {
      asked.push('stream');
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          stream = {
            send: (event, data) => {
              try {
                controller.enqueue(
                  encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
                );
              } catch {
                // The page let go of the stream.
              }
            },
            end: () => controller.close(),
          };
          controller.enqueue(encoder.encode(': ping\n\n'));
        },
      });
      return new HttpResponse(body, { headers: { 'content-type': 'text/event-stream' } });
    }),
    http.post('/system/analyst/ask', () => {
      asked.push('ask');
      return HttpResponse.json({ answer: 'Respuesta sin pasos.', sources: [] });
    }),
  );
});

const renderInicio = (onAsk = vi.fn()) => {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ProjectSettingsProvider
        value={
          {
            external_ai: { enabled: true },
            level_meanings: { Verde: 'E', Amarillo: 'A', Naranja: 'I', Rojo: 'C' },
          } as ProjectSettings
        }
      >
        <AnalystThreadProvider scope="DEMO/PRJ-DEMO">
          <InicioPage
            scope="DEMO/PRJ-DEMO"
            projectId="PRJ-DEMO"
            projectLabel="Proyecto Demo"
            fullName="Persona Demo"
            onAsk={onAsk}
          />
        </AnalystThreadProvider>
      </ProjectSettingsProvider>
    </QueryClientProvider>,
  );
  return onAsk;
};

/** Sends a question and waits for its stream to open. */
const send = async (text: string) => {
  await screen.findByRole('textbox', { name: 'Preguntar, con citas' });
  fireEvent.change(screen.getByRole('textbox'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Enviar pregunta' }));
  const log = await screen.findByRole('log', LOG);
  await waitFor(() => expect(stream).toBeDefined());
  return log;
};

const finish = (body: unknown) =>
  act(() => {
    stream?.send('answer', body);
    stream?.send('done', {});
    stream?.end();
  });

it('shows the latest step label as the pending turn’s progress, as text only', async () => {
  renderInicio();
  const log = await send('¿Qué pasó en la vía?');
  expect(within(log).getByText('Buscando registros…')).toBeVisible();
  act(() => stream?.send('step', { label: 'Leyendo la línea de tiempo…' }));
  expect(await within(log).findByText('Leyendo la línea de tiempo…')).toBeVisible();
  expect(within(log).queryByText('Buscando registros…')).toBeNull();
  act(() => stream?.send('step', { label: '<b>Leyendo</b> actores…' }));
  expect(await within(log).findByText('<b>Leyendo</b> actores…')).toBeVisible();
  expect(log.querySelector('b')).toBeNull();
  expect(log).toHaveAttribute('aria-busy', 'true');
  finish({
    answer: 'Hubo un corte [1].',
    sources: [{ n: 1, module: 'eventos', id: 'EV-1', title: 'Corte' }],
  });
  expect(await within(log).findByRole('link', { name: 'Fuente 1: Corte' })).toBeTruthy();
  expect(within(log).queryByText('<b>Leyendo</b> actores…')).toBeNull();
  expect(asked).toEqual(['stream']);
});

it('announces the start and the end once each, never a step', async () => {
  renderInicio();
  await screen.findByRole('textbox', { name: 'Preguntar, con citas' });
  // The page's own region, after the composer's (which says how many characters are left).
  const region = screen
    .getAllByRole('status')
    .filter((each) => each.className === 'visually-hidden')
    .at(-1);
  const said: string[] = [];
  const observer = new MutationObserver(() => said.push(region?.textContent ?? ''));
  if (region) observer.observe(region, { childList: true, characterData: true, subtree: true });
  const log = await send('¿Qué pasó?');
  act(() => stream?.send('step', { label: 'Buscando registros…' }));
  act(() => stream?.send('step', { label: 'Leyendo la línea de tiempo…' }));
  await within(log).findByText('Leyendo la línea de tiempo…');
  finish({ answer: 'Sin novedades.', sources: [] });
  await waitFor(() => expect(log).toHaveAttribute('aria-busy', 'false'));
  observer.disconnect();
  expect(said.filter(Boolean)).toEqual([
    'El analista está buscando registros.',
    'Respuesta del analista lista.',
  ]);
});

it('maps an error event to the same turn as /ask, keeping «Buscar en registros» on 409', async () => {
  const onAsk = renderInicio();
  const log = await send('bloqueo norte');
  const off = 'La IA externa está desactivada en este proyecto.';
  act(() => {
    stream?.send('error', { status: 409, detail: off });
    stream?.send('done', {});
    stream?.end();
  });
  expect(await within(log).findByText(off)).toBeVisible();
  fireEvent.click(within(log).getByRole('button', { name: 'Buscar «bloqueo norte» en registros' }));
  expect(onAsk).toHaveBeenCalledWith('bloqueo norte');
});

it('shows an error turn when the stream ends without an answer', async () => {
  renderInicio();
  const log = await send('¿Qué pasó?');
  act(() => {
    stream?.send('step', { label: 'Buscando registros…' });
    stream?.end();
  });
  expect(
    await within(log).findByText('El analista no llegó a una respuesta; vuelve a preguntar'),
  ).toBeVisible();
  expect(within(log).getByRole('button', { name: 'Volver a preguntar' })).toBeTruthy();
  expect(
    within(log).queryByRole('button', { name: 'Buscar «¿Qué pasó?» en registros' }),
  ).toBeNull();
});

it('stops the stream from «Detener respuesta»: a later step or answer never shows', async () => {
  renderInicio();
  const log = await send('bloqueo norte');
  act(() => stream?.send('step', { label: 'Leyendo actores…' }));
  await within(log).findByText('Leyendo actores…');
  fireEvent.click(screen.getByRole('button', { name: 'Detener respuesta' }));
  expect(await within(log).findByText('Detenido')).toBeVisible();
  act(() => stream?.send('step', { label: 'Leyendo la línea de tiempo…' }));
  finish({ answer: 'Tarde.', sources: [] });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(within(log).queryByText('Leyendo la línea de tiempo…')).toBeNull();
  expect(within(log).queryByText('Tarde.')).toBeNull();
});

it('asks /ask when the server has no stream route', async () => {
  server.use(
    http.post(STREAM, () => {
      asked.push('stream');
      return HttpResponse.json({ detail: 'Not Found' }, { status: 404 });
    }),
  );
  renderInicio();
  await screen.findByRole('textbox', { name: 'Preguntar, con citas' });
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '¿Qué pasó?' } });
  fireEvent.click(screen.getByRole('button', { name: 'Enviar pregunta' }));
  const log = await screen.findByRole('log', LOG);
  expect(await within(log).findByText('Respuesta sin pasos.')).toBeVisible();
  expect(asked).toEqual(['stream', 'ask']);
});
