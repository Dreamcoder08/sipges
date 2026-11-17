import type { ProjectSettings } from '@sipges/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { beforeEach, expect, it, vi } from 'vitest';
import { ProjectSettingsProvider } from '../../../shared/lib/project-settings.tsx';
import { resetApi, server } from '../../../test/server.ts';
import { InicioPage } from './InicioPage.tsx';

/* Inicio's empty state (odd/tasks/chat-first-ui.md T4, direction 02 «Atención primero»). */

beforeEach(() => {
  resetApi({ me: { username: 'demo', full_name: 'Persona Demo', role: 'consulta' } });
  server.use(http.get('/system/intelligence/territorial-alerts', () => HttpResponse.json([])));
});

const GENERIC: readonly [string, string, string, string] = [
  '¿Qué demandas siguen abiertas y quién las lidera?',
  'Resume lo ocurrido esta semana',
  '¿Qué compromisos vencen este mes?',
  '¿Qué alertas esperan aprobación?',
] as const;
const RED = '¿Qué alertas rojas siguen abiertas?';

const settings = (externalAI: boolean) =>
  ({
    external_ai: { enabled: externalAI },
    level_meanings: {
      Verde: 'Estable',
      Amarillo: 'Atención',
      Naranja: 'Intervención',
      Rojo: 'Crítica',
    },
  }) as ProjectSettings;

const renderInicio = (externalAI: boolean, onAsk = vi.fn()) => {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ProjectSettingsProvider value={settings(externalAI)}>
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

const chipTexts = async () => {
  const chips = await screen.findByRole('list', { name: 'Prueba con' });
  return within(chips)
    .getAllByRole('button')
    .map((button) => button.textContent);
};

it('asks the analyst with a starter chip in one click while «Preguntar» is on', async () => {
  let asked: unknown;
  server.use(
    http.get('/system/analyst', () => HttpResponse.json({ available: true })),
    http.post('/system/analyst/ask', async ({ request }) => {
      asked = await request.json();
      return HttpResponse.json({ answer: 'Dos demandas siguen abiertas.', sources: [] });
    }),
  );
  const onAsk = renderInicio(true);
  await screen.findByRole('textbox', { name: 'Preguntar, con citas' });
  const chips = await screen.findByRole('list', { name: 'Prueba con' });
  fireEvent.click(within(chips).getByRole('button', { name: GENERIC[0] }));
  expect(await screen.findByText('Dos demandas siguen abiertas.')).toBeVisible();
  expect(asked).toEqual({ question: GENERIC[0] });
  expect(onAsk).not.toHaveBeenCalled();
});

it('searches the records with a starter chip in one click while «Buscar» is on', async () => {
  const onAsk = renderInicio(false);
  const chips = await screen.findByRole('list', { name: 'Prueba con' });
  fireEvent.click(within(chips).getByRole('button', { name: GENERIC[1] }));
  expect(onAsk).toHaveBeenCalledWith(GENERIC[1]);
});

it('keeps the generic chips while no red alert is open', async () => {
  // The default alerts: one open «Alta» (Naranja) and one closed «Rojo».
  renderInicio(false);
  await screen.findByText('Alerta sin causa documentada');
  expect(await chipTexts()).toEqual(GENERIC);
});

it('asks about open red alerts first while there are some, in at most four chips', async () => {
  server.use(
    http.get('/api/alertas', () =>
      HttpResponse.json([
        { _id: 'AL-5', Estado: 'Abierta', Nivel: 'Rojo', Causa: 'Corte de vía' },
        { _id: 'AL-6', Estado: 'Cerrada', Nivel: 'Rojo', Causa: 'Paro' },
      ]),
    ),
  );
  renderInicio(false);
  await waitFor(async () => expect((await chipTexts())[0]).toBe(RED));
  const texts = await chipTexts();
  expect(texts).toHaveLength(4);
  expect(new Set(texts).size).toBe(4);
});

it('keeps the L11 order: attention, composer, chips, then the week', async () => {
  renderInicio(false);
  const attention = await screen.findByRole('region', { name: /Necesita tu atención/ });
  const composer = screen.getByRole('textbox', { name: 'Buscar en registros de Proyecto Demo' });
  const chips = screen.getByRole('list', { name: 'Prueba con' });
  const week = screen.getByRole('region', { name: /Esta semana/ });
  const order = [attention, composer, chips, week];
  for (let i = 1; i < order.length; i++) {
    const before = order[i - 1] as HTMLElement;
    expect(before.compareDocumentPosition(order[i] as HTMLElement)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  }
});
