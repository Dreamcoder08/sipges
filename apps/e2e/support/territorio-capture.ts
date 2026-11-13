import path from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';
import { type Credentials, DEFAULT_SCOPE, expect, signInToProject } from './fixtures.ts';

/** Where the opt-in captures go; unset in the regular suite, so nothing is written. */
export const CAPTURE_DIR = process.env.SIPGES_SCREENSHOT_DIR;

export type MapRenderer = 'svg' | 'webgl';

/** Synthetic records spread over Sechura, plus one the map cannot place (never real data). */
const PLACED = [
  ['Asamblea sintética', 'Vice, Sechura', '2026-10-12'],
  ['Vigilia sintética', 'Bayóvar', '2026-10-11'],
  ['Reunión sintética de regantes', 'Sechura', '2026-10-10'],
  ['Monitoreo sintético de playa', 'Parachique', '2026-10-09'],
  ['Mesa sintética de diálogo', 'Bernal', '2026-10-08'],
] as const;

/**
 * Territorio › Mapa with records, for the owner's review (rc1 hardening): the numbered list, its
 * numbered markers and the «sin ubicación» group open, saved as a full-page PNG. `svg` removes
 * WebGL 2 so the markers are DOM nodes and their numbers are checked against the list; `webgl`
 * keeps it so the MapLibre + deck.gl canvas draws the numbers a person sees on a real laptop.
 */
export const captureTerritorioMap = async (
  page: Page,
  { admin, adminApi }: { admin: Credentials; adminApi: APIRequestContext },
  options: {
    colorScheme: 'light' | 'dark';
    renderer: MapRenderer;
    width: number;
    height: number;
  },
) => {
  const { colorScheme, renderer, width, height } = options;
  await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
  await page.setViewportSize({ width, height });
  if (renderer === 'svg') {
    await page.addInitScript(() => {
      delete (window as { WebGL2RenderingContext?: unknown }).WebGL2RenderingContext;
    });
  }
  const stamp = `${width}-${colorScheme}-${renderer}`;
  const seed = async (payload: Record<string, string>) => {
    const created = await adminApi.post('/api/eventos', {
      headers: { 'X-SIPGES-Scope': DEFAULT_SCOPE },
      data: { payload },
    });
    expect(created.status(), await created.text()).toBe(200);
  };
  for (const [title, place, date] of PLACED) {
    await seed({ Descripcion_Hecho: `${title} ${stamp}`, Territorio: place, Fecha: date });
  }
  await seed({
    Descripcion_Hecho: `Reunión sintética sin lugar ${stamp}`,
    Territorio: 'Paraje sintético sin mapa',
  });
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await page.goto('/territorio');

  const list = page.getByRole('list', { name: 'Registros en el mapa' });
  await expect(
    list.getByRole('button', { name: new RegExp(`${PLACED[0][0]} ${stamp}`) }),
  ).toBeVisible();
  const rows = await list
    .getByRole('button')
    .evaluateAll((buttons) =>
      buttons.map((b) => (b.querySelector('span')?.textContent ?? '').trim()),
    );
  expect(rows.length).toBeGreaterThanOrEqual(PLACED.length);

  const map = page.getByRole('region', { name: 'Mapa', exact: true });
  if (renderer === 'svg') {
    // Every row number has exactly one marker with the same number, and no marker is unlisted.
    const markers = await map
      .locator('g[role="button"][aria-label]')
      .evaluateAll((nodes) =>
        nodes.map((node) => /^(\d+)\. /.exec(node.getAttribute('aria-label') ?? '')?.[1] ?? ''),
      );
    expect([...markers].sort()).toEqual([...rows].sort());
  } else {
    await expect(map.locator('[data-map-engine="maplibre"] canvas').first()).toBeVisible();
    // The canvas offers no DOM state for "drawn"; give MapLibre and deck.gl a moment to paint.
    await page.waitForTimeout(2_500);
  }

  const group = page.getByRole('group', { name: /registro\(s\) sin ubicación/ });
  await group.locator('summary').click();
  await expect(group.getByRole('link').first()).toBeVisible();
  const name = (part: string) =>
    path.join(CAPTURE_DIR ?? '', `territorio-mapa-${width}-${colorScheme}-${renderer}-${part}.png`);
  const files: string[] = [];
  const shot = async (part: string, fullPage = false) => {
    const file = name(part);
    await page.screenshot({ path: file, fullPage, animations: 'disabled' });
    files.push(file);
  };
  // What the screen shows first: the map, and beside it on a laptop the numbered list.
  await map.scrollIntoViewIfNeeded();
  await shot('mapa');
  // On a phone the list follows the map; the «sin ubicación» group closes it.
  if (width < 1024) {
    await list.scrollIntoViewIfNeeded();
    await shot('lista');
    await group.scrollIntoViewIfNeeded();
    await shot('sin-ubicacion');
  }
  // A full-page capture resizes the viewport, which clears a WebGL canvas, so only the SVG
  // renderer is captured whole.
  if (renderer === 'svg') await shot('pagina', true);
  return files;
};
