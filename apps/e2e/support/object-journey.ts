import type { APIRequestContext, Page } from '@playwright/test';
import { DEFAULT_SCOPE, expect } from './fixtures.ts';

const scoped = { 'X-SIPGES-Scope': DEFAULT_SCOPE };

/**
 * The 360° view's own actions: approve an analyst proposal (a text mention becomes a link),
 * and classify the record as restricted, which hides it from a read-only account.
 */
export const objectJourney = async (
  page: Page,
  adminApi: APIRequestContext,
  reader: APIRequestContext,
  stamp: string,
) => {
  const actorId = `A-OBJ-${stamp}`;
  const eventId = `EV-OBJ-${stamp}`;
  const actorName = `Cooperativa sintética ${stamp}`;
  for (const [module, payload] of [
    ['actores', { ID_Actor: actorId, 'Nombre_Actor/Organizacion': actorName }],
    [
      'eventos',
      {
        ID_Evento: eventId,
        Fecha: '2026-10-02',
        Descripcion_Hecho: `Reunión en la caleta donde ${actorName} pidió información del monitoreo.`,
      },
    ],
  ] as const) {
    const created = await adminApi.post(`/api/${module}`, { headers: scoped, data: { payload } });
    expect(created.status(), await created.text()).toBe(200);
  }

  await page.goto(`/objeto/eventos/${eventId}`);
  const proposals = page.getByRole('region', { name: 'Propuestas del analista' });
  const proposal = proposals.getByRole('listitem').filter({ hasText: actorName });
  await expect(proposal).toBeVisible();
  await proposal.getByRole('button', { name: 'Aprobar' }).click();
  await expect(proposal).toHaveCount(0);
  await expect(
    page.getByRole('region', { name: 'Vínculos' }).getByRole('link', { name: actorName }),
  ).toBeVisible();

  // Restricted records are hidden from read-only accounts.
  expect((await reader.get(`/api/eventos/${eventId}`, { headers: scoped })).status()).toBe(200);
  await page.getByLabel('Clasificación del registro').selectOption('restringido');
  await expect(
    page.getByText('Solo lo ven administradores, analistas y coordinadores.'),
  ).toBeVisible();
  await expect
    .poll(async () => (await reader.get(`/api/eventos/${eventId}`, { headers: scoped })).status())
    .not.toBe(200);
};
