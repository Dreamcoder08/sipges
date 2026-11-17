import type { ProjectSettings } from '@sipges/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, delay, http } from 'msw';
import { beforeEach, expect, it, vi } from 'vitest';
import { ProjectSettingsProvider } from '../../../shared/lib/project-settings.tsx';
import { resetApi, server } from '../../../test/server.ts';
import { InicioPage } from './InicioPage.tsx';

/* The Inicio box asks the analyst while external AI is on, and searches while it is off (T1d). */

beforeEach(() =>
  resetApi({ me: { username: 'demo', full_name: 'Persona Demo', role: 'consulta' } }),
);

const settings = (externalAI: boolean) =>
  ({
    external_ai: { enabled: externalAI },
    level_meanings: {
      Verde: 'Situación estable / riesgo bajo',
      Amarillo: 'Requiere atención y seguimiento',
      Naranja: 'Requiere intervención preventiva',
      Rojo: 'Situación crítica / atención inmediata',
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

const ask = (text: string) => {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: /Enviar pregunta|Buscar en registros/ }));
};

it('asks the analyst and shows its cited answer while external AI is on', async () => {
  let asked: unknown;
  server.use(
    http.post('/system/analyst/ask', async ({ request }) => {
      asked = await request.json();
      return HttpResponse.json({
        answer: 'Hubo un bloqueo [1].',
        sources: [{ n: 1, module: 'eventos', id: 'EV-1', title: 'Bloqueo de vía' }],
      });
    }),
  );
  server.use(http.get('/system/analyst', () => HttpResponse.json({ available: true })));
  const onAsk = renderInicio(true);
  // The box turns into a question box once the installation says it has an analyst.
  await screen.findByRole('textbox', { name: 'Preguntar, con citas' });
  ask('  ¿Qué pasó en la vía?  ');
  expect(await screen.findByRole('link', { name: 'Fuente 1: Bloqueo de vía' })).toBeTruthy();
  expect(asked).toEqual({ question: '¿Qué pasó en la vía?' });
  expect(onAsk).not.toHaveBeenCalled();
});

it('keeps searching the records while external AI is off', () => {
  let asked = false;
  server.use(
    http.post('/system/analyst/ask', () => {
      asked = true;
      return HttpResponse.json({ answer: '', sources: [] });
    }),
  );
  const onAsk = renderInicio(false);
  ask('bloqueo');
  expect(onAsk).toHaveBeenCalledWith('bloqueo');
  expect(asked).toBe(false);
});

it('stays a search box and says why when the installation has no analyst', async () => {
  let asked = false;
  server.use(
    http.get('/system/analyst', () => HttpResponse.json({ available: false })),
    http.post('/system/analyst/ask', () => {
      asked = true;
      return HttpResponse.json({ answer: '', sources: [] });
    }),
  );
  const onAsk = renderInicio(true);
  expect(
    await screen.findByText('El analista no está configurado en esta instalación: Enter busca.'),
  ).toBeTruthy();
  ask('bloqueo');
  expect(onAsk).toHaveBeenCalledWith('bloqueo');
  expect(asked).toBe(false);
});

it('says external AI is off for this project when the installation has an analyst', async () => {
  server.use(http.get('/system/analyst', () => HttpResponse.json({ available: true })));
  const onAsk = renderInicio(false);
  expect(
    await screen.findByText(
      'La IA externa está desactivada en este proyecto: Enter busca. Se activa en Configuración → Privacidad y datos.',
    ),
  ).toBeVisible();
  ask('bloqueo');
  expect(onAsk).toHaveBeenCalledWith('bloqueo');
});

