import type { Page } from '@playwright/test';
import { MODULES, type RecordModule } from '../../web/src/features/records/modules.ts';
import { expect } from './fixtures.ts';

/**
 * Where each record module lives in the SPA: its screen and, when the screen hosts several
 * modules, the toggle that selects it (docs: odd/tasks/full-functionality.md S2).
 */
export const RECORD_SCREENS: ReadonlyArray<{
  module: RecordModule;
  path: string;
  toggle?: string;
}> = [
  { module: 'eventos', path: '/eventos' },
  { module: 'actores', path: '/actores' },
  { module: 'directorio', path: '/directorio' },
  { module: 'demandas', path: '/demandas' },
  { module: 'compromisos', path: '/demandas', toggle: 'Compromisos' },
  { module: 'narrativas', path: '/narrativas' },
  { module: 'fuentes', path: '/fuentes' },
  { module: 'alertas', path: '/alertas', toggle: 'Alertas territoriales' },
  { module: 'acciones', path: '/alertas', toggle: 'Acciones territoriales' },
  { module: 'intereses', path: '/estrategia', toggle: 'Intereses' },
  { module: 'dialogos', path: '/estrategia', toggle: 'Diálogos' },
  { module: 'oportunidades', path: '/estrategia', toggle: 'Oportunidades' },
  { module: 'hechos', path: '/estrategia', toggle: 'Hechos por verificar' },
  { module: 'aarc', path: '/estrategia', toggle: 'AARC' },
];

const requiredField = (module: RecordModule) => {
  const field = MODULES[module].fields.find((item) => item.required);
  if (!field) throw new Error(`${module} has no required field`);
  return field;
};

/** Opens the module's list on its own screen. */
export const openModule = async (page: Page, target: (typeof RECORD_SCREENS)[number]) => {
  await page.goto(target.path);
  if (target.toggle) {
    const toggle = page.getByRole('button', { name: target.toggle, exact: true });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  }
  await expect(page.getByRole('button', { name: 'Nuevo registro' })).toBeVisible();
};

/**
 * One record through every list action, as a person does it: create, find it in the list and
 * by search, read its card, edit it from the card, return to the list and delete it.
 */
export const recordJourney = async (
  page: Page,
  target: (typeof RECORD_SCREENS)[number],
  stamp: string,
) => {
  const field = requiredField(target.module);
  const title = `E2E ${target.module} ${stamp}`;
  const edited = `${title} editado`;
  await openModule(page, target);

  // Create
  await page.getByRole('button', { name: 'Nuevo registro' }).click();
  const form = page.getByRole('form', { name: 'Nuevo registro' });
  await form.getByLabel(field.label, { exact: true }).fill(title);
  await form.getByRole('button', { name: 'Guardar registro' }).click();
  await expect(page.getByText(/^Registro .+ guardado\./)).toBeVisible();
  const row = page.getByRole('row').filter({ hasText: title });
  await expect(row).toHaveCount(1);
  const view = row.getByRole('button', { name: /^Ver / });
  const id = ((await view.getAttribute('aria-label')) ?? '').replace(/^Ver /, '');
  expect(id, `${target.module} id`).not.toBe('');

  // Search narrows the list to it.
  await page.getByLabel('Buscar registros').fill(stamp);
  await page.getByRole('button', { name: 'Buscar' }).click();
  await expect(page.getByRole('button', { name: `Ver ${id}` })).toBeVisible();

  // Read, then edit from the card.
  await page.getByRole('button', { name: `Ver ${id}` }).click();
  await expect(page.getByRole('heading', { name: `Ficha ${id}` })).toBeFocused();
  await expect(page.getByText(title, { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Editar', exact: true }).click();
  const editor = page.getByRole('form', { name: 'Editar registro' });
  await expect(editor.getByLabel(field.label, { exact: true })).toHaveValue(title);
  await editor.getByLabel(field.label, { exact: true }).fill(edited);
  await editor.getByRole('button', { name: 'Guardar registro' }).click();
  await expect(page.getByText(`Registro ${id} guardado.`, { exact: false })).toBeVisible();
  const stored = await page.request.get(`/api/${target.module}/${encodeURIComponent(id)}`);
  expect(stored.status()).toBe(200);
  expect(await stored.json()).toMatchObject({ _id: id, [field.key]: edited });

  // Delete with confirmation.
  await page.getByRole('button', { name: `Eliminar ${id}` }).click();
  await page
    .getByRole('alertdialog', { name: 'Eliminar registro' })
    .getByRole('button', { name: 'Confirmar eliminación' })
    .click();
  await expect(page.getByText('Registro eliminado.')).toBeVisible();
  await expect(page.getByRole('button', { name: `Ver ${id}` })).toHaveCount(0);
  expect((await page.request.get(`/api/${target.module}/${encodeURIComponent(id)}`)).status()).toBe(
    404,
  );
};
