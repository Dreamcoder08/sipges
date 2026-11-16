import { analyzeAccessibility } from '../support/accessibility.ts';
import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';

/**
 * Registros › Todos on desktop (closure-roadmap T31 slice 3, direction 02): a dense table with a
 * sticky header and one-line rows, the record in a side panel named in the URL, arrow keys that
 * move the selection, and Escape back to the row. With SIPGES_SCREENSHOT=<file>.png the table
 * with its panel is saved as a 1440×900 screenshot.
 */
test('Registros at 1440 px: dense table, linkable side panel, keyboard selection', async ({
  page,
  admin,
}) => {
  const stamp = Date.now();
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInToProject(page, admin, DEFAULT_SCOPE);
  const long = `Mesa de diálogo sintética con la comunidad sobre el acta pendiente de firma y los compromisos de agua ${stamp}`;
  for (const title of [long, `Hecho corto sintético ${stamp}`]) {
    await page.goto('/registros?tipo=eventos');
    await page.getByRole('button', { name: 'Nuevo registro' }).click();
    await page.getByLabel('Descripción del hecho', { exact: true }).fill(title);
    await page.getByRole('button', { name: 'Guardar registro' }).click();
    await expect(page.getByRole('row').filter({ hasText: title })).toBeVisible();
  }

  await page.goto('/registros?tipo=todos');
  const grid = page.getByRole('grid', { name: 'Registros de todos los tipos del proyecto activo' });
  const row = grid.getByRole('row').filter({ hasText: long });
  const opener = row.getByRole('button', { name: /^Abrir / });
  const density = page.getByRole('group', { name: 'Densidad de filas' });
  // Compacta (36 px) by default on desktop; Cómoda is 44 px. Long titles stay on one line.
  await expect(density.getByRole('button', { name: 'Compacta' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect((await row.boundingBox())?.height).toBeCloseTo(36, 0);
  await density.getByRole('button', { name: 'Cómoda' }).click();
  expect((await row.boundingBox())?.height).toBeCloseTo(44, 0);
  await density.getByRole('button', { name: 'Compacta' }).click();
  await expect(opener).toHaveAccessibleName(new RegExp(long));
  expect(await opener.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
  expect(
    await grid
      .locator('th')
      .first()
      .evaluate((node) => getComputedStyle(node).position),
  ).toBe('sticky');

  // A click anywhere on the row opens it beside the table and names it in the URL.
  await row.getByRole('gridcell').last().click();
  const label = (await opener.textContent()) ?? '';
  const id = /Abrir (\S+): /.exec(label)?.[1] ?? '';
  const panel = page.getByRole('dialog', { name: `Ficha ${id}` });
  await expect(panel).toHaveAttribute('aria-modal', 'false');
  await expect(row).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(new RegExp(`ficha=eventos\\.${id}`));
  const table = await page.getByRole('region', { name: 'Tabla de registros' }).boundingBox();
  const side = await panel.boundingBox();
  expect((table?.x ?? 0) + (table?.width ?? 0)).toBeLessThanOrEqual(side?.x ?? 0);
  await expect(panel.getByText('Historial de cambios')).toBeVisible();
  const { violations } = await analyzeAccessibility(page);
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' '))}`)).toEqual([]);
  const shot = process.env.SIPGES_SCREENSHOT;
  if (shot) await page.screenshot({ path: shot });

  // A reload keeps the record open; Escape closes it and focus lands on its row.
  await page.reload();
  await expect(panel).toBeVisible();
  await expect(row).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(opener).toBeFocused();
  await expect(page).not.toHaveURL(/ficha=/);

  // The arrows move the selection and the panel follows, focus staying in the table.
  await opener.press('Enter');
  await expect(panel).toBeVisible();
  await opener.focus();
  const selected = grid.getByRole('row', { selected: true });
  await page.keyboard.press('Home');
  await expect(grid.getByRole('row').nth(1)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(grid.getByRole('row').nth(2)).toHaveAttribute('aria-selected', 'true');
  await expect(selected).toHaveCount(1);
  await expect(selected.getByRole('button')).toBeFocused();
  await expect(page.getByRole('dialog', { name: /^Ficha / })).toBeVisible();
  await expect(page).toHaveURL(/ficha=/);
});
