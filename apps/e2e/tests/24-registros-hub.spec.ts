import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';

/**
 * Registros hub (odd/tasks/workspace-architecture.md T3, S3/S6): one list with type chips,
 * a side sheet for the record, and a density choice that never touches localStorage.
 */
test('Registros lists a new record, opens it in a side sheet and keeps density in the tab', async ({
  page,
  admin,
}) => {
  const name = `Fuente hub ${Date.now()}`;
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await page.goto('/registros?tipo=fuentes');
  const types = page.getByRole('group', { name: 'Tipo de registro' });
  await expect(types.getByRole('button', { name: /^Fuentes/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await page.getByRole('button', { name: 'Nuevo registro' }).click();
  await page.getByLabel('Nombre de la fuente o documento').fill(name);
  await page.getByLabel('Tipo de fuente').selectOption('Acta');
  await page.getByRole('button', { name: 'Guardar registro' }).click();
  const created = page.getByRole('row').filter({ hasText: name });
  await expect(created).toBeVisible();
  const label =
    (await created.getByRole('button', { name: /^Ver / }).getAttribute('aria-label')) ?? '';
  const id = label.replace(/^Ver /, '');

  // The cross-type list shows it, and the sheet opens beside the list.
  await types.getByRole('button', { name: /^Todos/ }).click();
  await expect(page).toHaveURL(/tipo=todos/);
  const opener = page.getByRole('button', { name: new RegExp(`Abrir ${id}`) });
  await opener.click();
  const sheet = page.getByRole('dialog', { name: `Ficha ${id}` });
  await expect(sheet.getByRole('link', { name: 'Abrir ficha completa' })).toHaveAttribute(
    'href',
    `/objeto/fuentes/${id}`,
  );
  await expect(sheet.getByText('Historial de cambios')).toBeVisible();
  // At the default 1280 px the sheet docks beside the list instead of covering it.
  await expect(sheet).toHaveAttribute('aria-modal', 'false');
  await expect(opener).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(opener).toBeFocused();

  // Density is remembered for the tab only.
  await page
    .getByRole('group', { name: 'Densidad de filas' })
    .getByRole('button', { name: 'Compacta' })
    .click();
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  expect(await page.evaluate(() => sessionStorage.length)).toBeGreaterThan(0);
});

/**
 * Visual fidelity to design/workspace-architecture/03-registros-unificado.html: the filters are
 * one toolbar row, the table sits on the page, and the sheet docks to the right of the list.
 * With SIPGES_SCREENSHOT=<file>.png the list and the docked sheet are saved as 1440×900
 * screenshots (<file>.png and <file>-sheet.png).
 */
test('Registros keeps its filters in one toolbar row and docks the sheet at 1440 px', async ({
  page,
  admin,
}) => {
  const stamp = Date.now();
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInToProject(page, admin, DEFAULT_SCOPE);
  const records = [
    ['eventos', 'Descripción del hecho', `Bloqueo del muelle de Bayóvar ${stamp}`],
    ['actores', 'Nombre del actor u organización', `Federación de Pescadores ${stamp}`],
    ['fuentes', 'Nombre de la fuente o documento', `Informe de la Defensoría ${stamp}`],
  ] as const;
  for (const [type, label, title] of records) {
    await page.goto(`/registros?tipo=${type}`);
    await page.getByRole('button', { name: 'Nuevo registro' }).click();
    await page.getByLabel(label, { exact: true }).fill(title);
    await page.getByRole('button', { name: 'Guardar registro' }).click();
    await expect(page.getByRole('row').filter({ hasText: title })).toBeVisible();
  }

  await page.goto('/registros?tipo=todos');
  const toolbar = page.getByRole('group', { name: 'Filtros de registros' });
  const centres = await Promise.all(
    [
      toolbar.getByRole('searchbox', { name: 'Buscar en registros' }),
      toolbar.getByRole('group', { name: 'Verificación A a E' }),
      toolbar.getByRole('group', { name: 'Validación' }),
      toolbar.getByRole('group', { name: 'Densidad de filas' }),
      toolbar.getByRole('status'),
    ].map(async (item) => {
      const box = await item.boundingBox();
      return (box?.y ?? -100) + (box?.height ?? 0) / 2;
    }),
  );
  // One row: every control's vertical centre sits within half a control height of the others.
  expect(Math.max(...centres) - Math.min(...centres), centres.join(', ')).toBeLessThan(16);
  await expect(page.getByRole('heading', { name: 'Todos los registros' })).toHaveCount(0);

  const shot = process.env.SIPGES_SCREENSHOT;
  if (shot) await page.screenshot({ path: shot });

  await page
    .getByRole('button', { name: /Abrir .*/ })
    .first()
    .click();
  const sheet = page.getByRole('dialog', { name: /^Ficha / });
  await expect(sheet).toBeVisible();
  const table = await page.getByRole('region', { name: 'Tabla de registros' }).boundingBox();
  const docked = await sheet.boundingBox();
  expect((table?.x ?? 0) + (table?.width ?? 0)).toBeLessThanOrEqual(docked?.x ?? 0);
  // The list is still usable: another row replaces the record in the sheet.
  const other = page.getByRole('button', { name: /Abrir .*/ }).nth(1);
  await other.click();
  await expect(sheet).toHaveCount(1);
  await expect(sheet.getByRole('heading', { name: /^Ficha / })).toBeVisible();
  if (shot) await page.screenshot({ path: shot.replace(/\.png$/, '-sheet.png') });
});
