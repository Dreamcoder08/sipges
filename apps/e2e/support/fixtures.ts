import {
  type APIRequestContext,
  type Page,
  test as base,
  expect,
  request as requestFactory,
} from '@playwright/test';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; run the suite through playwright.config.ts`);
  return value;
};

/** Bootstrap tenant created by the API on an empty installation. */
export const DEFAULT_SCOPE = 'MASCLI/PRJ-SECHURA';

export type Credentials = { readonly username: string; readonly password: string };

/** Starts a same-origin API session (writes must carry this host's Origin, ADR 0004). */
export const apiSession = async (
  baseURL: string,
  credentials: Credentials,
  otp = '',
): Promise<APIRequestContext> => {
  const context = await requestFactory.newContext({
    baseURL,
    extraHTTPHeaders: { Origin: new URL(baseURL).origin },
  });
  const response = await context.post('/login', {
    form: { username: credentials.username, password: credentials.password, otp },
  });
  expect(response.status(), await response.text()).toBe(200);
  return context;
};

/** Signs in through the SPA's own form; resolves once the server has answered POST /login. */
export const signIn = async (page: Page, credentials: Credentials, otp?: string) => {
  const submit = async () => {
    const answered = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/login' && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Ingresar' }).click();
    return answered;
  };
  await page.goto('/login');
  await page.getByLabel('Usuario').fill(credentials.username);
  await page.getByLabel('Contraseña').fill(credentials.password);
  let response = await submit();
  if (otp !== undefined) {
    await page.getByLabel('Código de autenticación').fill(otp);
    response = await submit();
  }
  if (response.ok()) await page.waitForURL((url) => url.pathname !== '/login');
  return response;
};

/**
 * Signs in and makes `scope` the active project: through the selection screen when the account
 * has several projects and none is selected, otherwise through the header switcher (in the
 * project sheet on phones).
 */
export const signInToProject = async (page: Page, credentials: Credentials, scope: string) => {
  await signIn(page, credentials);
  const switcher = page.getByLabel('Proyecto activo');
  const chooser = page.getByRole('heading', { name: 'Seleccione un proyecto' });
  // Phones keep the selector in a sheet opened from the project context (docs/adr/0015).
  const context = page.getByRole('button', { name: /Cambiar de proyecto/ });
  await expect(switcher.or(chooser).or(context)).toBeVisible();
  if (await chooser.isVisible()) {
    await page.getByRole('button', { name: new RegExp(scope.replace('/', '\\/')) }).click();
    await expect(switcher.or(context)).toBeVisible();
  }
  if (await context.isVisible()) {
    await context.click();
    const sheet = page.getByRole('dialog', { name: 'Cambiar de proyecto' });
    if ((await switcher.inputValue()) !== scope) await switcher.selectOption(scope);
    else await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    return;
  }
  if ((await switcher.inputValue()) !== scope) await switcher.selectOption(scope);
  await expect(switcher).toHaveValue(scope);
};

/** Signs out through the account menu, where the action lives on every viewport. */
export const signOut = async (page: Page) => {
  await page.getByRole('button', { name: /^Cuenta de / }).click();
  await page
    .getByRole('dialog', { name: 'Cuenta' })
    .getByRole('button', { name: 'Cerrar sesión' })
    .click();
};

/** Creates a synthetic account through the admin API and grants it the given scopes. */
export const createAccount = async (
  admin: APIRequestContext,
  account: { username: string; role: 'admin' | 'analista' | 'coordinador' | 'consulta' },
  scopes: readonly string[],
): Promise<Credentials> => {
  const password = `e2e-${crypto.randomUUID()}`;
  const created = await admin.post('/system/auth/accounts', {
    // Account routes resolve a project scope like other business routes (tenancy middleware).
    headers: { 'X-MASCLI-Scope': DEFAULT_SCOPE },
    data: { ...account, full_name: `Cuenta ${account.username}`, password },
  });
  expect(created.status(), await created.text()).toBe(200);
  for (const scope of scopes) {
    const [company_id, project_id] = scope.split('/');
    const granted = await admin.post('/system/auth/grants', {
      data: { username: account.username, company_id, project_id },
    });
    expect(granted.status(), await granted.text()).toBe(200);
  }
  return { username: account.username, password };
};

type Fixtures = {
  admin: Credentials;
  adminApi: APIRequestContext;
  /** Fails the test on any CSP violation, page error or console error (auto). */
  browserHygiene: undefined;
};

export const test = base.extend<Fixtures>({
  // Playwright requires object destructuring for the fixture argument, even when empty.
  // eslint-disable-next-line no-empty-pattern
  baseURL: async ({}, use) => use(required('MASCLI_E2E_BASE_URL')),
  // eslint-disable-next-line no-empty-pattern
  admin: async ({}, use) =>
    use({
      username: required('MASCLI_E2E_ADMIN_USERNAME'),
      password: required('MASCLI_E2E_ADMIN_PASSWORD'),
    }),
  adminApi: async ({ baseURL, admin }, use) => {
    const context = await apiSession(baseURL ?? '', admin);
    await use(context);
    await context.dispose();
  },
  browserHygiene: [
    async ({ page }, use, testInfo) => {
      const problems: string[] = [];
      // CDP-injected init scripts are not subject to the page CSP.
      await page.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', (event) => {
          console.error(
            `CSP violation: ${event.violatedDirective} ${event.blockedURI} (${event.effectiveDirective} on ${document.URL}, ${event.sourceFile}:${event.lineNumber})`,
          );
        });
      });
      page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
      page.on('console', (message) => {
        const text = message.text();
        if (/Content Security Policy|CSP violation/i.test(text)) problems.push(`csp: ${text}`);
        // Expected HTTP errors (401/403/404/409...) are asserted by the specs themselves, and a
        // fetch aborted because the test navigated away surfaces as "Failed to fetch".
        else if (
          message.type() === 'error' &&
          !/Failed to load resource|TypeError: Failed to fetch/.test(text)
        )
          problems.push(`console: ${text}`);
      });
      await use(undefined);
      await testInfo.attach('browser-problems', { body: problems.join('\n') || 'none' });
      expect(problems, 'browser hygiene (CSP, page errors, console errors)').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
