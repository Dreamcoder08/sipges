import type { ProjectSettings } from '@sipges/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProjectSettingsProvider } from '../../../shared/lib/project-settings.tsx';
import { resetApi, server } from '../../../test/server.ts';
import { InicioPage } from './InicioPage.tsx';

/* The conversation thread, in memory for the session (odd/tasks/chat-first-ui.md T5, L5, L6). */

const LOG = { name: 'Conversación con el analista' };
const ATTENTION = /^Necesita tu atención/;

/** Answers wait for `release()`, so a test can look at the pending turn. */
let release: () => void = () => undefined;
let replies: Array<() => Response> = [];
const answer = (text: string, title: string) => () =>
  HttpResponse.json({
    answer: `${text} [1].`,
    sources: [{ n: 1, module: 'eventos', id: `EV-${title}`, title }],
  });

beforeEach(() => {
  resetApi({ me: { username: 'demo', full_name: 'Persona Demo', role: 'consulta' } });
  replies = [];
  server.use(
    http.get('/system/analyst', () => HttpResponse.json({ available: true })),
    http.get('/system/intelligence/territorial-alerts', () => HttpResponse.json([])),
    http.get('/api/alertas', () =>
      HttpResponse.json([
        { _id: 'AL-1', Estado: 'Abierta', Nivel: 'Rojo', Causa: 'Corte de vía' },
        { _id: 'AL-2', Estado: 'Abierta', Nivel: 'Naranja', Causa: 'Reclamo por polvo' },
      ]),
    ),
    http.post('/system/analyst/ask', async () => {
      const reply = replies.shift() ?? answer('Sin novedades', 'Nota');
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return reply();
    }),
  );
});

// jsdom has no scrolling; tests that follow the bottom install a spy and this puts it back.
const scrollIntoView = Element.prototype.scrollIntoView;

afterEach(() => {
  Element.prototype.scrollIntoView = scrollIntoView;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
        <InicioPage
          scope="DEMO/PRJ-DEMO"
          projectId="PRJ-DEMO"
          projectLabel="Proyecto Demo"
          fullName="Persona Demo"
          onAsk={onAsk}
        />
      </ProjectSettingsProvider>
    </QueryClientProvider>,
  );
  return onAsk;
};

const send = (text: string) => {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: /Enviar pregunta|Buscar en registros/ }));
};

/** Sends a question and lets its answer through. */
const exchange = async (text: string) => {
  send(text);
  const log = await screen.findByRole('log', LOG);
  await within(log).findByText('Buscando registros…');
  act(() => release());
  await waitFor(() => expect(log).toHaveAttribute('aria-busy', 'false'));
  return log;
};

const ready = () => screen.findByRole('textbox', { name: 'Preguntar, con citas' });

it('appends each question and its answer as turns, each answer with its own sources', async () => {
  renderInicio();
  await ready();
  replies = [answer('Hubo un corte', 'Corte'), answer('Sigue el reclamo', 'Reclamo')];
  await exchange('¿Qué pasó en la vía?');
  const log = await exchange('¿Y el polvo?');
  const turns = within(log).getAllByRole('article');
  expect(turns.map((turn) => turn.getAttribute('aria-label') ?? turn.textContent)).toEqual([
    'Tu pregunta',
    expect.stringContaining('Hubo un corte'),
    'Tu pregunta',
    expect.stringContaining('Sigue el reclamo'),
  ]);
  expect(turns[0]).toHaveTextContent('¿Qué pasó en la vía?');
  // jsdom puts a space between inline elements where browsers do not.
  expect(turns[1]).toHaveAccessibleName(/^IA Analista ?, respuesta a «¿Qué pasó en la vía\?»$/);
  // Each [1] links to the source listed in its own turn.
  for (const [turn, title] of [
    [turns[1], 'Corte'],
    [turns[3], 'Reclamo'],
  ] as const) {
    const cite = within(turn as HTMLElement).getByRole('link', { name: `Fuente 1: ${title}` });
    const target = document.getElementById(cite.getAttribute('href')?.slice(1) ?? '');
    expect(turn).toContainElement(target);
  }
});

