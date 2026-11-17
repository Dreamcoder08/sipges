import type { ProjectSettings } from '@sipges/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, delay, http } from 'msw';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { ProjectSettingsProvider } from '../../../shared/lib/project-settings.tsx';
import { resetApi, server } from '../../../test/server.ts';
import { InicioPage } from './InicioPage.tsx';
import { loadConversationView } from './answer-view.tsx';
import { AnalystThreadProvider } from './thread-context.tsx';

/*
 * What can be done with an answer (odd/tasks/chat-first-ui.md T6) and stopping one (T7): «Copiar»,
 * «Volver a preguntar», and «Detener», which aborts the real request.
 */

const LOG = { name: 'Conversación con el analista' };
const ASKED = 'Hubo un corte de la vía [1] y una **asamblea** [2].';
const SOURCES = [
  { n: 1, module: 'eventos', id: 'EV-1', title: 'Corte de vía' },
  { n: 2, module: 'actores', id: 'A-7', title: '' },
];

let asked: string[] = [];

// The answer view is a lazy chunk (T20); load it once here so no single test pays for the import
// under CI load (inicio-lazy.test.tsx covers the loading itself).
beforeAll(async () => {
  await loadConversationView();
});

beforeEach(() => {
  resetApi({ me: { username: 'demo', full_name: 'Persona Demo', role: 'consulta' } });
  asked = [];
  server.use(
    http.get('/system/analyst', () => HttpResponse.json({ available: true })),
    http.get('/system/intelligence/territorial-alerts', () => HttpResponse.json([])),
    http.get('/api/alertas', () => HttpResponse.json([])),
    http.post('/system/analyst/ask', async ({ request }) => {
      const body = (await request.json()) as { question: string };
      asked.push(body.question);
      return HttpResponse.json({ answer: ASKED, sources: SOURCES });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const renderInicio = () =>
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
            onAsk={vi.fn()}
          />
        </AnalystThreadProvider>
      </ProjectSettingsProvider>
    </QueryClientProvider>,
  );

const field = () => screen.findByRole('textbox', { name: 'Preguntar, con citas' });

/** The page's one status region (the analyst's start, end, stop and copy), not the composer's. */
const status = () =>
  screen
    .getAllByRole('status')
    .find((region) => region.className === 'visually-hidden' && !region.closest('form'));

const answered = async (user: ReturnType<typeof userEvent.setup>, question: string) => {
  await user.type(await field(), question);
  await user.keyboard('{Enter}');
  const log = await screen.findByRole('log', LOG);
  await waitFor(() => expect(log).toHaveAttribute('aria-busy', 'false'));
  await within(log).findByRole('region', { name: 'Respuesta del analista' });
  return log;
};

it('copies the answer and its numbered sources as plain text, and says «Copiado» once', async () => {
  const user = userEvent.setup();
  renderInicio();
  const log = await answered(user, '¿Qué pasó en la vía?');
  const actions = within(log).getByRole('group', { name: 'Acciones de la respuesta' });
  await user.click(within(actions).getByRole('button', { name: 'Copiar' }));
  await waitFor(() => expect(status()).toHaveTextContent('Copiado.'));
  expect(await navigator.clipboard.readText()).toBe(
    [
      'Hubo un corte de la vía [1] y una asamblea [2].',
      '',
      'Fuentes:',
      '[1] Corte de vía — /objeto/eventos/EV-1',
      '[2] A-7 — /objeto/actores/A-7',
    ].join('\n'),
  );
  // Seen beside the button, said by the page's status region only: the log holds no live region.
  expect(within(actions).getByText('Copiado')).toBeVisible();
  expect(within(log).queryByRole('status')).toBeNull();
  expect(within(log).queryByRole('alert')).toBeNull();
  // A second copy is announced again, not swallowed as a repeat.
  const first = status()?.textContent;
  await user.click(within(actions).getByRole('button', { name: 'Copiar' }));
  await waitFor(() => expect(status()?.textContent).not.toBe(first));
  expect(status()).toHaveTextContent('Copiado.');
});

it('says clearly when the browser refuses the clipboard', async () => {
  const user = userEvent.setup();
  renderInicio();
  const log = await answered(user, '¿Qué pasó en la vía?');
  vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(
    new DOMException('Write permission denied.', 'NotAllowedError'),
  );
  const actions = within(log).getByRole('group', { name: 'Acciones de la respuesta' });
  await user.click(within(actions).getByRole('button', { name: 'Copiar' }));
  const message = 'No se pudo copiar: el navegador no permitió usar el portapapeles.';
  await waitFor(() => expect(status()).toHaveTextContent(message));
  expect(within(actions).getByText(message)).toBeVisible();
  expect(within(actions).queryByText('Copiado')).toBeNull();
  // The button stays usable, so the person can try again.
  expect(within(actions).getByRole('button', { name: 'Copiar' })).toBeEnabled();
});

it('asks the same question again as a new turn from «Volver a preguntar»', async () => {
  const user = userEvent.setup();
  renderInicio();
  const log = await answered(user, '¿Qué pasó en la vía?');
  await user.click(within(log).getByRole('button', { name: 'Volver a preguntar' }));
  await waitFor(() => expect(within(log).getAllByRole('region')).toHaveLength(2));
  await waitFor(() => expect(log).toHaveAttribute('aria-busy', 'false'));
  expect(asked).toEqual(['¿Qué pasó en la vía?', '¿Qué pasó en la vía?']);
  const questions = within(log).getAllByRole('article', { name: 'Tu pregunta' });
  expect(questions.map((turn) => turn.textContent)).toEqual([
    '¿Qué pasó en la vía?',
    '¿Qué pasó en la vía?',
  ]);
});

it('keeps «Buscar en registros» as the fallback of a 409 or 503 answer, with no copy', async () => {
  const user = userEvent.setup();
  let calls = 0;
  server.use(
    http.post('/system/analyst/ask', () => {
      calls += 1;
      return HttpResponse.json(
        { detail: 'El servicio de IA no está disponible.' },
        { status: 503 },
      );
    }),
  );
  renderInicio();
  await user.type(await field(), 'bloqueo norte');
  await user.keyboard('{Enter}');
  const log = await screen.findByRole('log', LOG);
  expect(
    await within(log).findByRole('button', { name: 'Buscar «bloqueo norte» en registros' }),
  ).toBeVisible();
  expect(within(log).queryByRole('button', { name: 'Copiar' })).toBeNull();
  // As on the artboard, the failed turn can also be asked again.
  await user.click(within(log).getByRole('button', { name: 'Volver a preguntar' }));
  await waitFor(() => expect(calls).toBe(2));
  await waitFor(() =>
    expect(within(log).getAllByRole('article', { name: 'Tu pregunta' })).toHaveLength(2),
  );
});

/** The ask request waits forever, as a slow model would; fetch is watched for its signal. */
const hanging = () => {
  server.use(http.post('/system/analyst/ask', () => delay('infinite')));
  return vi.spyOn(globalThis, 'fetch');
};
const askSignal = (fetch: ReturnType<typeof hanging>) =>
  fetch.mock.calls.find(([url]) => String(url).includes('/system/analyst/ask'))?.[1]?.signal;

it('aborts the request from «Detener», shows «Detenido» and puts the question back', async () => {
  const user = userEvent.setup();
  const fetch = hanging();
  renderInicio();
  await user.type(await field(), '¿Qué pasó en la vía?');
  await user.keyboard('{Enter}');
  const log = await screen.findByRole('log', LOG);
  await within(log).findByText('Buscando registros…');
  const signal = askSignal(fetch);
  expect(signal?.aborted).toBe(false);
  await user.click(screen.getByRole('button', { name: 'Detener respuesta' }));
  expect(signal?.aborted).toBe(true);
  expect(within(log).getByText('Detenido')).toBeVisible();
  expect(log).toHaveAttribute('aria-busy', 'false');
  expect(await field()).toHaveValue('¿Qué pasó en la vía?');
  expect(status()).toHaveTextContent('Respuesta detenida.');
  // Stopping is not a failure: no error text, no alert.
  expect(within(log).queryByText(/no respondió|No se pudo/)).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
});

it('puts a retried question back in the empty composer when it is stopped', async () => {
  const user = userEvent.setup();
  renderInicio();
  const log = await answered(user, '¿Qué pasó en la vía?');
  expect(await field()).toHaveValue('');
  const fetch = hanging();
  await user.click(within(log).getByRole('button', { name: 'Volver a preguntar' }));
  await within(log).findByText('Buscando registros…');
  await user.click(screen.getByRole('button', { name: 'Detener respuesta' }));
  expect(askSignal(fetch)?.aborted).toBe(true);
  expect(await field()).toHaveValue('¿Qué pasó en la vía?');
});

it('stops with Esc while the answer is pending', async () => {
  const user = userEvent.setup();
  const fetch = hanging();
  renderInicio();
  await user.type(await field(), 'bloqueo');
  await user.keyboard('{Enter}');
  const log = await screen.findByRole('log', LOG);
  await within(log).findByText('Buscando registros…');
  await user.keyboard('{Escape}');
  expect(askSignal(fetch)?.aborted).toBe(true);
  expect(within(log).getByText('Detenido')).toBeVisible();
  expect(await field()).toHaveValue('bloqueo');
});

it('ignores an answer that arrives after «Detener», announcing only the stop', async () => {
  const user = userEvent.setup();
  // A server that answers anyway, whatever the signal says.
  let respond: (value: Response) => void = () => undefined;
  const real = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    String(input).includes('/system/analyst/ask')
      ? new Promise<Response>((resolve) => {
          respond = resolve;
        })
      : real(input, init),
  );
  renderInicio();
  await user.type(await field(), 'bloqueo');
  await user.keyboard('{Enter}');
  const log = await screen.findByRole('log', LOG);
  await within(log).findByText('Buscando registros…');
  const said: string[] = [];
  const region = status();
  const watcher = new MutationObserver(() => said.push(region?.textContent ?? ''));
  if (region) watcher.observe(region, { childList: true, characterData: true, subtree: true });
  await user.click(screen.getByRole('button', { name: 'Detener respuesta' }));
  await act(async () => {
    respond(Response.json({ answer: 'Tarde [1].', sources: SOURCES }));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  watcher.disconnect();
  expect(within(log).getByText('Detenido')).toBeVisible();
  expect(within(log).queryByText(/Tarde/)).toBeNull();
  expect(said.filter(Boolean)).toEqual(['Respuesta detenida.']);
});
