import { analyzeAccessibility } from '../support/accessibility.ts';
import type { Locator, Page } from '@playwright/test';
import { DESTINATIONS, hubHref } from '../../web/src/app/navigation.ts';
import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';
import { watchNetwork } from '../support/network.ts';

/**
 * Hub tabs, record pages and open sheets on a phone (functional-closure S11): at 360 and 412 px,
 * in light and dark, the page never scrolls sideways, the key controls sit inside the width and
 * axe finds no WCAG 2.1 AA violation.
 */
const WIDTHS = [360, 412] as const;
const SCHEMES = ['light', 'dark'] as const;
const HUBS = ['/registros', '/territorio', '/bandeja', '/analisis'] as const;

const expectFits = async (page: Page, where: string) => {
  const { scrollWidth, viewport } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, `${where} wider than the viewport`).toBeLessThanOrEqual(viewport);
};

/** The control lies within the width once scrolled to (vertically: page scroll is fine). */
const expectReachable = async (control: Locator, width: number, what: string) => {
  await control.scrollIntoViewIfNeeded();
  await expectWithin(control, width, what);
};

/** Both edges inside the viewport width, as laid out now; polled because chip rows may animate. */
const expectWithin = async (control: Locator, width: number, what: string) => {
  await expect
    .poll(async () => {
      const box = await control.boundingBox();
      // One pixel of slack for subpixel layout (a chip scrolled to the start sits at x ≈ -0.3).
      return box !== null && box.x >= -1 && box.x + box.width <= width + 1;
    }, `${what} lies within ${width}px`)
    .toBe(true);
};

const expectAccessible = async (page: Page, what: string) => {
  const result = await analyzeAccessibility(page);
  expect(
    result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
    `accessibility of ${what}`,
  ).toEqual([]);
};

/** Synthetic records so lists, the map evolution and the record pages have something to show. */
const seed = async (page: Page, stamp: number) => {
  const headers = { 'X-SIPGES-Scope': DEFAULT_SCOPE, Origin: new URL(page.url()).origin };
  const eventId = `EV-M-${stamp}`;
  const description = `Reunión sintética de seguimiento con la comunidad de nombre largo ${stamp}`;
  for (const [module, payload] of [
    [
      'eventos',
      {
        ID_Evento: eventId,
        Fecha: '2026-10-10',
        Territorio: 'Vice, Sechura',
        Descripcion_Hecho: description,
      },
    ],
    [
      'alertas',
      {
        ID_Alerta: `AL-M-${stamp}`,
        Fecha: '2026-10-11',
        Territorio: 'Vice, Sechura',
        Causa: `Alerta sintética por convocatoria a asamblea ${stamp}`,
        Nivel_Preliminar: 'Naranja',
        Estado: 'Abierta',
      },
    ],
  ] as const) {
    const created = await page.request.post(`/api/${module}`, { headers, data: { payload } });
    expect(created.status(), await created.text()).toBe(200);
  }
  return { eventId, description };
};

/**
 * Each tab's address and chip label. Registros is its own hub (RegistrosHub): «Todos» first,
 * then one chip per record type at `?tipo=`.
 */
const tabsOf = (hub: (typeof DESTINATIONS)[number]) =>
  hub.path === '/registros'
    ? [
        { href: '/registros', label: 'Todos' },
        ...hub.tabs.map((tab) => ({ href: `/registros?tipo=${tab.value}`, label: tab.label })),
      ]
    : hub.tabs.map((tab) => ({ href: hubHref(hub, tab.value), label: tab.label }));

/**
 * Opens a surface at 360 px, then checks it there (axe included) and again after widening the
 * same page to 412 px: one navigation serves both widths.
 */
const atBothWidths = async (
  page: Page,
  open: () => Promise<void>,
  check: (width: number, where: string) => Promise<void>,
  what: string,
) => {
  await page.setViewportSize({ width: WIDTHS[0], height: 800 });
  await open();
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 800 });
    const where = `${what} at ${width}px`;
    await expectFits(page, where);
    await check(width, where);
    if (width === WIDTHS[0]) await expectAccessible(page, what);
  }
};

