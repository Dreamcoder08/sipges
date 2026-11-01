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