it('marks the log busy and says «Buscando registros…» while the answer is pending', async () => {
  renderInicio();
  await ready();
  send('¿Qué pasó?');
  const log = await screen.findByRole('log', LOG);
  expect(log).toHaveAttribute('aria-busy', 'true');
  expect(within(log).getByText('Buscando registros…')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Detener respuesta' })).toBeTruthy();
  act(() => release());
  await waitFor(() => expect(log).toHaveAttribute('aria-busy', 'false'));
  expect(within(log).queryByText('Buscando registros…')).toBeNull();
});

it('announces the start and the end once each through one status region', async () => {
  renderInicio();
  await ready();
  const status = () =>
    screen.getAllByRole('status').find((region) => region.textContent?.includes('nalista'));
  send('¿Qué pasó?');
  await waitFor(() => expect(status()).toHaveTextContent('El analista está buscando registros.'));
  act(() => release());
  await waitFor(() => expect(status()).toHaveTextContent('Respuesta del analista lista.'));
  // The turns themselves announce nothing: the log is not repeated by live regions inside it.
  const log = screen.getByRole('log', LOG);
  expect(within(log).queryByRole('status')).toBeNull();
  expect(within(log).queryByRole('alert')).toBeNull();
});

it('shows a 503 as a turn without an alert role, and still offers the record search', async () => {
  const down = 'El analista no respondió: el servicio de IA no está disponible.';
  replies = [() => HttpResponse.json({ detail: down }, { status: 503 })];
  const onAsk = renderInicio();
  await ready();
  const log = await exchange('bloqueo norte');
  expect(within(log).getByText(down)).toBeVisible();
  expect(within(log).queryByRole('alert')).toBeNull();
  const status = screen.getAllByRole('status').map((region) => region.textContent);
  expect(status).toContain('El analista no respondió.');
  fireEvent.click(within(log).getByRole('button', { name: 'Buscar «bloqueo norte» en registros' }));
  expect(onAsk).toHaveBeenCalledWith('bloqueo norte');
});

/** Viewport observers (root: the page) get `isIntersecting` for what they watch. */
const fakeObservers = () => {
  const watchers: { callback: IntersectionObserverCallback; root: unknown; targets: Element[] }[] =
    [];
  class FakeObserver {
    readonly entry: (typeof watchers)[number];
    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      this.entry = { callback, root: options?.root ?? null, targets: [] };
      watchers.push(this.entry);
    }
    observe(target: Element) {
      this.entry.targets.push(target);
    }
    unobserve() {}
    disconnect() {
      this.entry.targets = [];
    }
    takeRecords() {
      return [];
    }
  }
  vi.stubGlobal('IntersectionObserver', FakeObserver);
  // With an observer, the chips' scroll hints ask CSS first; jsdom has no CSS.supports.
  vi.stubGlobal('CSS', { supports: () => false });
  return (isIntersecting: boolean) =>
    act(() => {
      for (const watcher of watchers.filter((w) => w.root === null)) {
        watcher.callback(
          watcher.targets.map(
            (target) => ({ target, isIntersecting }) as IntersectionObserverEntry,
          ),
          {} as IntersectionObserver,
        );
      }
    });
};

it('follows the bottom only while the person is there, and offers «Ir al final» otherwise', async () => {
  const atBottom = fakeObservers();
  const scroll = vi.fn();
  Element.prototype.scrollIntoView = scroll;
  renderInicio();
  await ready();
  atBottom(true);
  await exchange('primera');
  expect(scroll).toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Ir al final' })).toBeNull();

  send('segunda');
  await within(screen.getByRole('log', LOG)).findByText('Buscando registros…');
  atBottom(false);
  scroll.mockClear();
  act(() => release());
  await waitFor(() => expect(screen.getByRole('log', LOG)).toHaveAttribute('aria-busy', 'false'));
  expect(scroll).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Ir al final' }));
  expect(scroll).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'smooth' }));
});