for (const colorScheme of SCHEMES) {
  for (const path of HUBS) {
    const hub = DESTINATIONS.find((item) => item.path === path);
    if (!hub) throw new Error(`Unknown hub ${path}`);
    test(`${hub.label}: every tab fits a phone (${colorScheme})`, async ({ page, admin }) => {
      // Up to eight tabs with an axe pass each.
      test.setTimeout(90_000);
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      await signInToProject(page, admin, DEFAULT_SCOPE);
      await seed(page, Date.now());
      const settled = watchNetwork(page);
      for (const tab of tabsOf(hub)) {
        const current = page
          .getByRole('button', { name: new RegExp(`^${tab.label}(\\s|$)`) })
          .first();
        await atBothWidths(
          page,
          async () => {
            await page.goto(tab.href);
            await expect(page.getByRole('heading', { level: 1, name: hub.label })).toBeVisible();
            await expect(current).toHaveAttribute('aria-pressed', 'true');
            await settled();
          },
          // The chosen tab is shown on arrival, not left cut off at the end of the chip row.
          (width, where) => expectWithin(current, width, `${where}: its tab`),
          `${hub.label} › ${tab.label} (${colorScheme})`,
        );
      }
    });
  }

  test(`record page and open sheets fit a phone (${colorScheme})`, async ({ page, admin }) => {
    test.setTimeout(90_000);
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await signInToProject(page, admin, DEFAULT_SCOPE);
    const { eventId, description } = await seed(page, Date.now());
    const settled = watchNetwork(page);

    // The 360° record page.
    await atBothWidths(
      page,
      async () => {
        await page.goto(`/objeto/eventos/${eventId}`);
        await expect(page.getByRole('region', { name: 'Vínculos' })).toBeVisible();
        await settled();
      },
      (width, where) =>
        expectReachable(page.getByLabel('Clasificación del registro'), width, `${where}: class`),
      `/objeto (${colorScheme})`,
    );

    // Registros › Todos opens the record as a bottom sheet.
    const sheet = page.getByRole('dialog', { name: `Ficha ${eventId}` });
    await atBothWidths(
      page,
      async () => {
        await page.goto('/registros');
        await page.getByRole('button', { name: new RegExp(`^Abrir ${eventId}:`) }).tap();
        await expect(sheet).toBeVisible();
        await settled();
      },
      (width, where) =>
        expectReachable(
          sheet.getByRole('button', { name: /^Cerrar/ }).first(),
          width,
          `${where}: close`,
        ),
      `the record sheet (${colorScheme})`,
    );
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();

    // Territorio › Mapa: the evolution opens the record's map sheet.
    const card = page.getByRole('region', { name: 'Ficha del registro' });
    await atBothWidths(
      page,
      async () => {
        await page.goto('/territorio');
        await page
          .getByRole('list', { name: 'Registros del periodo' })
          .getByRole('button', { name: new RegExp(description) })
          .tap();
        await expect(card.getByRole('heading', { name: description })).toBeVisible();
        await settled();
      },
      (width, where) =>
        expectReachable(
          card.getByRole('button', { name: 'Cerrar ficha' }).first(),
          width,
          `${where}: close`,
        ),
      `the map sheet (${colorScheme})`,
    );

    // Bandeja › Pendientes: choosing an item opens its detail with the decision controls.
    const back = page
      .getByRole('region', { name: 'Detalle del pendiente' })
      .getByRole('button', { name: 'Volver a la lista' });
    await atBothWidths(
      page,
      async () => {
        await page.goto('/bandeja');
        await page.getByRole('option').first().tap();
        await expect(back).toBeVisible();
        await settled();
      },
      (width, where) => expectReachable(back, width, `${where}: back`),
      `the pending detail (${colorScheme})`,
    );
  });
}
