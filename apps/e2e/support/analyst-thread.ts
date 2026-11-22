import type { Locator, Page, Route } from '@playwright/test';
import { expect } from './fixtures.ts';

/*
 * Inicio's conversation with the analyst (odd/tasks/chat-first-ui.md T16), shared by the desktop
 * and phone specs. This e2e API (the TypeScript one) has no analyst: it says none is configured
 * and has neither /system/analyst/ask nor /ask/stream. So the browser says the installation has
 * one, the project settings say whether external AI is on (nothing is stored), and /ask is
 * answered in the browser with synthetic replies. /ask/stream is left to the server, whose 404
 * makes Inicio fall back to /ask (T21), unless a spec fakes the stream itself; `fakeAnalyst` declares
 * that 404 in the browser, because the Go API does serve the stream.
 */

export type Source = { n: number; module: string; id: string; title: string };
export type Reply = { answer: string; sources: Source[]; blocks: unknown[] };

export const ASK_PATH = '/system/analyst/ask';
export const STREAM_PATH = '/system/analyst/ask/stream';
const ASK = /\/system\/analyst\/ask$/;

/** A synthetic reply naming its question's number, with one cited source per paragraph. */
export const replyTo = (number: number, paragraphs = 1): Reply => {
  const sources = Array.from({ length: paragraphs }, (_, at) => ({
    n: at + 1,
    module: 'actores',
    id: `A-SINTETICO-${number}-${at + 1}`,
    title: `Actor sintético ${number}.${at + 1}`,
  }));
  return {
    answer: sources
      .map(
        (source) =>
          `Respuesta sintética ${number}, párrafo ${source.n}: la mesa de diálogo sigue abierta [${source.n}].`,
      )
      .join('\n\n'),
    sources,
    blocks: [],
  };
};

/**
 * The project settings say external AI is on (or off) and the installation says it has an
 * analyst. Both are answered in the browser; no setting is written.
 */
export const fakeAnalyst = async (page: Page, { externalAi }: { externalAi: boolean }) => {
  await page.route('**/system/v4/settings', async (route) => {
    const response = await route.fetch();
    const settings = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...settings, external_ai: { enabled: externalAi } } });
  });
  await page.route('**/system/analyst', (route) => route.fulfill({ json: { available: true } }));
  // Inicio falls back from the stream to /ask when the stream answers 404. The TypeScript API has
  // no stream route at all; the Go API serves one (and says no analyst is configured), so the
  // fallback is declared here to keep these specs the same on both runtimes. A spec that fakes
  // the stream registers its own route afterwards, and Playwright's latest route wins.
  await page.route(`**${STREAM_PATH}`, (route) =>
    route.fulfill({ status: 404, json: { detail: 'Not Found' } }),
  );
};

/** The question a request to /ask carries. */
export const questionOf = (route: Route) =>
  String((route.request().postDataJSON() as { question?: unknown }).question ?? '');

/** Answers /ask with `answer(question)`; resolves the questions asked, in order. */
export const answerAsk = async (
  page: Page,
  answer: (question: string, route: Route) => Promise<void> | void,
) => {
  const asked: string[] = [];
  await page.route(ASK, async (route) => {
    const question = questionOf(route);
    asked.push(question);
    await answer(question, route);
  });
  return asked;
};

export const composer = (page: Page) => page.getByRole('textbox', { name: 'Preguntar, con citas' });
export const thread = (page: Page) =>
  page.getByRole('log', { name: 'Conversación con el analista' });
export const answers = (page: Page) =>
  thread(page).getByRole('region', { name: 'Respuesta del analista' });
export const questions = (page: Page) => thread(page).getByRole('article', { name: 'Tu pregunta' });
/** A status region saying exactly `text` (Inicio's: an answer's start and end, a stop, «Copiado»). */
export const announced = (page: Page, text: string) =>
  page
    .getByRole('status')
    .filter({ hasText: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) });

/** Sends `question` from the composer with Enter. */
export const ask = async (page: Page, question: string) => {
  const field = composer(page);
  await field.fill(question);
  await field.press('Enter');
};

