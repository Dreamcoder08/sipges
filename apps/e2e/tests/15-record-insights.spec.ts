import AxeBuilder from '@axe-core/playwright';
import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';

for (const mobile of [false, true]) {
  test(`record heatmap and actor classification open stored files (${mobile ? 'phone' : 'desktop'})`, async ({
    page,
    admin,
    browserName,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await signInToProject(page, admin, DEFAULT_SCOPE);
    const stamp = Date.now();
    const eventId = `EV-MAP-${stamp}`;
    const alertId = `AL-MAP-${stamp}`;
    const actorId = `A-MAP-${stamp}`;
    const territory = `Territorio de prueba ${stamp}`;
    const post = async (module: string, payload: Record<string, unknown>) => {
      const response = await page.request.post(`/api/${module}`, {
        headers: { 'X-MASCLI-Scope': DEFAULT_SCOPE, Origin: new URL(page.url()).origin },
        data: { payload },
      });
      expect(response.status()).toBe(200);
    };
    await post('eventos', {
      ID_Evento: eventId,
      Titulo: 'Evento de prueba del mapa',
      Territorio: territory,
    });
    await post('alertas', {
      ID_Alerta: alertId,
      Causa: 'Alerta de prueba para la clasificación',
      Dimension: 'E',
      Nivel_Preliminar: 'Naranja',
      Estado: 'Abierta',
      'Evento/Registro_Origen': eventId,
    });
    await post('actores', {
      ID_Actor: actorId,
      'Nombre_Actor/Organizacion': `Actor de prueba ${stamp}`,
      Tipo_Actor: 'Comunidad',
      Influencia: 'Alta',
      Posicion_Proyecto: 'Favorable',
    });
    for (const [index, type] of ['Institucional', 'Productivo', 'Organización social'].entries()) {
      await post('actores', {
        ID_Actor: `${actorId}-${index}`,
        'Nombre_Actor/Organizacion': `Organización de prueba ${index + 1}`,
        Tipo_Actor: type,
        Influencia: ['Media-alta', 'Media', 'Baja'][index],
        Posicion_Proyecto: ['Expectante', 'Neutral', 'En contra'][index],
      });
      await post('alertas', {
        ID_Alerta: `${alertId}-${index}`,
        Dimension: ['G', 'A', 'D'][index],
        Territorio: `Zona de prueba ${index + 1}`,
        Nivel_Preliminar: ['Amarillo', 'Rojo', 'Verde'][index],
        Estado: 'Abierta',
        Causa: `Registro de prueba ${index + 1}`,
      });
    }
    await page.goto('/alertas');
    const cell = page.getByRole('button', { name: `E · ${territory}: 1 alerta(s), Naranja` });
    await cell.click();
    await page.getByRole('button', { name: `Ficha de alerta ${alertId}`, exact: true }).click();
    await expect(page.getByRole('heading', { name: `Ficha ${alertId}` })).toBeFocused();
    await page.getByRole('button', { name: 'Volver a la lista' }).click();
    await expect(cell).toBeFocused();
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.evaluate(() => window.scrollTo(0, 0));
    // Playwright WebKit screenshots inject body{} to sync animations, blocked by our CSP.
    // Keep all WebKit flow, axe and CSP assertions; capture artifacts with Chromium.
    if (browserName === 'chromium')
      await page
        .getByRole('region', { name: 'Mapa de calor de alertas', exact: true })
        .screenshot({ path: test.info().outputPath('alert-heatmap.png') });
    await page.goto('/actores');
    await expect(
      page.getByRole('group', { name: 'Mapa de actores por sector e influencia' }),
    ).toBeVisible();
    // Other specs share this database, so open the actor from the keyboard, not by position.
    await page
      .getByRole('button', { name: new RegExp(`^Actor de prueba ${stamp}\\. Sociedad civil`) })
      .focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: `Ficha ${actorId}` })).toBeFocused();
    await page.getByRole('button', { name: 'Volver a la lista' }).click();
    await page.getByRole('button', { name: `Ficha de actor ${actorId}`, exact: true }).click();
    await expect(page.getByRole('heading', { name: `Ficha ${actorId}` })).toBeFocused();
    await page.getByRole('button', { name: 'Volver a la lista' }).click();
    await expect(
      page.getByRole('button', { name: `Ficha de actor ${actorId}`, exact: true }),
    ).toBeFocused();
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.evaluate(() => window.scrollTo(0, 0));
    // Playwright WebKit screenshots inject body{} to sync animations, blocked by our CSP.
    // Keep all WebKit flow, axe and CSP assertions; capture artifacts with Chromium.
    if (browserName === 'chromium')
      await page
        .getByRole('region', { name: 'Mapa de actores', exact: true })
        .screenshot({ path: test.info().outputPath('actor-map.png') });
    if (mobile)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        391,
      );
  });
}
