import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installRecordsApi } from '../../test/records-api.ts';
import { api, resetApi, server } from '../../test/server.ts';
import { App } from '../App.tsx';

/*
 * Sidebar order of direction 01 (odd/tasks/chat-first-ui.md T19, which absorbs T13): «Nueva
 * pregunta» first, «Buscar Ctrl K», the destinations and Integraciones, then this session's
 * questions under «Conversaciones» in place of «Recientes», with the project and account at the
 * foot. The thread is shared by Inicio and the sidebar, in memory only.
 */

const LOG = { name: 'Conversación con el analista' };
const LONG =
  '¿Qué compromisos con la Asociación de Pescadores vencen antes de fin de mes y con qué avance?';

const at = (path: string) => window.history.replaceState(null, '', path);

const withAnalyst = () => {
  installRecordsApi();
  server.use(
    http.get('/system/v4/settings', () =>
      HttpResponse.json({
        level_meanings: { Verde: 'E', Amarillo: 'A', Naranja: 'I', Rojo: 'C' },
        window_days: 90,
        half_life_days: 14,
        thresholds: { Amarillo: 2, Naranja: 4, Rojo: 7 },
        recommendations: [],
        phase: null,
        phases: [],
        external_ai: { enabled: true },
        updated_by: '',
        updated_at: null,
      }),
    ),
    http.get('/system/analyst', () => HttpResponse.json({ available: true })),
    http.get('/system/intelligence/territorial-alerts', () => HttpResponse.json([])),
    http.post('/system/analyst/ask', async ({ request }) => {
      const { question } = (await request.json()) as { question: string };
      return HttpResponse.json({ answer: `Respuesta a ${question}`, sources: [] });
    }),
  );
};

const renderAt = async (path: string) => {
  api.me = { username: 'persona', full_name: 'Persona Sintética', role: 'admin' };
  at(path);
  render(<App />);
  const nav = await screen.findByRole('navigation', { name: 'Secciones' });
  const sidebar = nav.closest('aside');
  if (!sidebar) throw new Error('Missing sidebar');
  return { nav, sidebar, user: userEvent.setup() };
};

const ask = async (question: string) => {
  const composer = await screen.findByRole('textbox', { name: 'Preguntar, con citas' });
  fireEvent.change(composer, { target: { value: question } });
  fireEvent.click(screen.getByRole('button', { name: 'Enviar pregunta' }));
  await screen.findByText(`Respuesta a ${question}`);
};

/** Opens a destination from the sidebar and waits until its screen replaced Inicio's. */
const visit = async (nav: HTMLElement, name: string, user: ReturnType<typeof userEvent.setup>) => {
  await user.click(within(nav).getByRole('link', { name }));
  await screen.findByRole('heading', { level: 1, name });
  await screen.findByRole('group', { name: name === 'Registros' ? 'Tipo de registro' : name });
  await waitFor(() => expect(screen.queryByRole('log', LOG)).toBeNull());
};

