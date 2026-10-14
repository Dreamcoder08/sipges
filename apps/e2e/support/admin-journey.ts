import type { Page } from '@playwright/test';
import { DEFAULT_SCOPE, expect } from './fixtures.ts';

/**
 * Administración end to end: create an account, link its Google address, create a project,
 * grant and revoke access with confirmation, and deactivate the account. Every outcome must be
 * visible where the person is looking, not only at the top of a long page.
 */
export const adminJourney = async (page: Page, stamp: string) => {
  const username = `cuenta-${stamp}`;
  const [company] = DEFAULT_SCOPE.split('/');
  const project = `PRJ-${stamp.toUpperCase()}`;
  const notice = (text: string) => page.getByRole('status').filter({ hasText: text });
  await page.goto('/administracion');

  await page.getByLabel('Usuario nuevo').fill(username);
  await page.getByLabel('Nombre completo').fill('Cuenta sintética');
  await page.getByLabel('Contraseña inicial').fill(`clave-${stamp}-segura`);
  await page.getByLabel('Rol de la cuenta').selectOption('analista');
  await page.getByRole('button', { name: 'Crear cuenta' }).click();
  await expect(notice('Cuenta creada.')).toBeInViewport();
  const accountRow = page.getByRole('row').filter({ hasText: username });
  await expect(accountRow).toContainText('analista');

  await page.getByLabel('Usuario a vincular').fill(username);
  await page.getByLabel('Correo de Google').fill(`${stamp}@example.org`);
  await page.getByRole('button', { name: 'Guardar vínculo' }).click();
  await expect(notice('ya puede entrar con Google')).toBeInViewport();
  await expect(accountRow).toContainText(`${stamp}@example.org`);

  await page.getByLabel('Empresa nueva').fill(company ?? '');
  await page.getByLabel('Proyecto nuevo').fill(project);
  await page.getByLabel('Nombre del proyecto').fill(`Proyecto sintético ${stamp}`);
  await page.getByLabel('Usuario con acceso inicial').fill(username);
  await page.getByRole('button', { name: 'Crear proyecto' }).click();
  await expect(notice('Proyecto creado con acceso inicial.')).toBeInViewport();

  await page.getByLabel('Usuario del acceso').fill(username);
  await page.getByLabel('Empresa del acceso').fill(company ?? '');
  await page.getByLabel('Proyecto del acceso').fill(DEFAULT_SCOPE.split('/')[1] ?? '');
  await page.getByRole('button', { name: 'Conceder acceso' }).click();
  await expect(notice('Acceso concedido.')).toBeInViewport();

  await page.getByRole('button', { name: 'Revocar acceso' }).click();
  const confirm = page.getByRole('button', { name: 'Confirmar revocación' });
  await expect(confirm).toBeInViewport();
  await confirm.click();
  await expect(notice('Acceso revocado.')).toBeInViewport();

  await accountRow.getByRole('button', { name: `Desactivar ${username}` }).click();
  const deactivate = page.getByRole('button', { name: 'Confirmar desactivación' });
  await expect(deactivate).toBeInViewport();
  await deactivate.click();
  await expect(notice('Cuenta desactivada y sesiones revocadas.')).toBeInViewport();
  await expect(accountRow).toContainText('Inactiva');
};