it('jumps to the end without smooth scrolling when the person prefers reduced motion', async () => {
  const atBottom = fakeObservers();
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('reduced-motion'),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  const scroll = vi.fn();
  Element.prototype.scrollIntoView = scroll;
  renderInicio();
  await ready();
  await exchange('primera');
  atBottom(false);
  fireEvent.click(await screen.findByRole('button', { name: 'Ir al final' }));
  expect(scroll).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: 'auto' }));
});

it('folds what needs attention and the week into one line once a conversation starts', async () => {
  renderInicio();
  await ready();
  expect(await screen.findByRole('region', { name: ATTENTION })).toBeVisible();
  expect(screen.queryByRole('button', { name: ATTENTION })).toBeNull();
  await exchange('¿Qué pasó?');
  const fold = screen.getByRole('button', { name: ATTENTION });
  expect(fold).toHaveTextContent('Necesita tu atención 2 · Corte de vía y 1 más');
  expect(fold).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('region', { name: ATTENTION })).toBeNull();
  fireEvent.click(fold);
  expect(fold).toHaveAttribute('aria-expanded', 'true');
  const list = screen.getByRole('region', { name: ATTENTION });
  expect(within(list).getByText('Corte de vía')).toBeVisible();
  // The fold line comes before the thread.
  expect(fold.compareDocumentPosition(screen.getByRole('log', LOG))).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
  const week = screen.getByRole('button', { name: 'Esta semana' });
  expect(week).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('region', { name: /Esta semana/ })).toBeNull();
  fireEvent.click(week);
  expect(week).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByRole('region', { name: /Esta semana/ })).toBeVisible();
});

it('starts over from «Nueva conversación», back to the empty state', async () => {
  renderInicio();
  await ready();
  await exchange('¿Qué pasó?');
  fireEvent.click(screen.getByRole('button', { name: 'Nueva conversación' }));
  expect(screen.queryByRole('log', LOG)).toBeNull();
  expect(screen.getByRole('region', { name: ATTENTION })).toBeVisible();
  expect(screen.getByRole('list', { name: 'Prueba con' })).toBeVisible();
  expect(screen.getByRole('textbox', { name: 'Preguntar, con citas' })).toHaveFocus();
});

it('starts over with Ctrl+Mayús+O and ⌘+Mayús+O, but not while an input method composes', async () => {
  renderInicio();
  await ready();
  await exchange('¿Qué pasó?');
  fireEvent.keyDown(document.body, { key: 'O', ctrlKey: true, shiftKey: true, isComposing: true });
  expect(screen.getByRole('log', LOG)).toBeTruthy();
  fireEvent.keyDown(document.body, { key: 'O', ctrlKey: true, shiftKey: true });
  expect(screen.queryByRole('log', LOG)).toBeNull();
  await exchange('¿Y ahora?');
  fireEvent.keyDown(document.body, { key: 'o', metaKey: true, shiftKey: true });
  expect(screen.queryByRole('log', LOG)).toBeNull();
});

it('keeps the questions out of browser storage', async () => {
  const writes = vi.spyOn(Storage.prototype, 'setItem');
  renderInicio();
  await ready();
  await exchange('pregunta privada');
  expect(writes.mock.calls.flat().join(' ')).not.toContain('pregunta privada');
  expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain('pregunta privada');
});

it('searches from «Buscar» without adding a turn', async () => {
  const onAsk = renderInicio();
  await ready();
  fireEvent.click(screen.getByRole('radio', { name: 'Buscar' }));
  send('bloqueo');
  expect(onAsk).toHaveBeenCalledWith('bloqueo');
  expect(screen.queryByRole('log', LOG)).toBeNull();
});
