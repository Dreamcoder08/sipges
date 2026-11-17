import type { ProjectSettings } from '@sipges/contracts';
import { limaToday } from '@sipges/kernel';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProjectSettingsProvider } from '../../../shared/lib/project-settings.tsx';
import { resetApi, server } from '../../../test/server.ts';
import { InicioPage } from './InicioPage.tsx';

/*
 * Direction 01 «Centro conversacional» (odd/tasks/chat-first-ui.md T19, L10): the empty state
 * centred around the composer with at most three compact cards and the week in one line; during a
 * conversation the urgent items move to a «Necesita tu atención N» button in Inicio's top bar.
 */

const LOG = { name: 'Conversación con el analista' };
const ATTENTION = { name: 'Necesita tu atención' };
const day = (offset: number) => limaToday(new Date(Date.now() - offset * 86_400_000));

const alert = (id: string, level: string, cause: string) => ({
  _id: id,
  Estado: 'Abierta',
  Nivel: level,
  Causa: cause,
});
const pending = (id: string) => ({
  id,
  project_id: 'PRJ-DEMO',
  created_at: '2026-11-01T10:00:00Z',
  source_url: 'https://example.invalid/nota',
  source_type: 'web',
  excerpt: `Nota sintética ${id}`,
  sha256: 'x',
  level: 'Media',
  score: 40,
  method: 'reglas',
  semantic_active: false,
  status: 'Pendiente de verificación',
  analyst_note: '',
  reviewer_note: null,
  reviewed_at: null,
  themes: [],
  signals: [],
  suggestions: [],
});

const useData = ({ alerts, digital }: { alerts: unknown[]; digital: unknown[] }) =>
  server.use(
    http.get('/system/analyst', () => HttpResponse.json({ available: true })),
    http.get('/system/intelligence/territorial-alerts', () => HttpResponse.json(digital)),
    http.get('/api/alertas', () => HttpResponse.json(alerts)),
    http.get('/api/eventos', () =>
      HttpResponse.json([
        { _id: 'E-1', Descripcion_Hecho: 'Hecho de hoy', Fecha: day(0), Proyecto_ID: 'PRJ-DEMO' },
        { _id: 'E-2', Descripcion_Hecho: 'Hecho de ayer', Fecha: day(1), Proyecto_ID: 'PRJ-DEMO' },
        { _id: 'E-3', Descripcion_Hecho: 'Hecho viejo', Fecha: day(40), Proyecto_ID: 'PRJ-DEMO' },
      ]),
    ),
    http.post('/system/analyst/ask', () =>
      HttpResponse.json({ answer: 'Sin novedades [1].', sources: [] }),
    ),
  );

/** Two urgent items: a red alert and a pending digital alert. */
const TWO = { alerts: [alert('AL-1', 'Rojo', 'Corte de vía')], digital: [pending('TA-1')] };
/** Five urgent items, more than the three cards. */
const FIVE = {
  alerts: [
    alert('AL-1', 'Rojo', 'Corte de vía'),
    alert('AL-2', 'Naranja', 'Reclamo por polvo'),
    alert('AL-3', 'Naranja', 'Paro anunciado'),
    alert('AL-4', 'Rojo', 'Toma de local'),
  ],
  digital: [pending('TA-1')],
};

