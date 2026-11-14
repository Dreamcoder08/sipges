import type { Page } from '@playwright/test';
import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';

/** Stored keys a person should never read: field names (`Fuente_ID`) and situation keys. */
const INTERNAL_KEY = /\b[A-Z][a-z]+_[A-Z]\w*|\b(?:tema|actor|territorio):\S/;

const day = (daysAgo: number) =>
  new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);

/** Opens a Pendientes item on a phone and returns its detail panel's text. */
const detailOf = async (page: Page, clase: string, option: string) => {
  await page.goto(`/bandeja?clase=${clase}`);
  await page
    .getByRole('listbox', { name: 'Pendientes de decisión' })
    .getByRole('option')
    .filter({ hasText: option })
    .first()
    .click();
  const detail = page.getByRole('region', { name: 'Detalle del pendiente' });
  await expect(detail.getByRole('button', { name: 'Volver a la lista' })).toBeVisible();
  await expect(detail.getByRole('heading', { level: 2 })).toBeVisible();
  return detail;
};

/**
 * Bandeja › Pendientes on a phone: the detail of a data-quality item names the field as the
 * Calidad de datos screen does («Referencia de fuente»), and a situation's reference is its kind
 * as Situaciones shows it («Tema», «Territorio»), never the stored key (`Fuente_ID`,
 * `tema:movilizacion`).
 */
for (const width of [360, 412] as const) {
  test(`the Bandeja detail at ${width} px shows labels, never internal keys`, async ({
    page,
    admin,
    adminApi,
  }) => {
    const stamp = `${width}-${Date.now()}`;
    const place = `Caleta sintética ${stamp}`;
    // Recent events of one new place with no source: each is a quality item, together a situation.
    for (let n = 1; n <= 10; n += 1) {
      const created = await adminApi.post('/api/eventos', {
        headers: { 'X-SIPGES-Scope': DEFAULT_SCOPE },
        data: {
          payload: {
            Fecha: day(n),
            Territorio: place,
            Tipo_Evento: 'Protesta',
            Descripcion_Hecho: `Bloqueo sintético ${n} en ${place}`,
          },
        },
      });
      expect(created.status(), await created.text()).toBe(200);
    }
    await page.setViewportSize({ width, height: 800 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await signInToProject(page, admin, DEFAULT_SCOPE);

    const quality = await detailOf(page, 'calidad', `Bloqueo sintético 1 en ${place}`);
    await expect(quality.getByRole('listitem')).toContainText([
      'Referencia de fuente: Sin referencia de fuente',
    ]);
    expect(await quality.innerText()).not.toMatch(INTERNAL_KEY);

    // The situation these records raise (keyed by topic or by place).
    const situation = await detailOf(page, 'situacion', place);
    expect(await situation.innerText()).not.toMatch(INTERNAL_KEY);
    await expect(situation.getByText(/^(?:Tema|Actor|Territorio)(?: · |$)/)).toBeVisible();
  });
}
