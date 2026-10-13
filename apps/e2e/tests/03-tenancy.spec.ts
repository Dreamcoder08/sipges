import { readFile } from 'node:fs/promises';
import type { APIRequestContext, Page } from '@playwright/test';
import {
  DEFAULT_SCOPE,
  apiSession,
  createAccount,
  expect,
  signIn,
  signInToProject,
  test,
} from '../support/fixtures.ts';

/**
 * Two synthetic tenants (S7, S8): the bootstrap MASCLI/PRJ-SECHURA and a second project created
 * through the administration screen. The specs build on each other, so they run serially.
 */
test.describe.configure({ mode: 'serial' });

const NORTE = 'E2E/PRJ-NORTE';
const NORTE_LABEL = 'Proyecto Norte E2E';
const MARKER = { sechura: `marca-sechura-${Date.now()}`, norte: `marca-norte-${Date.now()}` };

const scoped = (scope: string) => ({ 'X-MASCLI-Scope': scope });

const createEvent = async (api: APIRequestContext, scope: string, description: string) => {
  const response = await api.post('/api/eventos', {
    headers: scoped(scope),
    data: { payload: { Descripcion: description, Territorio: 'Territorio sintético' } },
  });
  expect(response.status(), await response.text()).toBe(200);
  return ((await response.json()) as { id: string }).id;
};

const switchProject = async (page: Page, scope: string) => {
  const switched = page.waitForResponse(
    (r) => r.url().endsWith('/select-project') && r.request().method() === 'POST',
  );
  await page.getByLabel('Proyecto activo').selectOption(scope);
  expect((await switched).status()).toBeLessThan(400);
  await expect(page.getByLabel('Proyecto activo')).toHaveValue(scope);
};

test('an administrator creates a second project and switches to it server-side', async ({
  page,
  admin,
}) => {
  await signIn(page, admin);
  await page.goto('/administracion');
  await page.getByLabel('Empresa nueva').fill('E2E');
  await page.getByLabel('Proyecto nuevo').fill('PRJ-NORTE');
  await page.getByLabel('Nombre del proyecto').fill(NORTE_LABEL);
  await page.getByLabel('Usuario con acceso inicial').fill(admin.username);
  await page.getByRole('button', { name: 'Crear proyecto' }).click();
  await expect(page.getByText('Proyecto creado con acceso inicial.')).toBeVisible();
  await expect(page.getByLabel('Proyecto activo').locator('option')).toHaveCount(2);

  await switchProject(page, NORTE);
  await expect(page.getByText(`Proyecto activo: ${NORTE_LABEL} (${NORTE})`)).toBeVisible();

  // The server owns the selection: a cookie-only request (no X-MASCLI-Scope) sees the new scope.
  const current = await page.request.get('/system/auth/current-scope');
  expect(await current.json()).toEqual({
    company_id: 'E2E',
    project_id: 'PRJ-NORTE',
    scope: NORTE,
  });
  const cookie = (await page.context().cookies()).find((c) => c.name === 'mascli_scope');
  expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict' });
  expect(await page.evaluate(() => localStorage.length)).toBe(0);

  await page.reload();
  await expect(page.getByLabel('Proyecto activo')).toHaveValue(NORTE);
});

test('records created in one project never appear in the other', async ({ page, admin }) => {
  await signInToProject(page, admin, NORTE);
  await page.goto('/eventos');
  await page.getByRole('button', { name: 'Nuevo registro' }).click();
  await page.getByLabel('Descripción del hecho').fill(MARKER.norte);
  await page.getByRole('button', { name: 'Guardar registro' }).click();
  await expect(page.getByRole('cell', { name: MARKER.norte })).toBeVisible();

  await switchProject(page, DEFAULT_SCOPE);
  await expect(page.getByRole('heading', { level: 1, name: 'Eventos' })).toBeVisible();
  await page.getByRole('button', { name: 'Nuevo registro' }).click();
  await page.getByLabel('Descripción del hecho').fill(MARKER.sechura);
  await page.getByRole('button', { name: 'Guardar registro' }).click();
  await expect(page.getByRole('cell', { name: MARKER.sechura })).toBeVisible();
  await expect(page.getByText(MARKER.norte)).toHaveCount(0);

  await switchProject(page, NORTE);
  await expect(page.getByRole('cell', { name: MARKER.norte })).toBeVisible();
  await expect(page.getByText(MARKER.sechura)).toHaveCount(0);
});

