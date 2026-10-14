import type { Page } from '@playwright/test';
import { expect } from './fixtures.ts';

/**
 * Automatizaciones beyond the first rule: edit a rule from the list, pause and reactivate it,
 * add a signed webhook channel and remove both. Every outcome must be in view.
 */
export const automationJourney = async (page: Page, stamp: string) => {
  const notice = (text: string) => page.getByRole('status').filter({ hasText: text });
  const name = `Regla E2E ${stamp}`;
  await page.goto('/automatizaciones');
  await page.getByLabel('Nombre de la regla').fill(name);
  await page.getByRole('button', { name: 'Crear regla' }).click();
  await expect(notice('Regla creada.')).toBeInViewport();
  const item = page.getByRole('listitem').filter({ hasText: name });
  await expect(item).toContainText('Activa');

  await item.getByRole('button', { name: 'Editar' }).click();
  await expect(page.getByText('Editar regla', { exact: true })).toBeFocused();
  await page.getByLabel('Nombre de la regla').fill(`${name} editada`);
  await page.getByRole('button', { name: 'Guardar cambios' }).click();
  await expect(notice('Regla actualizada.')).toBeInViewport();
  const edited = page.getByRole('listitem').filter({ hasText: `${name} editada` });
  await edited.getByRole('button', { name: 'Pausar' }).click();
  await expect(notice('Regla en pausa.')).toBeInViewport();
  await expect(edited).toContainText('En pausa');
  await edited.getByRole('button', { name: 'Activar' }).click();
  await expect(edited).toContainText('Activa');

  const channel = `Canal E2E ${stamp}`;
  await page.getByLabel('Tipo de canal').selectOption('webhook');
  await page.getByLabel('Nombre del canal').fill(channel);
  await page.getByLabel('URL https del receptor').fill('https://hooks.example.org/mascli');
  await page.getByLabel('Secreto de firma').fill(`secreto-sintetico-${stamp}-largo`);
  await page.getByRole('button', { name: 'Crear canal' }).click();
  await expect(notice('Canal creado.')).toBeInViewport();
  // Deleting asks first: cancelling keeps the channel, confirming removes it.
  const confirm = (title: string) => page.getByRole('alertdialog', { name: title });
  await page.getByRole('button', { name: `Eliminar canal ${channel}` }).click();
  await confirm('Eliminar canal').getByRole('button', { name: 'Cancelar' }).click();
  await expect(page.getByText(channel, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: `Eliminar canal ${channel}` }).click();
  await confirm('Eliminar canal').getByRole('button', { name: 'Confirmar eliminación' }).click();
  await expect(notice('Canal eliminado.')).toBeInViewport();
  await expect(confirm('Eliminar canal')).toHaveCount(0);
  await page.getByRole('button', { name: `Eliminar regla ${name} editada` }).click();
  await confirm('Eliminar regla').getByRole('button', { name: 'Confirmar eliminación' }).click();
  await expect(notice('Regla eliminada.')).toBeInViewport();
  await expect(edited).toHaveCount(0);
};
