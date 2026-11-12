import {
  DEFAULT_SCOPE,
  apiSession,
  createAccount,
  expect,
  signInToProject,
  test,
} from '../support/fixtures.ts';

/**
 * Configuración › Cuenta (compact-sidebar S7): the person sees where their account is signed in
 * and signs every other device out. A synthetic account of its own keeps other tests' sessions
 * untouched.
 */
test('Cuenta lists the sessions and signs the other devices out', async ({
  page,
  adminApi,
  baseURL,
}) => {
  const credentials = await createAccount(
    adminApi,
    { username: `cuenta-${Date.now()}`, role: 'analista' },
    [DEFAULT_SCOPE],
  );
  const otherDevice = await apiSession(baseURL ?? '', credentials);
  try {
    await signInToProject(page, credentials, DEFAULT_SCOPE);
    await page.goto('/version-4?seccion=cuenta');
    const nav = page.getByRole('navigation', { name: 'Secciones de Configuración' });
    await expect(nav.getByRole('link', { name: 'Cuenta' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByText(credentials.username, { exact: true })).toBeVisible();

    const sessions = page.getByRole('list', { name: 'Sesiones activas' });
    await expect(sessions.getByRole('listitem')).toHaveCount(2);
    await expect(sessions.getByText('Este dispositivo')).toHaveCount(1);

    await page.getByRole('button', { name: 'Cerrar sesión en todos los demás' }).click();
    const dialog = page.getByRole('alertdialog', {
      name: 'Cerrar sesión en todos los demás dispositivos',
    });
    await dialog.getByRole('button', { name: 'Cerrar las demás sesiones' }).click();
    await expect(page.getByText('Se cerró 1 sesión en otro dispositivo.')).toBeVisible();
    await expect(sessions.getByRole('listitem')).toHaveCount(1);
    await expect(page.getByText('No hay otras sesiones abiertas.')).toBeVisible();

    const closed = await otherDevice.get('/system/auth/sessions', {
      headers: { 'X-SIPGES-Scope': DEFAULT_SCOPE },
    });
    expect(closed.status()).toBe(401);
    // This device stays signed in.
    await page.reload();
    await expect(sessions.getByText('Este dispositivo')).toBeVisible();
  } finally {
    await otherDevice.dispose();
  }
});
