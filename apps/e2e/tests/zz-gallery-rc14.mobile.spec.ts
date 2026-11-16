import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';
import { watchNetwork } from '../support/network.ts';
import { brokenWords } from '../support/text-fit.ts';
import { widerGlyphs } from './split-pieces.ts';

/**
 * The visit-rc14 gallery dudas on phones and tablets (odd/tasks/functional-10.md T14). Runs last in
 * the phone project because it adds synthetic records to the shared project.
 */
const headers = { 'X-SIPGES-Scope': DEFAULT_SCOPE };

const seed = async (
  adminApi: APIRequestContext,
  module: string,
  payload: Record<string, string>,
) => {
  const created = await adminApi.post(`/api/${module}`, { headers, data: { payload } });
  expect(created.status(), await created.text()).toBe(200);
  return ((await created.json()) as { id: string }).id;
};

const at = async (
  page: Page,
  admin: { username: string; password: string },
  size: { width: number; height: number },
) => {
  await page.setViewportSize(size);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const settled = watchNetwork(page);
  await signInToProject(page, admin, DEFAULT_SCOPE);
  return settled;
};

/** Rows of a scroll box: whole (inside it), cut by its edge, or below it. */
const rowsAgainstEdge = (list: Locator) =>
  list.evaluate((box) => {
    const edge = box.getBoundingClientRect();
    const bottom = edge.top + box.clientTop + box.clientHeight;
    return [...box.children].map((row) => {
      const rect = row.getBoundingClientRect();
      if (rect.bottom <= bottom + 0.5) return 'whole';
      return rect.top >= bottom - 0.5 ? 'below' : 'cut';
    });
  });

test('Panel at 360 px tells apart two alerts with one title by place and id', async ({
  page,
  admin,
  adminApi,
}) => {
  const stamp = Date.now();
  const title = `Bloqueo sintético repetido ${stamp}`;
  // Red and the latest day, so both are among the three alerts Panel lists first. Long ids with
  // hyphens, as imported ones are («AL-MAP-1794791512245-1» in spec 15).
  const first = await seed(adminApi, 'alertas', {
    ID_Alerta: `AL-T14-PANEL-SINTETICO-${stamp}-1`,
    Causa: title,
    Nivel_Preliminar: 'Rojo',
    Estado: 'Abierta',
    Fecha: '2026-12-31',
    Territorio: 'Vice',
  });
  const second = await seed(adminApi, 'alertas', {
    ID_Alerta: `AL-T14-PANEL-SINTETICO-${stamp}-2`,
    Causa: title,
    Nivel_Preliminar: 'Rojo',
    Estado: 'Abierta',
    Fecha: '2026-12-31',
  });
  const settled = await at(page, admin, { width: 360, height: 800 });
  await page.goto('/');
  const urgent = page.getByRole('region', { name: 'Requiere atención' });
  const rows = urgent.getByRole('link', { name: new RegExp(title) });
  await expect(rows).toHaveCount(2);
  await settled();
  // Same level and day: either may come first, but each row names its own place and id.
  await expect(
    urgent.getByRole('link', { name: new RegExp(`${title}.*Vice · ${first}`) }),
  ).toHaveCount(1);
  await expect(
    urgent.getByRole('link', { name: new RegExp(`${title}.*31 dic\\. · ${second}`) }),
  ).toHaveCount(1);
  const texts = await rows.allInnerTexts();
  expect(new Set(texts).size).toBe(2);
  // An id is one word: it moves to its own line whole, never «AL-» / «7AB…» (WebKit's wider
  // glyphs broke it after a hyphen in text-fit.mobile).
  await widerGlyphs(page);
  for (const row of await rows.all())
    expect(await brokenWords(row), await row.innerText()).toEqual([]);
});

test('Territorio at 360 px shows its first five map rows whole and cuts none', async ({
  page,
  admin,
  adminApi,
}) => {
  const stamp = Date.now();
  for (const [n, place] of ['Vice', 'Bernal', 'Bayóvar', 'Parachique', 'Sechura', 'Vice'].entries())
    await seed(adminApi, 'eventos', {
      Descripcion_Hecho: `Hecho sintético en ${place} ${stamp}-${n}`,
      Fecha: `2026-10-${String(n + 10).padStart(2, '0')}`,
      Territorio: place,
    });
  await page.addInitScript(() => {
    delete (window as { WebGL2RenderingContext?: unknown }).WebGL2RenderingContext;
  });
  const settled = await at(page, admin, { width: 360, height: 800 });
  await page.goto('/territorio');
  const list = page.getByRole('list', { name: 'Registros en el mapa' });
  await expect(list.getByRole('button', { name: new RegExp(`${stamp}-0`) })).toBeVisible();
  await settled();
  for (const glyphs of ['local', 'wider'] as const) {
    if (glyphs === 'wider') await widerGlyphs(page);
    await list.evaluate((box) => (box.scrollTop = 0));
    // The box follows its rows once they wrap again: poll instead of reading once.
    await expect
      .poll(async () => (await rowsAgainstEdge(list)).slice(0, 6).join(' '), { message: glyphs })
      .toBe('whole whole whole whole whole below');
  }
  // The rows past the fifth stay reachable inside the list.
  const last = list.getByRole('listitem').last();
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
});