/** Sends `question` and waits until its answer is on screen and the composer is empty again. */
export const askAndWait = async (page: Page, question: string, answerText: RegExp | string) => {
  await ask(page, question);
  await expect(answers(page).last()).toContainText(answerText);
  await expect(thread(page)).toHaveAttribute('aria-busy', 'false');
  await expect(composer(page)).toHaveValue('');
};

/** The empty Inicio: no thread, the attention list and the starter chips, the composer focused. */
export const expectEmptyInicio = async (page: Page) => {
  await expect(page).toHaveURL(/\/inicio$/);
  await expect(thread(page)).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Necesita tu atención' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Prueba con' })).toBeVisible();
  await expect(composer(page)).toHaveValue('');
  await expect(composer(page)).toBeFocused();
};

/**
 * Registros is on screen and Inicio has left it. The address changes before the old screen
 * unmounts; a «Nueva pregunta» pressed in between still finds Inicio and only clears it there.
 */
export const expectOtherScreen = async (page: Page) => {
  await expect(page).toHaveURL(/\/registros$/);
  await expect(
    page.getByRole('main').getByRole('group', { name: 'Tipo de registro' }),
  ).toBeVisible();
  await expect(page.locator('form[data-ai]')).toHaveCount(0);
};

/** Brings a part of the page to the top of the view, wherever the page scrolls. */
export const scrollToTop = (locator: Locator) =>
  locator.evaluate((node) => node.scrollIntoView({ block: 'start', behavior: 'instant' }));

/**
 * Replaces the browser's fetch of /ask/stream with an event stream this page controls: it sends
 * one `step` at once and the answer only when `finish` is called. The TypeScript e2e API has no
 * stream route, and a fulfilled route sends its whole body at once, so a pending step could never
 * be seen otherwise. Runs before the app; init scripts are not subject to the page's CSP.
 */
export const fakeStream = async (page: Page, step: string) => {
  await page.addInitScript(
    ({ path, label }) => {
      const encoder = new TextEncoder();
      const original = window.fetch.bind(window);
      const holder = window as unknown as { __finishStream?: (data: string) => void };
      window.fetch = (input, init) => {
        const url = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
          location.href,
        );
        if (url.pathname !== path) return original(input, init);
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            const send = (event: string, data: string) =>
              controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
            send('step', JSON.stringify({ label }));
            holder.__finishStream = (data) => {
              send('answer', data);
              send('done', '{}');
              controller.close();
            };
            init?.signal?.addEventListener('abort', () =>
              controller.error(new DOMException('Aborted', 'AbortError')),
            );
          },
        });
        return Promise.resolve(
          new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
        );
      };
    },
    { path: STREAM_PATH, label: step },
  );
  return {
    finish: (reply: Reply) =>
      page.evaluate((data) => {
        const holder = window as unknown as { __finishStream?: (data: string) => void };
        if (!holder.__finishStream) throw new Error('the stream was not opened');
        holder.__finishStream(data);
      }, JSON.stringify(reply)),
  };
};

/** The analyst's turn that answers `question`. */
export const answerTurn = (page: Page, question: string) =>
  thread(page).getByRole('article', { name: `respuesta a «${question}»` });

export type SignIn = (page: Page) => Promise<void>;

/** The global search palette, opened by a search from the composer or an error turn. */
const palette = (page: Page) => page.getByRole('dialog', { name: 'Búsqueda global' });

/** The palette searched for `text` and the search answered (a count of results). */
const expectSearched = async (page: Page, text: string) => {
  await expect(palette(page).getByRole('combobox')).toHaveValue(text);
  await expect(palette(page).getByRole('status')).toHaveText(/^\d+ resultados?$/);
};

export const THREE = [
  '¿Qué pasa con la comunidad sintética del valle alto?',
  '¿Quién lidera la mesa de diálogo sintética?',
  '¿Qué compromisos sintéticos vencen esta semana?',
] as const;

