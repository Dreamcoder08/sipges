import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';

/**
 * Each project stores its own location (functional-closure T19, S12). A synthetic project in
 * Tambogrande opens its territorial map there, with no Sechura outlines, towns or labels; the
 * bootstrap Sechura project keeps today's map.
 */
const ALGARROBO = 'E2E/PRJ-ALGARROBO';
const TAMBOGRANDE = { place: 'Tambogrande, Piura', extent: [-80.548, -5.057, -80.218, -4.88] };

test('a project located in Tambogrande frames it and shows no Sechura label', async ({
  page,
  admin,
  adminApi,
}) => {
  const created = await adminApi.post('/system/auth/scopes', {
    headers: { 'X-SIPGES-Scope': DEFAULT_SCOPE },
    data: {
      company_id: 'E2E',
      project_id: 'PRJ-ALGARROBO',
      label: 'Proyecto Algarrobo E2E',
      username: admin.username,
    },
  });
  expect([200, 201, 409], await created.text()).toContain(created.status());
  const saved = await adminApi.put('/system/v4/settings', {
    headers: { 'X-SIPGES-Scope': ALGARROBO },
    data: { location: TAMBOGRANDE },
  });
  expect(saved.status(), await saved.text()).toBe(200);
  // The location belongs to that project only.
  const sechura = await adminApi.get('/system/v4/settings', {
    headers: { 'X-SIPGES-Scope': DEFAULT_SCOPE },
  });
  expect((await sechura.json()).location ?? null).toBeNull();

  await signInToProject(page, admin, ALGARROBO);
  await page.goto('/mapa');
  const main = page.getByRole('main');
  await expect(main.getByLabel('Mapa territorial de Tambogrande, Piura')).toBeVisible();
  await expect(main.getByRole('button', { name: 'Ver Tambogrande, Piura' })).toBeVisible();
  await expect(
    main.getByLabel('Localidad').getByRole('option', { name: 'Todo Tambogrande, Piura' }),
  ).toBeAttached();
  await expect(main.getByText(/Sechura|Bayóvar/)).toHaveCount(0);
  await expect(main.getByLabel(/Sechura/)).toHaveCount(0);
});
