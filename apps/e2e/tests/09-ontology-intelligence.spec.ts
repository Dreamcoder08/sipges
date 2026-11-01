import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';

const scoped = { 'X-SIPGES-Scope': DEFAULT_SCOPE };

test('360° view: inferred links, cited briefing, history, search and chronology', async ({
  page,
  admin,
  adminApi,
}) => {
  const stamp = Date.now();
  const actorId = `A-E2E-${stamp}`;
  const eventId = `EV-E2E-${stamp}`;
  const actorName = `Colectivo sintético ${stamp}`;
  for (const [module, payload] of [
    [
      'actores',
      { ID_Actor: actorId, 'Nombre_Actor/Organizacion': actorName, Posicion_Proyecto: 'En contra' },
    ],
    [
      'eventos',
      {
        ID_Evento: eventId,
        Descripcion_Hecho: `Asamblea sintética ${stamp}`,
        Fecha: '2026-10-01',
        Actor_Principal: actorName,
      },
    ],
  ] as const) {
    const created = await adminApi.post(`/api/${module}`, { headers: scoped, data: { payload } });
    expect(created.status(), await created.text()).toBe(200);
  }
  const edited = await adminApi.put(`/api/actores/${actorId}`, {
    headers: scoped,
    data: {
      payload: {
        ID_Actor: actorId,
        'Nombre_Actor/Organizacion': actorName,
        Posicion_Proyecto: 'En contra',
        Territorio: 'Vice',
      },
    },
  });
  expect(edited.status(), await edited.text()).toBe(200);

  await signInToProject(page, admin, DEFAULT_SCOPE);

  // Global search (Ctrl+K) opens the record's 360° view.
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Búsqueda global' })).toBeVisible();
  await page.keyboard.press('Control+k');
  await page
    .getByRole('combobox', { name: 'Buscar en todo el proyecto' })
    .fill(`sintético ${stamp}`);
  await page.getByRole('option', { name: new RegExp(actorName) }).click();
  await expect(page).toHaveURL(new RegExp(`/objeto/actores/${actorId}$`));
  await expect(page.getByRole('heading', { name: actorName })).toBeVisible();

  // The event naming the actor appears as an inferred link.
  await expect(page.getByRole('heading', { name: 'Vínculos' })).toBeVisible();
  await expect(
    page.getByRole('link', { name: new RegExp(`Asamblea sintética ${stamp}`) }).first(),
  ).toBeVisible();

  // Extractive briefing with citations.
  await page.getByRole('button', { name: 'Generar informe' }).click();
  await expect(
    page.getByText(`Actor «${actorName}» mantiene una posición En contra.`),
  ).toBeVisible();
  await expect(page.getByRole('list', { name: 'Fuentes del informe' })).toContainText(eventId);

  // History shows the edit as a field change.
  await expect(page.getByRole('heading', { name: 'Historial de cambios' })).toBeVisible();
  await expect(page.getByText('Territorio').last()).toBeVisible();

  // The chronology lists the dated event and links back to it.
  await page.goto('/cronologia');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Cronología territorial' }),
  ).toBeVisible();
  await page.getByRole('link', { name: `Asamblea sintética ${stamp}` }).click();
  await expect(page).toHaveURL(new RegExp(`/objeto/eventos/${eventId}$`));
});