/**
 * T5: three questions make one thread in order (role=log), each with its own answer. Read from
 * the top, «Ir al final» appears, and it brings the view back to the last answer and the composer.
 */
export const threeQuestionThread = async (page: Page, signIn: SignIn) => {
  await fakeAnalyst(page, { externalAi: true });
  // Six paragraphs each, so three answers are taller than the screen.
  const asked = await answerAsk(page, (question, route) =>
    route.fulfill({ json: replyTo(THREE.indexOf(question as (typeof THREE)[number]) + 1, 6) }),
  );
  await signIn(page);
  await page.goto('/inicio');
  for (const [at, question] of THREE.entries()) {
    await askAndWait(page, question, `Respuesta sintética ${at + 1}, párrafo 6`);
  }
  expect(asked).toEqual(THREE);
  await expect(questions(page)).toHaveText([...THREE]);
  await expect(answers(page)).toHaveCount(3);
  for (const [at, question] of THREE.entries()) {
    await expect(answerTurn(page, question)).toContainText(
      `Respuesta sintética ${at + 1}, párrafo 1`,
    );
  }
  await expect(announced(page, 'Respuesta del analista lista.')).toHaveCount(1);

  // The view followed each answer to the bottom: nothing to jump to.
  const jump = page.getByRole('button', { name: 'Ir al final' });
  await expect(jump).toHaveCount(0);
  await scrollToTop(questions(page).first());
  await expect(jump).toBeVisible();
  await expect(
    answers(page).last().getByText('Respuesta sintética 3, párrafo 6'),
  ).not.toBeInViewport();
  await jump.click();
  await expect(jump).toHaveCount(0);
  await expect(answers(page).last().getByText('Respuesta sintética 3, párrafo 6')).toBeInViewport();
  await expect(composer(page)).toBeInViewport();
};

/**
 * T7: «Detener» while an answer is pending cancels the request; the turn says «Detenido», the
 * question is back in the composer, and an answer that still arrives is never shown.
 */
export const stopPendingAnswer = async (page: Page, signIn: SignIn) => {
  const stopped = '¿Qué dijo la asamblea sintética del lunes?';
  const next = THREE[1];
  const late = 'Respuesta sintética tardía que nunca debe aparecer.';
  await fakeAnalyst(page, { externalAi: true });
  let hold: (route: Route) => void = () => undefined;
  const held = new Promise<Route>((resolve) => {
    hold = resolve;
  });
  const asked = await answerAsk(page, (question, route) => {
    // The first question is held: its answer only arrives after «Detener».
    if (question === stopped) hold(route);
    else return route.fulfill({ json: replyTo(2) });
  });
  await signIn(page);
  await page.goto('/inicio');
  await ask(page, stopped);
  const route = await held;
  const turn = answerTurn(page, stopped);
  await expect(turn).toContainText('Buscando registros…');
  await expect(thread(page)).toHaveAttribute('aria-busy', 'true');
  await expect(announced(page, 'El analista está buscando registros.')).toHaveCount(1);

  const cancelled = page.waitForEvent('requestfailed', (request) => ASK.test(request.url()));
  await page.getByRole('button', { name: 'Detener respuesta' }).click();
  await cancelled;
  // Stopping never asks again: the thread still holds the one question.
  await expect(questions(page)).toHaveText([stopped]);
  await expect(turn).toContainText('Detenido');
  await expect(turn).not.toContainText('Buscando registros…');
  await expect(thread(page)).toHaveAttribute('aria-busy', 'false');
  await expect(composer(page)).toHaveValue(stopped);
  await expect(page.getByRole('button', { name: 'Enviar pregunta' })).toBeVisible();
  await expect(announced(page, 'Respuesta detenida.')).toHaveCount(1);

  // The held answer arrives late (the browser already let go of it), then another question is
  // answered: by then a late answer would have shown, and it never does.
  await route.fulfill({ json: { answer: late, sources: [], blocks: [] } }).catch(() => undefined);
  await askAndWait(page, next, 'Respuesta sintética 2');
  await expect(questions(page)).toHaveText([stopped, next]);
  await expect(answers(page)).toHaveCount(1);
  await expect(page.getByText(late)).toHaveCount(0);
  await expect(turn).toContainText('Detenido');
  expect(asked).toEqual([stopped, next]);
};

