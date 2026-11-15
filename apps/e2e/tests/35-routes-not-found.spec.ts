import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';

/**
 * functional-10 T6 (F16–F18) in the browser, on the real server and build: Configuración's own
 * address and the redirect from the old one, real not-found pages, and the neutral name a new
 * installation gives its only project.
 */
test.beforeEach(async ({ page, admin }) => {
  await signInToProject(page, admin, DEFAULT_SCOPE);
});

test('an old /version-4 link lands on /configuracion with its section', async ({ page }) => {
  await page.goto('/version-4?seccion=privacidad');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Configuración · Privacidad y datos' }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/configuracion\?seccion=privacidad$/);
  await page.goto('/configuracion');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Configuración · Apariencia' }),
  ).toBeVisible();
  await expect(page).toHaveTitle('Configuración · Apariencia | SIPGES');
});

test('a missing page and a missing record say what is missing and lead back', async ({ page }) => {
  await page.goto('/pagina-que-no-existe');
  await expect(page.getByRole('heading', { level: 1, name: 'Página no encontrada' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Volver al inicio' })).toHaveAttribute(
    'href',
    '/inicio',
  );

  await page.goto('/objeto/Eventos/NO-EXISTE');
  await expect(page.getByRole('heading', { name: 'Registro no encontrado' })).toBeVisible();
  await expect(page.getByText('Tipo de registro no válido')).toHaveCount(0);
  await page.getByRole('link', { name: 'Volver al inicio' }).click();
  await expect(page).toHaveURL(/\/inicio$/);

  await page.goto('/objeto/planetas/X');
  await expect(page.getByRole('heading', { name: 'Tipo de registro no válido' })).toBeVisible();
});

test('a new installation names its project «Proyecto principal»', async ({ page }) => {
  const picker = page.getByLabel('Proyecto activo');
  await expect(picker.locator(`option[value="${DEFAULT_SCOPE}"]`)).toHaveText('Proyecto principal');
  await expect(page.getByText(/Proyecto Sechura/)).toHaveCount(0);
});
