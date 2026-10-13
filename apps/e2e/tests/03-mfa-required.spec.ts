import path from 'node:path';
import { expect, test } from '@playwright/test';
import { usingCleanup } from '../support/cleanup.ts';
import { scratchDir, startApi, syntheticSecrets, webDist } from '../support/server.ts';
import { totpCode } from '../support/totp.ts';

test('mandatory MFA enrolls before dashboard and requires a code on the next login', async ({
  browser,
}) => {
  const cleanup = await usingCleanup(async (register) => {
    const scratch = await scratchDir('mandatory-mfa');
    register(scratch.remove);
    const secrets = syntheticSecrets();
    const api = await startApi({
      hostname: 'localhost',
      env: {
        MASCLI_REQUIRE_MFA: '1',
        MASCLI_DATA_KEY: secrets.dataKey,
        MASCLI_ADMIN_USERNAME: 'mfa-admin',
        MASCLI_ADMIN_PASSWORD: secrets.adminPassword,
        MASCLI_PGLITE_DIR: path.join(scratch.dir, 'pglite'),
        MASCLI_UPLOAD_DIR: path.join(scratch.dir, 'uploads'),
        MASCLI_WEB_DIR: webDist,
      },
    });
    register(api.stop);
    const context = await browser.newContext({ baseURL: api.url });
    register(() => context.close());
    const page = await context.newPage();
    await page.goto('/login');
    await page.getByLabel('Usuario').fill('mfa-admin');
    await page.getByLabel('Contraseña', { exact: true }).fill(secrets.adminPassword);
    await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Configurar autenticación multifactor' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Preparar autenticador' }).click();
    const secret = await page.locator('code').first().textContent();
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    await page.getByLabel('Código del autenticador').fill(totpCode(secret ?? ''));
    await page.getByRole('button', { name: 'Activar y continuar' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Dashboard ejecutivo' }),
    ).toBeVisible();
    // A fresh browser session cannot inherit the enrolled session's MFA proof.
    await context.clearCookies();
    await page.goto('/login');
    await page.getByLabel('Usuario').fill('mfa-admin');
    await page.getByLabel('Contraseña', { exact: true }).fill(secrets.adminPassword);
    await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Dashboard ejecutivo' }),
    ).not.toBeVisible();
  });
  await cleanup();
});