/** T5, T6: an unavailable analyst (503) says why, offers the search, and asks again. */
export const unavailableAnalyst = async (page: Page, signIn: SignIn) => {
  const question = THREE[0];
  const detail = 'El servicio de IA sintético no responde ahora.';
  await fakeAnalyst(page, { externalAi: true });
  let down = true;
  const asked = await answerAsk(page, (_question, route) =>
    down ? route.fulfill({ status: 503, json: { detail } }) : route.fulfill({ json: replyTo(1) }),
  );
  await signIn(page);
  await page.goto('/inicio');
  await ask(page, question);
  const turn = answerTurn(page, question);
  await expect(turn).toContainText(detail);
  await expect(thread(page)).toHaveAttribute('aria-busy', 'false');
  // The log reads the error once; the turn holds no alert of its own (L6).
  await expect(turn.getByRole('alert')).toHaveCount(0);
  await expect(announced(page, 'El analista no respondió.')).toHaveCount(1);
  // The question stays in the composer after an error.
  await expect(composer(page)).toHaveValue(question);
  const search = turn.getByRole('button', { name: `Buscar «${question}» en registros` });
  const retry = turn.getByRole('button', { name: 'Volver a preguntar' });
  await expect(search).toBeVisible();
  await expect(retry).toBeVisible();

  await search.click();
  await expectSearched(page, question);
  await page.keyboard.press('Escape');
  await expect(palette(page)).toBeHidden();

  down = false;
  await retry.click();
  await expect(questions(page)).toHaveText([question, question]);
  await expect(answers(page).last()).toContainText('Respuesta sintética 1, párrafo 1');
  await expect(announced(page, 'Respuesta del analista lista.')).toHaveCount(1);
  await expect(composer(page)).toHaveValue('');
  expect(asked).toEqual([question, question]);
};

/**
 * T3: with external AI off for the project, «Preguntar» is disabled and says why, the box
 * searches, and nothing is asked of the analyst.
 */
export const externalAiOff = async (page: Page, signIn: SignIn) => {
  const reason = 'Preguntar no está disponible: la IA externa está desactivada en este proyecto.';
  await fakeAnalyst(page, { externalAi: false });
  const analyst: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith(ASK_PATH)) analyst.push(request.url());
  });
  await signIn(page);
  await page.goto('/inicio');
  const preguntar = page.getByRole('radio', { name: 'Preguntar' });
  await expect(preguntar).toBeDisabled();
  await expect(preguntar).toHaveAccessibleDescription(reason);
  await expect(page.locator('label').filter({ has: preguntar })).toHaveAttribute('title', reason);
  await expect(page.getByRole('radio', { name: 'Buscar' })).toBeChecked();
  await expect(page.getByText('IA externa desactivada')).toBeVisible();
  await expect(composer(page)).toHaveCount(0);
  // The box says what Enter does here and where AI is switched on.
  const field = page.getByRole('textbox', { name: /^Buscar en registros de / });
  await expect(field).toHaveAccessibleDescription(
    'La IA externa está desactivada en este proyecto: Enter busca. Se activa en Configuración → Privacidad y datos.',
  );
  await field.fill('mesa de diálogo');
  await field.press('Enter');
  await expectSearched(page, 'mesa de diálogo');
  await expect(thread(page)).toHaveCount(0);
  expect(analyst).toEqual([]);
};