const following = (before: Element, after: Element) =>
  expect(before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

// jsdom has no scrolling: a spy records which element was scrolled into view.
const scrollIntoView = Element.prototype.scrollIntoView;
const scrolled: Element[] = [];

beforeEach(() => {
  resetApi();
  scrolled.length = 0;
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
});
afterEach(() => {
  Element.prototype.scrollIntoView = scrollIntoView;
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('sidebar order (T13)', () => {
  it('starts with «Nueva pregunta» and «Buscar», then the destinations, then the project and account', async () => {
    const { nav, sidebar } = await renderAt('/inicio');
    const fresh = within(sidebar).getByRole('link', { name: 'Nueva pregunta' });
    expect(fresh).toHaveAttribute('href', '/inicio');
    expect(fresh).toHaveTextContent('Ctrl+Mayús+O');
    expect(fresh).toHaveAttribute('aria-keyshortcuts', 'Control+Shift+O Meta+Shift+O');
    const search = within(sidebar).getByRole('button', { name: /^Buscar/ });
    expect(search).toHaveTextContent('Ctrl K');
    const destinations = within(nav).getAllByRole('link');
    const project = within(sidebar).getByLabelText('Proyecto activo');
    const account = within(sidebar).getByRole('button', { name: /^Cuenta de / });
    const order = [fresh, search, destinations[0], destinations[5], project, account];
    for (let i = 1; i < order.length; i++)
      following(order[i - 1] as HTMLElement, order[i] as HTMLElement);
  });
});

describe('«Nueva pregunta»', () => {
  it('on Inicio starts a new conversation and puts the cursor in the composer', async () => {
    withAnalyst();
    const { sidebar, user } = await renderAt('/inicio');
    await ask('¿Qué pasó?');
    await user.click(within(sidebar).getByRole('link', { name: 'Nueva pregunta' }));
    expect(screen.queryByRole('log', LOG)).toBeNull();
    expect(window.location.pathname).toBe('/inicio');
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Preguntar, con citas' })).toHaveFocus(),
    );
  });

  it('elsewhere opens Inicio with a fresh conversation and the cursor in the composer', async () => {
    withAnalyst();
    const { nav, sidebar, user } = await renderAt('/inicio');
    await ask('¿Qué pasó?');
    await visit(nav, 'Registros', user);
    await user.click(within(sidebar).getByRole('link', { name: 'Nueva pregunta' }));
    await waitFor(() => expect(window.location.pathname).toBe('/inicio'));
    const composer = await screen.findByRole('textbox', { name: 'Preguntar, con citas' });
    expect(screen.queryByRole('log', LOG)).toBeNull();
    await waitFor(() => expect(composer).toHaveFocus());
  });

  it('answers Ctrl+Mayús+O from another screen the same way', async () => {
    withAnalyst();
    const { nav, user } = await renderAt('/inicio');
    await ask('¿Qué pasó?');
    await visit(nav, 'Territorio', user);
    fireEvent.keyDown(document.body, { key: 'O', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(window.location.pathname).toBe('/inicio'));
    const composer = await screen.findByRole('textbox', { name: 'Preguntar, con citas' });
    expect(screen.queryByRole('log', LOG)).toBeNull();
    await waitFor(() => expect(composer).toHaveFocus());
  });
});

describe('«Conversaciones»', () => {
  it('lists this session’s questions in place of «Recientes», each titled with the whole question', async () => {
    withAnalyst();
    const { nav, user } = await renderAt('/registros?tipo=actores');
    await user.click(within(nav).getByRole('link', { name: 'Inicio' }));
    await waitFor(() =>
      expect(within(nav).getByRole('region', { name: 'Recientes' })).toBeVisible(),
    );
    expect(within(nav).queryByRole('region', { name: 'Conversaciones' })).toBeNull();
    await ask('¿Qué pasó?');
    await ask(LONG);
    const list = within(nav).getByRole('region', { name: 'Conversaciones' });
    const entries = within(list).getAllByRole('link');
    expect(entries.map((entry) => entry.textContent)).toEqual(['¿Qué pasó?', LONG]);
    expect(entries[1]).toHaveAttribute('title', LONG);
    expect(within(nav).queryByRole('region', { name: 'Recientes' })).toBeNull();
  });

  it('scrolls to the chosen question on Inicio, also from another screen', async () => {
    withAnalyst();
    const { nav, user } = await renderAt('/inicio');
    await ask('primera');
    await ask('segunda');
    const list = () => within(within(nav).getByRole('region', { name: 'Conversaciones' }));
    scrolled.length = 0;
    await user.click(list().getByRole('link', { name: 'primera' }));
    await waitFor(() =>
      expect(scrolled.some((element) => element.textContent === 'primera')).toBe(true),
    );

    await visit(nav, 'Territorio', user);
    scrolled.length = 0;
    await user.click(list().getByRole('link', { name: 'segunda' }));
    await waitFor(() => expect(window.location.pathname).toBe('/inicio'));
    expect(await screen.findByRole('log', LOG)).toHaveTextContent('primera');
    await waitFor(() =>
      expect(scrolled.some((element) => element.textContent === 'segunda')).toBe(true),
    );
  });

  it('keeps «Recientes» while no conversation exists, and the questions out of storage', async () => {
    withAnalyst();
    const writes = vi.spyOn(Storage.prototype, 'setItem');
    const { nav, user } = await renderAt('/registros?tipo=actores');
    await user.click(within(nav).getByRole('link', { name: 'Inicio' }));
    await waitFor(() =>
      expect(within(nav).getByRole('region', { name: 'Recientes' })).toBeVisible(),
    );
    await ask('pregunta privada');
    await visit(nav, 'Registros', user);
    expect(writes.mock.calls.flat().join(' ')).not.toContain('pregunta privada');
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(
      'pregunta privada',
    );
  });
});
