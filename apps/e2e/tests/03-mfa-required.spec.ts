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
        SIPGES_REQUIRE_MFA: '1',
        SIPGES_DATA_KEY: secrets.dataKey,
        SIPGES_ADMIN_USERNAME: 'mfa-admin',
        SIPGES_ADMIN_PASSWORD: secrets.adminPassword,
        SIPGES_PGLITE_DIR: path.join(scratch.dir, 'pglite'),
        SIPGES_UPLOAD_DIR: path.join(scratch.dir, 'uploads'),
        SIPGES_WEB_DIR: webDist,
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
    await expect(page.getByRole('heading', { level: 1, name: 'Inicio' })).toBeVisible();
    // A fresh browser session cannot inherit the enrolled session's MFA proof.
    await context.clearCookies();
    await page.goto('/login');
    await page.getByLabel('Usuario').fill('mfa-admin');
    await page.getByLabel('Contraseña', { exact: true }).fill(secrets.adminPassword);
    await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
    await expect(page.getByLabel('Código de autenticación')).toBeVisible();
    // Enrollment consumes the current counter; the accepted adjacent interval is distinct.
    await page
      .getByLabel('Código de autenticación')
      .fill(totpCode(secret ?? '', Date.now() + 30_000));
    await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Inicio' })).toBeVisible();
  });
  await cleanup();
});
