import type { Page } from '@playwright/test';
import { analyzeAccessibility } from '../support/accessibility.ts';
import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';

/**
 * Registros type tabs on a phone (closure-roadmap T31, direction 01): at 360 and 412 px, in light
 * and dark, Eventos and Actores list the same two-line rows as Todos instead of a wide table.
 * Each row is one 44 px target that opens the record sheet, `?ficha=` reopens it after a reload,
 * a row shows only what its record has, and nothing scrolls sideways.
 */
const WIDTHS = [360, 412] as const;

const seed = async (page: Page, stamp: number) => {
  const headers = { 'X-SIPGES-Scope': DEFAULT_SCOPE, Origin: new URL(page.url()).origin };
  const records = {
    eventos: {
      ID_Evento: `EV-T-${stamp}`,
      Fecha: '2026-10-14',
      Territorio: 'Vice, Sechura',
      Descripcion_Hecho: `Asamblea sintética por el acta de agua pendiente de firma ${stamp}`,
      Nivel_Verificacion: 'B - Corroborada',
      Estado_Validacion: 'En revisión',
    },
    actores: {
      ID_Actor: `A-T-${stamp}`,
      'Nombre_Actor/Organizacion': `Colectivo sintético de pescadores artesanales ${stamp}`,
    },
  } as const;
  for (const [module, payload] of Object.entries(records)) {
    const created = await page.request.post(`/api/${module}`, { headers, data: { payload } });
    expect(created.status(), await created.text()).toBe(200);
  }
  return records;
};

/** Narrows the type screen to this run's records with its own search. */
const search = async (page: Page, stamp: number) => {
  await page.getByLabel('Buscar registros').fill(String(stamp));
  await page.locator('#contenido').getByRole('button', { name: 'Buscar', exact: true }).tap();
};

const expectFits = async (page: Page, where: string) => {
  const sideways = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(sideways, `${where} scrolls sideways`).toBeLessThanOrEqual(0);
};

for (const colorScheme of ['light', 'dark'] as const) {
  test(`Registros type tabs list two-line rows at 360 and 412 px (${colorScheme})`, async ({
    page,
    admin,
  }) => {
    test.setTimeout(120_000);
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await page.setViewportSize({ width: WIDTHS[0], height: 800 });
    await signInToProject(page, admin, DEFAULT_SCOPE);
    const stamp = Date.now();
    const { eventos, actores } = await seed(page, stamp);
    const eventId = eventos.ID_Evento;
    const sheet = page.getByRole('dialog', { name: `Ficha ${eventId}` });

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 800 });
      const where = `Eventos at ${width}px (${colorScheme})`;
      await page.goto('/registros?tipo=eventos');
      await search(page, stamp);
      const list = page.getByRole('list', { name: 'Registros de eventos del proyecto activo' });
      const row = list.getByRole('button', { name: new RegExp(`^Abrir ${eventId}: `) });
      await expect(row).toBeVisible();
      await expect(page.getByRole('region', { name: 'Tabla de eventos' })).toHaveCount(0);
      await expect(row.locator('[data-line="meta"]')).toContainText(
        'Eventos · Vice, Sechura · 2026-10-14',
      );
      await expect(row.locator('[data-verification="B"]')).toBeVisible();
      await expect(row.getByText('En revisión')).toBeVisible();
      const target = await row.boundingBox();
      const item = await row.locator('xpath=..').boundingBox();
      expect(target?.height ?? 0).toBeGreaterThanOrEqual(44);
      expect(target?.width).toBeCloseTo(item?.width ?? 0, 0);
      await expectFits(page, where);
      const { violations } = await analyzeAccessibility(page);
      expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' '))}`)).toEqual(
        [],
      );

      // A tap opens the sheet and names it in the URL; a reload reopens it over the rows.
      await row.tap();
      await expect(sheet).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`tipo=eventos.*ficha=eventos\\.${eventId}`));
      await page.reload();
      await expect(sheet).toBeVisible();
      await expect(sheet.getByText(eventos.Descripcion_Hecho).first()).toBeVisible();
      await expectFits(page, `${where} with the sheet`);
      await page.keyboard.press('Escape');
      await expect(sheet).toBeHidden();
      await expect(page).not.toHaveURL(/ficha=/);

      // Actores: a record without place, date, A–E or status shows its type alone.
      await page.goto('/registros?tipo=actores');
      await search(page, stamp);
      const actor = page
        .getByRole('list', { name: 'Registros de actores del proyecto activo' })
        .getByRole('button', { name: new RegExp(`^Abrir ${actores.ID_Actor}: `) });
      await expect(actor).toBeVisible();
      await expect(actor.locator('[data-line="meta"]')).toHaveText('Actores');
      await expect(actor.locator('[data-verification]')).toHaveCount(0);
      expect((await actor.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
      await expectFits(page, `Actores at ${width}px (${colorScheme})`);
    }
  });
}

/** A compromiso under the Demandas tab: a row tap opens it as a compromiso and `?ficha=` keeps it. */
test('Registros opens a compromiso row of the Demandas tab as its own record on a phone', async ({
  page,
  admin,
}) => {
  await page.setViewportSize({ width: WIDTHS[0], height: 800 });
  await signInToProject(page, admin, DEFAULT_SCOPE);
  const stamp = Date.now();
  const id = `C-T-${stamp}`;
  const description = `Compromiso sintético de mesa técnica ${stamp}`;
  const headers = { 'X-SIPGES-Scope': DEFAULT_SCOPE, Origin: new URL(page.url()).origin };
  const created = await page.request.post('/api/compromisos', {
    headers,
    data: { payload: { ID_Compromiso: id, Descripcion: description, Estado: 'Pendiente' } },
  });
  expect(created.status(), await created.text()).toBe(200);

  await page.goto('/registros?tipo=demandas');
  const compromisos = page.getByRole('button', { name: 'Compromisos', exact: true });
  await compromisos.tap();
  await search(page, stamp);
  await page
    .getByRole('list', { name: 'Registros de compromisos del proyecto activo' })
    .getByRole('button', { name: new RegExp(`^Abrir ${id}: `) })
    .tap();
  const sheet = page.getByRole('dialog', { name: `Ficha ${id}` });
  await expect(sheet.getByText(description).first()).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`tipo=demandas.*ficha=compromisos\\.${id}`));
  await page.reload();
  await expect(sheet.getByText(description).first()).toBeVisible();
  await expect(compromisos).toHaveAttribute('aria-pressed', 'true');
  await expectFits(page, 'Compromiso sheet at 360px');
});