beforeEach(() => {
  resetApi({ me: { username: 'demo', full_name: 'Persona Demo', role: 'consulta' } });
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
        <InicioPage
          scope="DEMO/PRJ-DEMO"
          projectId="PRJ-DEMO"
          projectLabel="Proyecto Demo"
          fullName="Persona Demo"
          onAsk={vi.fn()}
          tabs={<div role="group" aria-label="Inicio" />}
        />
      </ProjectSettingsProvider>
    </QueryClientProvider>,
  );

const ready = () => screen.findByRole('textbox', { name: 'Preguntar, con citas' });

const converse = async () => {
  fireEvent.change(await ready(), { target: { value: '¿Qué pasó?' } });
  fireEvent.click(screen.getByRole('button', { name: 'Enviar pregunta' }));
  const log = await screen.findByRole('log', LOG);
  await waitFor(() => expect(log).toHaveAttribute('aria-busy', 'false'));
  return log;
};

const following = (before: Element, after: Element) =>
  expect(before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

it('orders the empty state greeting, status, attention, composer, chips and week, centred', async () => {
  useData(TWO);
  renderInicio();
  const composer = await ready();
  const greeting = screen.getByRole('heading', { level: 2, name: /^Hola, Persona/ });
  const status = screen.getByText('IA externa activada');
  const attention = await screen.findByRole('region', ATTENTION);
  const chips = screen.getByRole('list', { name: 'Prueba con' });
  const week = await screen.findByRole('region', { name: 'Esta semana' });
  const order = [greeting, status, attention, composer, chips, week];
  for (let i = 1; i < order.length; i++)
    following(order[i - 1] as HTMLElement, order[i] as HTMLElement);
  // The block is centred in the column when there is room (a min-height that falls back to flow).
  expect(greeting.closest('[data-centred]')).toContainElement(week);
});

it('shows what needs attention as at most three cards, each one link, and «Ver todo en Bandeja» beyond', async () => {
  useData(FIVE);
  renderInicio();
  const attention = await screen.findByRole('region', ATTENTION);
  const cards = await within(attention).findAllByRole('listitem');
  expect(cards).toHaveLength(3);
  for (const card of cards) expect(within(card).getAllByRole('link')).toHaveLength(1);
  const first = within(cards[0] as HTMLElement).getByRole('link');
  expect(first).toHaveAttribute('href', '/bandeja');
  expect(first).toHaveTextContent('1 alerta digital espera verificación');
  expect(within(attention).getByRole('link', { name: 'Ver todo en Bandeja' })).toHaveAttribute(
    'href',
    '/bandeja',
  );
});

it('drops «Ver todo en Bandeja» when every urgent item fits in the cards', async () => {
  useData(TWO);
  renderInicio();
  const attention = await screen.findByRole('region', ATTENTION);
  expect(await within(attention).findAllByRole('listitem')).toHaveLength(2);
  expect(within(attention).queryByRole('link', { name: 'Ver todo en Bandeja' })).toBeNull();
  expect(within(attention).getByRole('link', { name: 'Abrir Bandeja' })).toBeVisible();
});

it('briefs the week in one line of links, with no cards', async () => {
  useData(TWO);
  renderInicio();
  const week = await screen.findByRole('region', { name: 'Esta semana' });
  const events = await within(week).findByRole('link', { name: '2 eventos' });
  expect(events).toHaveAttribute('href', '/registros');
  const irsa = await within(week).findByRole('link', { name: /^IRSA 42,3/ });
  expect(irsa).toHaveAttribute('href', '/analisis');
  expect(within(week).getByRole('link', { name: 'Riesgo por localidad' })).toHaveAttribute(
    'href',
    '/analisis?vista=riesgo',
  );
  const lines = new Set(
    within(week)
      .getAllByRole('link')
      .map((link) => link.closest('p')),
  );
  expect(lines.size).toBe(1);
  expect(within(week).queryByRole('heading', { level: 3 })).toBeNull();
  expect(within(week).queryByRole('list')).toBeNull();
});

it('moves the urgent items to a top-bar button whose popover takes focus and gives it back', async () => {
  useData(TWO);
  renderInicio();
  await converse();
  expect(screen.queryByRole('region', ATTENTION)).toBeNull();
  // The fold line is gone: no «Esta semana» toggle above the thread.
  expect(screen.queryByRole('button', { name: 'Esta semana' })).toBeNull();
  const button = await screen.findByRole('button', { name: /^Necesita tu atención/ });
  await waitFor(() => expect(button).toHaveTextContent(/^Necesita tu atención\s*2$/));
  // In the top bar, beside the «Inicio | Panel | Centro gerencial» tabs.
  expect(button.parentElement?.parentElement).toContainElement(
    screen.getByRole('group', { name: 'Inicio' }),
  );
  expect(button).toHaveAttribute('aria-expanded', 'false');
  const panelId = button.getAttribute('aria-controls') ?? '';
  expect(panelId).not.toBe('');

  fireEvent.click(button);
  expect(button).toHaveAttribute('aria-expanded', 'true');
  const panel = document.getElementById(panelId) as HTMLElement;
  expect(panel).toBeVisible();
  expect(panel).toContainElement(document.activeElement as HTMLElement);
  expect(within(panel).getByText('Corte de vía')).toBeVisible();
  expect(within(panel).getByRole('link', { name: 'Abrir Bandeja' })).toBeVisible();
  // «Esta semana» stays reachable, as a link in the same popover.
  expect(within(panel).getByRole('link', { name: '2 eventos' })).toHaveAttribute(
    'href',
    '/registros',
  );

  fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
  expect(button).toHaveAttribute('aria-expanded', 'false');
  expect(panel).not.toBeVisible();
  expect(button).toHaveFocus();

  fireEvent.click(button);
  expect(panel).toBeVisible();
  fireEvent.pointerDown(screen.getByRole('log', LOG));
  expect(button).toHaveAttribute('aria-expanded', 'false');
  expect(panel).not.toBeVisible();
  expect(button).toHaveFocus();
});

it('keeps the button, disabled and saying «Nada urgente», when nothing needs attention', async () => {
  useData({ alerts: [], digital: [] });
  renderInicio();
  await converse();
  const button = await screen.findByRole('button', { name: 'Nada urgente' });
  expect(button).toBeDisabled();
  expect(button).toHaveTextContent('Nada urgente');
});

it('shows a bell with the count on phones, named «Necesita tu atención: N»', async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(max-width: 40rem)' || query === '(max-width: 60rem)',
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  useData(TWO);
  renderInicio();
  await converse();
  const bell = await screen.findByRole('button', { name: 'Necesita tu atención: 2' });
  expect(bell.querySelector('svg')).not.toBeNull();
  expect(bell).toHaveTextContent(/^2$/);
});
