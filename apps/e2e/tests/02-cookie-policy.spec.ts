import { type Browser, chromium } from '@playwright/test';
import path from 'node:path';
import { expect, test } from '../support/fixtures.ts';
import {
  type RunningApi,
  expectStartupFailure,
  scratchDir,
  startApi,
  syntheticSecrets,
  webDist,
} from '../support/server.ts';

/**
 * MASCLI_COOKIE_SECURE (docs/secure-cookies.md, ADR 0004): unset or exactly `1` -> Secure,
 * exactly `0` -> not Secure, anything else stops startup. Each case boots its own synthetic
 * instance. A non-loopback host name is mapped to 127.0.0.1 so Chromium applies its real
 * plain-HTTP rules (no localhost exception).
 */
const HOST = 'mascli-e2e.test';

type Instance = { api: RunningApi; admin: { username: string; password: string } };

const boot = async (
  cookieSecure: string | undefined,
): Promise<Instance & { stop(): Promise<void> }> => {
  const scratch = await scratchDir('cookies');
  const secrets = syntheticSecrets();
  const api = await startApi({
    hostname: HOST,
    env: {
      MASCLI_COOKIE_SECURE: cookieSecure,
      // This suite isolates parity/cookie behavior; mandatory MFA has its own browser test.
      MASCLI_REQUIRE_MFA: '0',
      MASCLI_DATA_KEY: secrets.dataKey,
      MASCLI_ADMIN_USERNAME: 'cookie-admin',
      MASCLI_ADMIN_PASSWORD: secrets.adminPassword,
      MASCLI_PGLITE_DIR: path.join(scratch.dir, 'pglite'),
      MASCLI_UPLOAD_DIR: path.join(scratch.dir, 'uploads'),
      MASCLI_WEB_DIR: webDist,
    },
  });
  return {
    api,
    admin: { username: 'cookie-admin', password: secrets.adminPassword },
    stop: async () => {
      await api.stop();
      await scratch.remove();
    },
  };
};

/** Signs in through the SPA over plain HTTP on a non-loopback name; returns the cookie seen. */
const signInOverHttp = async (browser: Browser, instance: Instance) => {
  const context = await browser.newContext({ baseURL: instance.api.url });
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByLabel('Usuario').fill(instance.admin.username);
  await page.getByLabel('Contraseña').fill(instance.admin.password);
  const login = page.waitForResponse(
    (r) => r.url().endsWith('/login') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Ingresar' }).click();
  const response = await login;
  return {
    page,
    status: response.status(),
    setCookie: (await response.headerValue('set-cookie')) ?? '',
    stored: (await context.cookies()).filter((c) => c.name === 'mascli_session'),
    close: () => context.close(),
  };
};

test.describe('Secure cookie policy and exact 0|1 override (S7)', () => {
  let browser: Browser;
  test.beforeAll(async () => {
    browser = await chromium.launch({ args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1`] });
  });
  test.afterAll(async () => browser.close());

  for (const value of [undefined, '1']) {
    test(`MASCLI_COOKIE_SECURE=${value ?? '(unset)'} marks cookies Secure, so plain HTTP keeps no session`, async () => {
      const instance = await boot(value);
      try {
        const run = await signInOverHttp(browser, instance);
        expect(run.status).toBe(200);
        expect(run.setCookie).toContain('Secure');
        expect(run.setCookie).toContain('HttpOnly');
        expect(run.setCookie).toContain('SameSite=Strict');
        // Chromium refuses a Secure cookie from an insecure origin: no session is established.
        expect(run.stored).toEqual([]);
        await expect(
          run.page.getByRole('heading', { name: 'Ingresar a MASCLI 4.0' }),
        ).toBeVisible();
        await run.close();
      } finally {
        await instance.stop();
      }
    });
  }

  test('MASCLI_COOKIE_SECURE=0 drops Secure for intentional local HTTP only', async () => {
    const instance = await boot('0');
    try {
      const run = await signInOverHttp(browser, instance);
      expect(run.status).toBe(200);
      expect(run.setCookie).not.toContain('Secure');
      expect(run.setCookie).toContain('HttpOnly');
      expect(run.stored).toHaveLength(1);
      expect(run.stored[0]).toMatchObject({ secure: false, httpOnly: true, sameSite: 'Strict' });
      await expect(
        run.page.getByRole('heading', { level: 1, name: 'Dashboard ejecutivo' }),
      ).toBeVisible();

      // The project cookie follows the same policy (browser fetch: same origin, real cookie jar).
      const status = await run.page.evaluate(async () => {
        const response = await fetch('/select-project', {
          method: 'POST',
          body: new URLSearchParams({ scope: 'MASCLI/PRJ-SECHURA' }),
          redirect: 'manual',
        });
        return response.type === 'opaqueredirect' ? 303 : response.status;
      });
      expect(status).toBe(303);
      const scopeCookie = (await run.page.context().cookies()).find(
        (c) => c.name === 'mascli_scope',
      );
      expect(scopeCookie).toMatchObject({
        value: encodeURIComponent('MASCLI/PRJ-SECHURA'),
        secure: false,
        httpOnly: true,
        sameSite: 'Strict',
      });
      await run.close();
    } finally {
      await instance.stop();
    }
  });

  for (const value of ['', 'true', 'yes', '01', ' 1', '2']) {
    test(`refuses to start with MASCLI_COOKIE_SECURE=${JSON.stringify(value)}`, async () => {
      const result = await expectStartupFailure({
        MASCLI_COOKIE_SECURE: value,
        MASCLI_DATA_KEY: syntheticSecrets().dataKey,
        MASCLI_ADMIN_PASSWORD: syntheticSecrets().adminPassword,
        MASCLI_PGLITE_DIR: path.join(test.info().outputDir, 'never-created'),
      });
      expect(result.code).not.toBe(0);
      expect(result.code).not.toBeNull();
      expect(result.output).toContain("MASCLI_COOKIE_SECURE must be unset or exactly '0' or '1'");
      // Configuration is validated before any resource is created.
      expect(result.output).not.toContain('PGlite');
    });
  }
});