test('Territorio at 360 px draws every timeline dot whole inside its list', async ({
  page,
  admin,
  adminApi,
}) => {
  for (const place of ['Vice', 'Bernal'])
    await seed(adminApi, 'eventos', {
      Descripcion_Hecho: `Hecho sintético de la línea de tiempo en ${place}`,
      Fecha: '2026-10-12',
      Territorio: place,
    });
  await page.addInitScript(() => {
    delete (window as { WebGL2RenderingContext?: unknown }).WebGL2RenderingContext;
  });
  const settled = await at(page, admin, { width: 360, height: 800 });
  await page.goto('/territorio');
  const timeline = page.getByRole('list', { name: 'Registros del periodo' });
  await timeline.scrollIntoViewIfNeeded();
  await expect(timeline.getByRole('listitem').first()).toBeVisible();
  await settled();
  const cut = await timeline.evaluate((list) => {
    const box = list.getBoundingClientRect();
    const left = box.left + list.clientLeft;
    return [...list.querySelectorAll('li > span[aria-hidden="true"]')]
      .slice(0, 5)
      .map((dot) => dot.getBoundingClientRect())
      .filter((dot) => dot.left < left - 0.5)
      .map((dot) => Math.round(left - dot.left));
  });
  expect(cut, 'pixels of each dot clipped by the list edge').toEqual([]);
});

test('tablet Eventos names the dimension and gives the description room', async ({
  page,
  admin,
  adminApi,
}) => {
  await seed(adminApi, 'eventos', {
    Descripcion_Hecho: `Asamblea sintética de la comunidad sobre el acta pendiente ${Date.now()}`,
    Dimension_Principal: 'N',
    Territorio: 'Vice, Sechura',
    Nivel_Verificacion: 'B - Corroborada',
    Fecha: '2026-12-31',
  });
  const settled = await at(page, admin, { width: 820, height: 1180 });
  await page.goto('/eventos');
  const table = page.getByRole('table', { name: /Registros de eventos/ });
  await expect(table.getByRole('cell', { name: 'N · Narrativas' }).first()).toBeVisible();
  await settled();
  await widerGlyphs(page);
  const widths = await table.evaluate((node) =>
    Object.fromEntries(
      [...node.querySelectorAll('thead th')].map((th) => [
        th.textContent?.trim() ?? '',
        Math.round(th.getBoundingClientRect().width),
      ]),
    ),
  );
  // 12rem: about five words a line instead of two or three.
  expect(widths['Descripción del hecho'], JSON.stringify(widths)).toBeGreaterThanOrEqual(192);
  expect(widths['Descripción del hecho']).toBeGreaterThan(widths['Acciones'] ?? 0);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

/** The shadow each edge of a sideways scroller draws while more content lies that way. */
const edgeCues = (scroller: Locator) =>
  scroller.evaluate((node) => ({
    start: getComputedStyle(node, '::before').opacity,
    end: getComputedStyle(node, '::after').opacity,
  }));

test('the alert heat map and the actor map at 360 px show which way they scroll', async ({
  page,
  admin,
  adminApi,
}) => {
  const stamp = Date.now();
  for (const n of [1, 2, 3])
    await seed(adminApi, 'alertas', {
      Causa: `Alerta sintética del mapa de calor ${stamp}-${n}`,
      Dimension: 'E',
      Territorio: `Territorio sintético ${stamp}-${n}`,
      Nivel_Preliminar: 'Naranja',
      Estado: 'Abierta',
      Fecha: '2026-10-12',
    });
  await seed(adminApi, 'actores', {
    'Nombre_Actor/Organizacion': `Organización sintética ${stamp}`,
    Tipo_Actor: 'Comunidad',
    Influencia: 'Baja',
    Posicion_Proyecto: 'Neutral',
  });
  const settled = await at(page, admin, { width: 360, height: 800 });
  await page.goto('/alertas');
  const heat = page.getByRole('region', { name: 'Matriz de calor por dimensión y territorio' });
  await expect(heat).toBeVisible();
  await settled();
  expect(await heat.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
  await expect.poll(() => edgeCues(heat)).toEqual({ start: '0', end: '1' });
  await heat.evaluate((node) => (node.scrollLeft = node.scrollWidth));
  await expect.poll(() => edgeCues(heat)).toEqual({ start: '1', end: '0' });

  await page.goto('/actores');
  const actors = page.getByRole('group', { name: 'Mapa de actores por sector e influencia' });
  await expect(actors).toBeVisible();
  // The phone canvas opens centred: actors lie both ways.
  // svg → canvas → the stage that scrolls sideways on a phone.
  const stage = actors.locator('xpath=../..');
  await expect.poll(() => edgeCues(stage)).toEqual({ start: '1', end: '1' });
  await stage.evaluate((node) => (node.scrollLeft = 0));
  await expect.poll(() => edgeCues(stage)).toEqual({ start: '0', end: '1' });
});