test('cross-tenant access is refused with 403 (scope) and 404 (foreign ids)', async ({
  page,
  adminApi,
  baseURL,
}) => {
  const norteEvent = await createEvent(adminApi, NORTE, 'Registro sintético del norte');
  const upload = await adminApi.post('/system/uploads', {
    headers: scoped(NORTE),
    multipart: {
      file: { name: 'acta-norte.txt', mimeType: 'text/plain', buffer: Buffer.from('acta norte') },
      linked_module: 'eventos',
      linked_record_id: norteEvent,
    },
  });
  expect(upload.status(), await upload.text()).toBe(200);
  const attachmentId = ((await upload.json()) as { attachment: { id: string } }).attachment.id;

  // Positive control: the owning tenant reads both.
  expect(
    (await adminApi.get(`/api/eventos/${norteEvent}`, { headers: scoped(NORTE) })).status(),
  ).toBe(200);
  const own = await adminApi.get(`/system/uploads/${attachmentId}/download`, {
    headers: scoped(NORTE),
  });
  expect(await own.text()).toBe('acta norte');

  // Another tenant the same admin is granted: foreign ids do not exist there (404).
  const sechura = scoped(DEFAULT_SCOPE);
  expect((await adminApi.get(`/api/eventos/${norteEvent}`, { headers: sechura })).status()).toBe(
    404,
  );
  expect(
    (
      await adminApi.put(`/api/eventos/${norteEvent}`, {
        headers: sechura,
        data: { payload: { Descripcion: 'x' } },
      })
    ).status(),
  ).toBe(404);
  expect((await adminApi.delete(`/api/eventos/${norteEvent}`, { headers: sechura })).status()).toBe(
    404,
  );
  expect(
    (await adminApi.get(`/system/uploads/${attachmentId}`, { headers: sechura })).status(),
  ).toBe(404);
  expect(
    (await adminApi.get(`/system/uploads/${attachmentId}/download`, { headers: sechura })).status(),
  ).toBe(404);
  const listed = await adminApi.get('/api/eventos?limit=500', { headers: sechura });
  expect(JSON.stringify(await listed.json())).not.toContain(norteEvent);

  // A user granted only PRJ-SECHURA cannot reach PRJ-NORTE in any way (403).
  const analyst = await createAccount(
    adminApi,
    { username: `e2e-tenant-${Date.now()}`, role: 'analista' },
    [DEFAULT_SCOPE],
  );
  const api = await apiSession(baseURL ?? '', analyst);
  try {
    const refused = [
      await api.get('/api/eventos', { headers: scoped(NORTE) }),
      await api.get(`/api/eventos/${norteEvent}`, { headers: scoped(NORTE) }),
      await api.get(`/system/uploads/${attachmentId}/download`, { headers: scoped(NORTE) }),
      await api.get('/api/eventos?project_id=PRJ-NORTE'),
      await api.post('/api/eventos', {
        data: { payload: { Proyecto_ID: 'PRJ-NORTE', Descripcion: 'x' } },
      }),
      await api.post('/api/eventos', {
        data: { project_id: 'PRJ-NORTE', payload: { Descripcion: 'x' } },
      }),
      await api.post('/select-project', { form: { scope: NORTE }, maxRedirects: 0 }),
      await api.get('/system/export'),
    ];
    expect(refused.map((r) => r.status())).toEqual([403, 403, 403, 403, 403, 403, 403, 403]);
    for (const response of refused) expect(await response.text()).not.toContain('acta norte');
    // Own tenant still works for the same user.
    expect((await api.get(`/api/eventos/${norteEvent}`)).status()).toBe(404);
    expect((await api.get('/api/eventos')).status()).toBe(200);
  } finally {
    await api.dispose();
  }

  // In the browser the restricted user only ever sees the granted project.
  await signIn(page, analyst);
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard ejecutivo' })).toBeVisible();
  await expect(page.getByLabel('Proyecto activo').locator('option')).toHaveText([
    'Proyecto Sechura (migración)',
  ]);
});

test('the export downloads mascli-tenant.json with the active project only', async ({
  page,
  admin,
}) => {
  await signInToProject(page, admin, NORTE);
  await page.goto('/administracion');
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Exportar JSON del proyecto' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('mascli-tenant.json');
  await expect(page.getByText('Exportación descargada.')).toBeVisible();

  const text = await readFile((await download.path()) ?? '', 'utf8');
  const exported = JSON.parse(text) as {
    format: string;
    version: number;
    scope: unknown;
    data: { module_records: { payload: Record<string, unknown> }[] };
  };
  expect(exported.format).toBe('mascli.tenant-export');
  expect(exported.version).toBe(1);
  expect(exported.scope).toEqual({ company_id: 'E2E', project_id: 'PRJ-NORTE' });
  expect(text).toContain(MARKER.norte);
  expect(text).not.toContain(MARKER.sechura);
  expect(text).not.toContain('PRJ-SECHURA');
  // No identity material: hashes, TOTP secrets, sessions or the admin password.
  expect(text).not.toMatch(/password|pbkdf2|argon2|totp|mascli_session|token_hash/i);
  expect(text).not.toContain(admin.password);

  // Switching changes what is exported: the default tenant has its own marker only.
  await switchProject(page, DEFAULT_SCOPE);
  const second = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Exportar JSON del proyecto' }).click();
  const other = await readFile((await (await second).path()) ?? '', 'utf8');
  expect(other).toContain(MARKER.sechura);
  expect(other).not.toContain(MARKER.norte);
});