/** The answer the copy journey asks for, and the plain text «Copiar» must produce from it. */
const COPY_REPLY: Reply = {
  answer:
    'La comunidad sintética mantiene abierta la mesa de diálogo [1].\n\n' +
    '- El bloqueo sintético de la vía sigue activo [2].\n' +
    '- Se pidió una **nueva reunión** con la empresa.',
  sources: [
    { n: 1, module: 'actores', id: 'A-SINTETICO-0101', title: 'Comunidad sintética del valle' },
    { n: 2, module: 'alertas', id: 'AL-SINTETICO-0102', title: 'Bloqueo sintético de la vía' },
  ],
  blocks: [],
};
const COPIED = [
  'La comunidad sintética mantiene abierta la mesa de diálogo [1].',
  '',
  '- El bloqueo sintético de la vía sigue activo [2].',
  '- Se pidió una nueva reunión con la empresa.',
  '',
  'Fuentes:',
  '[1] Comunidad sintética del valle — /objeto/actores/A-SINTETICO-0101',
  '[2] Bloqueo sintético de la vía — /objeto/alertas/AL-SINTETICO-0102',
].join('\n');

/**
 * T6: «Copiar» puts the answer and its numbered sources on the clipboard as plain text, says
 * «Copiado.» once and shows «Copiado» beside the button. The caller grants clipboard access.
 */
export const copyAnswer = async (page: Page, signIn: SignIn) => {
  const question = THREE[0];
  await fakeAnalyst(page, { externalAi: true });
  await answerAsk(page, (_question, route) => route.fulfill({ json: COPY_REPLY }));
  await signIn(page);
  await page.goto('/inicio');
  await askAndWait(page, question, 'Se pidió una nueva reunión con la empresa.');
  const actions = answerTurn(page, question).getByRole('group', {
    name: 'Acciones de la respuesta',
  });
  await actions.getByRole('button', { name: 'Copiar' }).click();
  await expect(actions.getByText('Copiado', { exact: true })).toBeVisible();
  await expect(announced(page, 'Copiado.')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(COPIED);
};

/**
 * T21 against this e2e API, which has no stream route: the stream request is answered 404 and
 * the same question is asked through /ask once, whose answer the thread shows.
 */
export const streamFallback = async (page: Page, signIn: SignIn) => {
  const question = THREE[1];
  await fakeAnalyst(page, { externalAi: true });
  const asked = await answerAsk(page, (_question, route) => route.fulfill({ json: replyTo(1) }));
  await signIn(page);
  await page.goto('/inicio');
  const streamed = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === STREAM_PATH && response.request().method() === 'POST',
  );
  await ask(page, question);
  expect((await streamed).status()).toBe(404);
  await expect(answerTurn(page, question)).toContainText('Respuesta sintética 1, párrafo 1');
  await expect(announced(page, 'Respuesta del analista lista.')).toHaveCount(1);
  expect(asked).toEqual([question]);
};

/**
 * T21 with a stream: the pending turn shows the analyst's latest step as its progress text, the
 * page announces only the start, and the answer replaces the step once it arrives. /ask is never
 * asked. The stream is the page's own (`fakeStream`).
 */
export const streamStep = async (page: Page, signIn: SignIn) => {
  const question = THREE[2];
  const step = 'Leyendo la línea de tiempo…';
  const stream = await fakeStream(page, step);
  await fakeAnalyst(page, { externalAi: true });
  const asked = await answerAsk(page, (_question, route) => route.fulfill({ json: replyTo(9) }));
  await signIn(page);
  await page.goto('/inicio');
  await ask(page, question);
  const turn = answerTurn(page, question);
  await expect(turn).toContainText(step);
  await expect(turn).not.toContainText('Buscando registros…');
  await expect(thread(page)).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByRole('button', { name: 'Detener respuesta' })).toBeVisible();
  await expect(announced(page, 'El analista está buscando registros.')).toHaveCount(1);
  await expect(page.getByRole('status').filter({ hasText: step })).toHaveCount(0);

  await stream.finish(replyTo(3));
  await expect(turn).toContainText('Respuesta sintética 3, párrafo 1');
  await expect(turn).not.toContainText(step);
  await expect(thread(page)).toHaveAttribute('aria-busy', 'false');
  await expect(announced(page, 'Respuesta del analista lista.')).toHaveCount(1);
  expect(asked).toEqual([]);
};
