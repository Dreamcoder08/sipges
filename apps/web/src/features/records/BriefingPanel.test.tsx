import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { NavigateProvider } from '../../shared/lib/navigation.tsx';
import { server } from '../../test/server.ts';
import { BriefingPanel } from './BriefingPanel.tsx';

const briefing = (narrative: { text: string; refs: number[] } | null, notice: string | null) => ({
  subject: {
    module: 'actores',
    id: 'A-1',
    type_label: 'Actor',
    title: 'Comunidad Norte',
    date: null,
    marking: 'interno',
    fields: {},
  },
  generated_at: '2026-10-14T00:00:00Z',
  engine: narrative ? 'asistido' : 'extractivo',
  narrator: narrative ? 'prueba' : null,
  notice,
  narrative,
  sections: [
    { title: 'Resumen', sentences: [{ text: 'Actor «Comunidad Norte».', refs: [1] }] },
    {
      title: 'Señales de atención',
      sentences: [{ text: 'Alerta «Bloqueo» sigue abierta con nivel Alto.', refs: [2] }],
    },
  ],
  sources: [
    { ref: 1, module: 'actores', id: 'A-1', type_label: 'Actor', title: 'Comunidad Norte' },
    { ref: 2, module: 'alertas', id: 'AL-1', type_label: 'Alerta', title: 'Bloqueo' },
  ],
});

const renderPanel = () => {
  const visited: string[] = [];
  render(
    <QueryClientProvider client={new QueryClient()}>
      <NavigateProvider value={(href) => visited.push(href)}>
        <BriefingPanel module="actores" id="A-1" scope="A/B" />
      </NavigateProvider>
    </QueryClientProvider>,
  );
  return { visited, user: userEvent.setup() };
};

it('generates the briefing on request and links every citation to its record', async () => {
  let calls = 0;
  server.use(
    http.get('/system/briefing', () => {
      calls += 1;
      return HttpResponse.json(
        briefing({ text: 'La comunidad [1] enfrenta un bloqueo [2].', refs: [1, 2] }, null),
      );
    }),
  );
  const { visited, user } = renderPanel();
  expect(calls).toBe(0);
  await user.click(screen.getByRole('button', { name: 'Generar informe' }));
  const narrative = await screen.findByText(/La comunidad/);
  expect(narrative.closest('p')).toHaveTextContent('La comunidad [1] enfrenta un bloqueo [2].');
  expect(screen.getByText(/asistencia de un modelo de lenguaje/)).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Señales de atención' })).toBeVisible();
  await user.click(
    screen.getAllByRole('link', { name: 'Fuente 2: Alerta AL-1' })[0] as HTMLElement,
  );
  expect(visited).toEqual(['/objeto/alertas/AL-1']);
  const sources = screen.getByRole('list', { name: 'Fuentes del informe' });
  expect(within(sources).getByRole('link', { name: 'Alerta AL-1' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Actualizar informe' }));
  await screen.findByRole('button', { name: 'Actualizar informe' });
  expect(calls).toBe(2);
});

it('shows the extractive briefing and the notice when there is no narrative', async () => {
  server.use(
    http.get('/system/briefing', () =>
      HttpResponse.json(briefing(null, 'El resumen asistido no estuvo disponible.')),
    ),
  );
  const { user } = renderPanel();
  await user.click(screen.getByRole('button', { name: 'Generar informe' }));
  expect(await screen.findByText('El resumen asistido no estuvo disponible.')).toBeVisible();
  expect(screen.queryByText(/asistencia de un modelo/)).toBeNull();
  expect(screen.getByText(/Actor «Comunidad Norte»\./)).toBeVisible();
});
