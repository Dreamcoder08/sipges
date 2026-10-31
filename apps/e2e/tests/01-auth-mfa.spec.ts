import type { Page } from '@playwright/test';
import {
  DEFAULT_SCOPE,
  createAccount,
  expect,
  signIn,
  signOut,
  test,
} from '../support/fixtures.ts';
import { totpCode } from '../support/totp.ts';

const dashboard = (page: Page) =>
  page.getByRole('heading', { level: 1, name: 'Dashboard ejecutivo' });

test.describe('sign-in (S7, ADR 0004)', () => {
  test('rejects a wrong password and signs in with the right one', async ({ page, admin }) => {
    await signIn(page, { username: admin.username, password: 'wrong-password-123' });
    await expect(page.getByRole('alert')).toHaveText('Credenciales inválidas');
    await expect(page.getByLabel('Código de autenticación')).toHaveCount(0);

    await page.getByLabel('Contraseña').fill(admin.password);
    await page.getByRole('button', { name: 'Ingresar' }).click();
    await expect(dashboard(page)).toBeVisible();
    await expect(page.getByText('Administración E2E')).toBeVisible();
  });

  test('issues an HttpOnly, SameSite=Strict, Secure session cookie by default', async ({
    page,
    admin,
    context,
  }) => {
    const login = page.waitForResponse(
      (r) => r.url().endsWith('/login') && r.request().method() === 'POST',
    );
    await signIn(page, admin);
    const setCookie = (await (await login).headerValue('set-cookie')) ?? '';
    expect(setCookie).toMatch(/^mascli_session=[0-9a-f]{64};/);
    expect(setCookie).toContain('Max-Age=28800');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Strict');
    await expect(dashboard(page)).toBeVisible();

    const session = (await context.cookies()).find((c) => c.name === 'mascli_session');
    expect(session).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict' });
    // HttpOnly: the SPA's JavaScript cannot read the session.
    expect(await page.evaluate(() => document.cookie)).not.toContain('mascli_session');
  });

  test('returns to the requested screen after sign-in and ignores foreign redirects', async ({
    page,
    admin,
    baseURL,
  }) => {
    const submit = async () => {
      await page.getByLabel('Usuario').fill(admin.username);
      await page.getByLabel('Contraseña').fill(admin.password);
      await page.getByRole('button', { name: 'Ingresar' }).click();
    };
    await page.goto('/fuentes');
    await expect(page).toHaveURL(/\/login\?redirect=/);
    await submit();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Fuentes y evidencias' }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/fuentes$/);

    await page.context().clearCookies();
    await page.goto('/login?redirect=//attacker.example/steal');
    await submit();
    await expect(dashboard(page)).toBeVisible();
    expect(new URL(page.url()).origin).toBe(new URL(baseURL ?? '').origin);
  });

  test('signs out and revokes the session server-side', async ({ page, admin }) => {
    await signIn(page, admin);
    await expect(dashboard(page)).toBeVisible();
    const token = (await page.context().cookies()).find((c) => c.name === 'mascli_session');
    await signOut(page);
    await expect(page.getByRole('heading', { name: 'Ingresar a MASCLI 4.0' })).toBeVisible();

    // Replaying the old token must not authenticate any more.
    await page.context().addCookies([{ ...(token ?? { name: '', value: '', url: '' }) }]);
    const me = await page.request.get('/system/auth/me');
    expect(await me.json()).toBeNull();
  });
});

test.describe('MFA enrollment and TOTP sign-in (S7)', () => {
  test('enrolls TOTP, refuses re-enrollment and then requires the code', async ({
    page,
    adminApi,
    baseURL,
  }) => {
    const analyst = await createAccount(
      adminApi,
      { username: `e2e-mfa-${Date.now()}`, role: 'analista' },
      [DEFAULT_SCOPE],
    );
    await signIn(page, analyst);
    await expect(dashboard(page)).toBeVisible();

    await page.goto('/administracion');
    await page.getByRole('button', { name: 'Configurar mi MFA' }).click();
    const secret = (await page.locator('code').first().textContent())?.trim() ?? '';
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    await page.getByText('URI para la aplicación autenticadora').click();
    await expect(page.getByText(/^otpauth:\/\/totp\/MASCLI:/)).toBeVisible();

    await page.getByLabel('Código TOTP').fill('000000' === totpCode(secret) ? '111111' : '000000');
    await page.getByRole('button', { name: 'Activar MFA' }).click();
    await expect(page.getByRole('alert')).toHaveText('Código TOTP incorrecto');

    const enabledAt = Date.now();
    await page.getByLabel('Código TOTP').fill(totpCode(secret, enabledAt));
    await page.getByRole('button', { name: 'Activar MFA' }).click();
    await expect(page.getByText('MFA activado.')).toBeVisible();
    await expect(page.getByText(secret)).toHaveCount(0);

    // Enrollment guard (reference/python/docs/mfa-enrollment.md): the retained session cannot replace the secret.
    const origin = { Origin: new URL(baseURL ?? '').origin };
    const again = await page.request.post('/system/auth/totp/setup', { headers: origin });
    expect(again.status()).toBe(409);
    const body = await again.text();
    expect(body).not.toContain('otpauth');
    expect(body).not.toContain('secret');

    await signOut(page);
    await expect(page.getByRole('heading', { name: 'Ingresar a MASCLI 4.0' })).toBeVisible();

    // Password alone is no longer enough: the form asks for the second factor.
    await signIn(page, analyst);
    await expect(page.getByRole('alert')).toHaveText('Código de autenticación inválido');
    await page.getByLabel('Código de autenticación').fill('123456x');
    await expect(page.getByLabel('Código de autenticación')).toHaveValue('123456');

    // The enabling step is spent (replay guard); the authenticator's next code is accepted.
    const next = totpCode(secret, enabledAt + 30_000);
    await page.getByLabel('Código de autenticación').fill(next);
    await page.getByRole('button', { name: 'Ingresar' }).click();
    await expect(dashboard(page)).toBeVisible();

    // The same code cannot be replayed for a second sign-in.
    const replay = await page.request.post('/login', {
      headers: origin,
      form: { username: analyst.username, password: analyst.password, otp: next },
    });
    expect(replay.status()).toBe(401);
  });
});
