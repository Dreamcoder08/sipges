import AxeBuilder from '@axe-core/playwright';
import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';

/** SIPGES end to end with synthetic records (docs/adr/0020, 0027): situation, alert. */
test('SIPGES relates recent records, explains the colour and lets a person raise the alert', async ({
  page,
  admin,
}) => {
  await signInToProject(page, admin, DEFAULT_SCOPE);
  const headers = { 'X-SIPGES-Scope': DEFAULT_SCOPE, Origin: new URL(page.url()).origin };
  const stamp = Date.now();
  const topic = `Tema de prueba ${stamp}`;
  const day = (ago: number) => new Date(Date.now() - ago * 86_400_000).toISOString().slice(0, 10);
  const post = async (module: string, payload: Record<string, unknown>) =>
    expect(
      (await page.request.post(`/api/${module}`, { headers, data: { payload } })).status(),
    ).toBe(200);
  await page.goto('/');
  await post('demandas', {
    ID_Demanda: `D-${stamp}`,
    Fecha_Registro: day(1),
    Tema: topic,
    'Actor/Grupo': 'Comunidad de prueba',
    Descripcion: 'Demanda sintética',
    Prioridad: 'Alta',
  });
  await post('narrativas', {
    ID_Narrativa: `N-${stamp}`,
    Fecha_Inicio: day(2),
    Tema: topic,
    Descripcion: 'Publicación sintética',
  });
  await post('eventos', {
    ID_Evento: `EV-${stamp}`,
    Fecha: day(3),
    Tema: topic,
    Descripcion_Hecho: 'Reunión sintética',
    Actor_Principal: 'Comunidad de prueba',
  });

  // «Situaciones» is a tab of Bandeja.
  await page
    .getByRole('navigation', { name: 'Secciones' })
    .getByRole('link', { name: 'Bandeja', exact: true })
    .click();
  await page.getByRole('button', { name: 'Situaciones', exact: true }).click();
  const card = page.getByRole('listitem').filter({ hasText: topic }).first();
  await expect(card.getByText(/^Naranja – Requiere intervención preventiva/).first()).toBeVisible();
  await expect(card.getByRole('link', { name: new RegExp(`D-${stamp}`) }).first()).toBeVisible();
  await expect(card.getByText('Coordinar una reunión con los actores involucrados.')).toBeVisible();
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
  ).toEqual([]);

  await card.getByRole('button', { name: 'Crear alerta naranja con esta explicación' }).click();
  const created = card.getByRole('link', { name: /^AL-/ });
  await expect(created).toBeVisible();
  await created.click();
  await expect(page.getByRole('heading', { name: 'Por qué se generó esta alerta' })).toBeVisible();
  await expect(page.getByLabel('Trazabilidad del registro')).toContainText('Registrado por');
});