it('says the analyst did not answer when its AI service is down, and offers the search', async () => {
  const down =
    'El analista no respondió: el servicio de IA no está disponible. Prueba de nuevo en unos minutos o avisa a quien administra SIPGES.';
  server.use(
    http.get('/system/analyst', () => HttpResponse.json({ available: true })),
    http.post('/system/analyst/ask', () => HttpResponse.json({ detail: down }, { status: 503 })),
  );
  const onAsk = renderInicio(true);
  await screen.findByRole('textbox', { name: 'Preguntar, con citas' });
  ask('bloqueo norte');
  const answer = await screen.findByRole('region', { name: 'Respuesta del analista' });
  expect((await within(answer).findByRole('alert')).textContent).toContain(down);
  fireEvent.click(
    within(answer).getByRole('button', { name: 'Buscar «bloqueo norte» en registros' }),
  );
  expect(onAsk).toHaveBeenCalledWith('bloqueo norte');
});

it('clears the composer once answered and keeps the question after an error', async () => {
  let calls = 0;
  server.use(
    http.get('/system/analyst', () => HttpResponse.json({ available: true })),
    http.post('/system/analyst/ask', () =>
      ++calls === 1
        ? HttpResponse.json({ detail: 'El analista no respondió.' }, { status: 503 })
        : HttpResponse.json({ answer: 'Sin bloqueos.', sources: [] }),
    ),
  );
  renderInicio(true);
  const field = await screen.findByRole('textbox', { name: 'Preguntar, con citas' });
  ask('bloqueo norte');
  const answer = await screen.findByRole('region', { name: 'Respuesta del analista' });
  expect(await within(answer).findByRole('alert')).toHaveTextContent('El analista no respondió.');
  expect(field).toHaveValue('bloqueo norte');
  fireEvent.click(screen.getByRole('button', { name: 'Enviar pregunta' }));
  expect(await screen.findByText('Sin bloqueos.')).toBeVisible();
  expect(field).toHaveValue('');
});

it('searches the records from «Buscar» while external AI is on', async () => {
  let asked = false;
  server.use(
    http.get('/system/analyst', () => HttpResponse.json({ available: true })),
    http.post('/system/analyst/ask', () => {
      asked = true;
      return HttpResponse.json({ answer: '', sources: [] });
    }),
  );
  const onAsk = renderInicio(true);
  await screen.findByRole('textbox', { name: 'Preguntar, con citas' });
  fireEvent.click(screen.getByRole('radio', { name: 'Buscar' }));
  expect(
    screen.getByRole('textbox', { name: 'Buscar en registros de Proyecto Demo' }),
  ).toBeTruthy();
  ask('bloqueo');
  expect(onAsk).toHaveBeenCalledWith('bloqueo');
  expect(asked).toBe(false);
});

it('disables «Preguntar» with its reason while external AI is off', async () => {
  server.use(http.get('/system/analyst', () => HttpResponse.json({ available: true })));
  renderInicio(false);
  const preguntar = await screen.findByRole('radio', { name: 'Preguntar' });
  expect(preguntar).toBeDisabled();
  expect(preguntar).toHaveAccessibleDescription(
    'Preguntar no está disponible: la IA externa está desactivada en este proyecto.',
  );
  expect(screen.getByRole('radio', { name: 'Buscar' })).toBeChecked();
});

it('disables «Preguntar» with its reason when the installation has no analyst', async () => {
  renderInicio(true);
  const preguntar = await screen.findByRole('radio', { name: 'Preguntar' });
  expect(preguntar).toBeDisabled();
  await waitFor(() =>
    expect(preguntar).toHaveAccessibleDescription(
      'Preguntar no está disponible: el analista no está configurado en esta instalación.',
    ),
  );
});

it('stops waiting for the answer from «Detener respuesta» and keeps the question', async () => {
  server.use(
    http.get('/system/analyst', () => HttpResponse.json({ available: true })),
    http.post('/system/analyst/ask', () => delay('infinite')),
  );
  renderInicio(true);
  const field = await screen.findByRole('textbox', { name: 'Preguntar, con citas' });
  ask('bloqueo norte');
  expect(await screen.findByRole('progressbar', { name: 'Preparando la respuesta' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Detener respuesta' }));
  await waitFor(() => expect(screen.queryByRole('progressbar')).toBeNull());
  expect(screen.getByRole('button', { name: 'Enviar pregunta' })).toBeTruthy();
  expect(field).toHaveValue('bloqueo norte');
});
