import path from 'node:path';
import { analyzeAccessibility } from '../support/accessibility.ts';
import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';

/**
 * Registros › Todos on a phone (closure-roadmap T31 slice 4, direction 01): at 360 and 412 px, in
 * light and dark, two-line rows instead of a squeezed table; the first row shows under the search
 * without scrolling, nothing scrolls sideways, a tap on a row opens its sheet and a reload with
 * `?ficha=` reopens it. With SIPGES_E2E_SCREENSHOT_DIR set, each width and theme is saved there.
 */
const WIDTHS = [360, 412] as const;
const HEIGHT = 640;
const dir = process.env.SIPGES_E2E_SCREENSHOT_DIR;

for (const colorScheme of ['light', 'dark'] as const) {
  test(`Registros lists two-line rows at 360 and 412 px (${colorScheme})`, async ({
    page,
    admin,
  }) => {
    test.setTimeout(90_000);
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await page.setViewportSize({ width: WIDTHS[0], height: HEIGHT });
    await signInToProject(page, admin, DEFAULT_SCOPE);
    const stamp = Date.now();
    const id = `EV-L-${stamp}`;
    const title = `Asamblea sintética de la comunidad sobre el acta pendiente de firma y el agua ${stamp}`;
    const created = await page.request.post('/api/eventos', {
      headers: { 'X-SIPGES-Scope': DEFAULT_SCOPE, Origin: new URL(page.url()).origin },
      data: {
        payload: {
          ID_Evento: id,
          Fecha: '2026-10-12',
          Territorio: 'Vice, Sechura',
          Descripcion_Hecho: title,
          Nivel_Verificacion: 'B - Corroborada',
          Estado_Validacion: 'En revisión',
        },
      },
    });
    expect(created.status(), await created.text()).toBe(200);

    const list = page.getByRole('list', {
      name: 'Registros de todos los tipos del proyecto activo',
    });
    const row = list.getByRole('button', { name: new RegExp(`^Abrir ${id}: `) });
    const sheet = page.getByRole('dialog', { name: `Ficha ${id}` });
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: HEIGHT });
      await page.goto('/registros');
      const first = list.getByRole('listitem').first();
      await expect(first).toBeVisible();
      await expect(page.getByRole('grid')).toHaveCount(0);
      // The first row sits under the search and the filters, inside the first screen.
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      const box = await first.boundingBox();
      const search = await page
        .getByRole('searchbox', { name: 'Buscar en registros' })
        .boundingBox();
      expect(box?.y ?? 0).toBeGreaterThan((search?.y ?? 0) + (search?.height ?? 0));
      expect((box?.y ?? Infinity) + (box?.height ?? 0)).toBeLessThanOrEqual(HEIGHT);
      const sideways = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(sideways, `scrolls sideways at ${width}px`).toBeLessThanOrEqual(0);

      // One tap target per row, at least 44 px, filling its row; the long title is one line.
      await row.scrollIntoViewIfNeeded();
      const target = await row.boundingBox();
      const item = await row.locator('xpath=..').boundingBox();
      expect(target?.height ?? 0).toBeGreaterThanOrEqual(44);
      expect(target?.width).toBeCloseTo(item?.width ?? 0, 0);
      const titleLine = row.locator('[data-line="title"]');
      // Truncated with an ellipsis on one line: wider than its box, no taller than one line.
      const line = await titleLine.evaluate((node) => {
        const box = node.parentElement as HTMLElement;
        return {
          truncated: box.scrollWidth > box.clientWidth,
          lines: box.clientHeight / parseFloat(getComputedStyle(box).lineHeight),
        };
      });
      expect(line.truncated).toBe(true);
      expect(line.lines).toBeLessThan(1.5);
      await expect(row.locator('[data-line="meta"]')).toContainText('Eventos · Vice, Sechura');
      await expect(row.locator('[data-verification="B"]')).toBeVisible();
      // The status sits on line 1, beside the title.
      const badge = await row.getByText('En revisión').boundingBox();
      const titleBox = await titleLine.boundingBox();
      expect(
        Math.abs(
          (badge?.y ?? 0) +
            (badge?.height ?? 0) / 2 -
            ((titleBox?.y ?? 0) + (titleBox?.height ?? 0) / 2),
        ),
      ).toBeLessThan(4);
      if (dir) {
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: path.join(dir, `registros-${width}-${colorScheme}.png`) });
      }
      const { violations } = await analyzeAccessibility(page);
      expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' '))}`)).toEqual(
        [],
      );

      // A tap opens the sheet and names it in the URL; a reload reopens it.
      await row.tap();
      await expect(sheet).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`ficha=eventos\\.${id}`));
      await page.reload();
      await expect(sheet).toBeVisible();
      await expect(sheet.getByText(title).first()).toBeVisible();
      if (dir)
        await page.screenshot({
          path: path.join(dir, `registros-${width}-${colorScheme}-ficha.png`),
        });
      await page.keyboard.press('Escape');
      await expect(sheet).toBeHidden();
      await expect(page).not.toHaveURL(/ficha=/);
    }
  });
}
