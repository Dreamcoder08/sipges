import path from 'node:path';
import { expect, test } from '@playwright/test';
import { THROTTLE } from '../../api/src/contexts/identity/domain/login-throttle.ts';
import { usingCleanup } from '../support/cleanup.ts';
import { DEFAULT_SCOPE, apiSession, createAccount, signIn } from '../support/fixtures.ts';
import { scratchDir, startApi, syntheticSecrets, webDist } from '../support/server.ts';

/**
 * Sign-in throttling through the real server and the sign-in form (functional-10 T10, F27;
 * ADR 0004). The rule is the API's own (login-throttle.ts): THROTTLE.maxPerUser failed sign-ins
 * of one username within THROTTLE.windowSeconds block that username, even with the right
 * password, and the answer says when to retry.
 *
 * It runs on its own server: the limit of failures per address is shared by every spec of the
 * suite instance, and this test spends five of them on purpose.
 */
const THROTTLED = 'Demasiados intentos fallidos; intente más tarde';

test('repeated wrong passwords throttle the username, even with the right password', async ({
  browser,
}) => {
  const cleanup = await usingCleanup(async (register) => {
    const scratch = await scratchDir('throttle');
    register(scratch.remove);
    const secrets = syntheticSecrets();
    const admin = { username: 'throttle-admin', password: secrets.adminPassword };
    const api = await startApi({
      hostname: 'localhost',
      env: {
        SIPGES_REQUIRE_MFA: '0',
        SIPGES_DATA_KEY: secrets.dataKey,
        SIPGES_ADMIN_USERNAME: admin.username,
        SIPGES_ADMIN_PASSWORD: admin.password,
        SIPGES_PGLITE_DIR: path.join(scratch.dir, 'pglite'),
        SIPGES_UPLOAD_DIR: path.join(scratch.dir, 'uploads'),
        SIPGES_WEB_DIR: webDist,
        SIPGES_OLLAMA_URL: 'http://127.0.0.1:9',
      },
    });
    register(api.stop);

    // A second account, made before the administrator is throttled, shows the limit is per user.
    const adminApi = await apiSession(api.url, admin);
    register(() => adminApi.dispose());
    const analyst = await createAccount(
      adminApi,
      { username: `throttle-analyst-${Date.now()}`, role: 'analista' },
      [DEFAULT_SCOPE],
    );

    const context = await browser.newContext({ baseURL: api.url });
    register(() => context.close());
    const page = await context.newPage();

    // The documented limit: every failure up to maxPerUser is an ordinary wrong password.
    for (let attempt = 1; attempt <= THROTTLE.maxPerUser; attempt++) {
      const wrong = await signIn(page, { ...admin, password: `wrong-password-${attempt}` });
      expect(wrong.status(), `attempt ${attempt}`).toBe(401);
      await expect(page.getByRole('alert')).toHaveText('Credenciales inválidas');
    }

    // The next attempt is refused before the password is looked at: the right one fails too.
    const blocked = await signIn(page, admin);
    expect(blocked.status()).toBe(429);
    expect(await blocked.json()).toEqual({ detail: THROTTLED });
    // The time window is exposed: retry after the whole window (900 s). The lapse itself is
    // proved with a controlled clock by apps/api/test/identity/auth-http.test.ts («until the
    // window passes») and the Go TestLoginThrottlesAUserAfterFiveFailuresEvenWithTheRightPassword;
    // a real server cannot be made to wait 15 minutes here.
    expect(blocked.headers()['retry-after']).toBe(String(THROTTLE.windowSeconds));
    expect(blocked.headers()['set-cookie']).toBeUndefined();
    await expect(page.getByRole('alert')).toHaveText(THROTTLED);
    await expect(page.getByRole('heading', { name: 'Ingresar a SIPGES' })).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
    expect((await context.cookies()).map((cookie) => cookie.name)).not.toContain('sipges_session');
    expect(await (await page.request.get('/system/auth/me')).json()).toBeNull();

    // A refused attempt does not reopen the door: the right password is still refused.
    const again = await page.request.post('/login', {
      headers: { Origin: new URL(api.url).origin },
      form: { username: admin.username, password: admin.password, otp: '' },
    });
    expect(again.status()).toBe(429);
    expect(again.headers()['retry-after']).toBe(String(THROTTLE.windowSeconds));

    // Another username from the same address is under its own limit and signs in.
    const other = await signIn(page, analyst);
    expect(other.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1, name: 'Inicio' })).toBeVisible();
  });
  await cleanup();
});
