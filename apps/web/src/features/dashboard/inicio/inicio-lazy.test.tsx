import type { ProjectSettings } from '@sipges/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { beforeEach, expect, it, vi } from 'vitest';
import { ProjectSettingsProvider } from '../../../shared/lib/project-settings.tsx';
import { resetApi, server } from '../../../test/server.ts';
import type * as AnswerViewModule from './answer-view.tsx';
import { InicioPage } from './InicioPage.tsx';

/*
 * The answer view (AnalystAnswer, its text, blocks and actions) is a chunk of its own, loaded for
 * the first question and fetched ahead when the person starts to write (chat-first-ui T20).
 */

const spies = vi.hoisted(() => ({ evaluated: vi.fn(), preload: vi.fn() }));

// Runs when the chunk's module is first evaluated, which a static import would do at load time.
vi.mock('./TurnResult.tsx', async (importOriginal) => {
  spies.evaluated();
  return importOriginal();
});
vi.mock('./answer-view.tsx', async (importOriginal) => {
  const actual = await importOriginal<typeof AnswerViewModule>();
  return {
    ...actual,
    preloadAnswerView: () => {
      spies.preload();
      actual.preloadAnswerView();
    },
  };
});

beforeEach(() => {
  resetApi({ me: { username: 'demo', full_name: 'Persona Demo', role: 'consulta' } });
  spies.preload.mockClear();
  server.use(
    http.get('/system/analyst', () => HttpResponse.json({ available: true })),
    http.post('/system/analyst/ask/stream', () =>
      HttpResponse.json({ detail: 'Not Found' }, { status: 404 }),
    ),
    http.post('/system/analyst/ask', () =>
      HttpResponse.json({
        answer: 'Hubo un corte [1].',
        sources: [{ n: 1, module: 'eventos', id: 'EV-1', title: 'Corte' }],
      }),
    ),
  );
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
        <InicioPage
          scope="DEMO/PRJ-DEMO"
          projectId="PRJ-DEMO"
          projectLabel="Proyecto Demo"
          fullName="Persona Demo"
          onAsk={vi.fn()}
        />
      </ProjectSettingsProvider>
    </QueryClientProvider>,
  );

// First in the file: the chunk's module is evaluated once per file.
it('loads the answer view only once a question is asked, and renders the answer from it', async () => {
  renderInicio();
  await screen.findByRole('textbox', { name: 'Preguntar, con citas' });
  expect(spies.evaluated).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '¿Qué pasó?' } });
  fireEvent.click(screen.getByRole('button', { name: 'Enviar pregunta' }));
  const log = await screen.findByRole('log', { name: 'Conversación con el analista' });
  expect(await within(log).findByRole('link', { name: 'Fuente 1: Corte' })).toBeTruthy();
  expect(within(log).getByRole('button', { name: 'Copiar' })).toBeTruthy();
  expect(spies.evaluated).toHaveBeenCalledTimes(1);
});

it('fetches the answer view ahead when the composer gets focus', async () => {
  renderInicio();
  const field = await screen.findByRole('textbox', { name: 'Preguntar, con citas' });
  expect(spies.preload).not.toHaveBeenCalled();
  field.focus();
  await waitFor(() => expect(spies.preload).toHaveBeenCalled());
});

it('fetches the answer view ahead on the first key in the composer', async () => {
  renderInicio();
  const field = await screen.findByRole('textbox', { name: 'Preguntar, con citas' });
  fireEvent.keyDown(field, { key: 'a' });
  await waitFor(() => expect(spies.preload).toHaveBeenCalled());
});

it('does not fetch it ahead while the composer only searches', async () => {
  server.use(http.get('/system/analyst', () => HttpResponse.json({ available: false })));
  renderInicio();
  const field = await screen.findByRole('textbox', { name: /Buscar en registros/ });
  field.focus();
  fireEvent.keyDown(field, { key: 'a' });
  expect(spies.preload).not.toHaveBeenCalled();
});
