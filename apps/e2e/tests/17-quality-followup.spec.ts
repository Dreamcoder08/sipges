import AxeBuilder from '@axe-core/playwright';
import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';

for (const mobile of [false, true]) {
  test(`review, documented links and followup persist through real API (${mobile ? 'phone' : 'desktop'})`, async ({
    page,
    admin,
    browserName,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await signInToProject(page, admin, DEFAULT_SCOPE);
    const stamp = Date.now();
    const actor = `A-QUALITY-${stamp}`;
    const source = `F-QUALITY-${stamp}`;
    const commitment = `C-QUALITY-${stamp}`;
    const headers = { 'X-MASCLI-Scope': DEFAULT_SCOPE, Origin: new URL(page.url()).origin };
    const post = async (module: string, payload: Record<string, unknown>) => {
      const response = await page.request.post(`/api/${module}`, { headers, data: { payload } });
      expect(response.status()).toBe(200);
    };
    await post('fuentes', {
      ID_Fuente: source,
      Archivo_Fuente: `Acta de prueba ${stamp}`,
      Tipo_Fuente: 'Acta',
    });
    await post('actores', {
      ID_Actor: actor,
      'Nombre_Actor/Organizacion': `Actor revisión ${stamp}`,
      Tipo_Actor: 'Comunidad',
      Influencia: 'Alta',
      Posicion_Proyecto: 'Favorable',
      Fuente_ID: source,
      Columna_Original: 'Conservar información importada',
    });
    await post('compromisos', {
      ID_Compromiso: commitment,
      Descripcion: `Compromiso verificable ${stamp}`,
      Estado: 'Pendiente',
      Fecha_Limite: '2020-01-02',
      Responsable: 'Responsable de prueba',
      Fuente_ID: source,
      Plazo: 'Según acta',
    });
    await page.goto('/calidad');
    await page.getByRole('heading', { name: 'Revisión de datos', exact: true }).waitFor();
    if (browserName === 'chromium')
      await page.screenshot({ path: test.info().outputPath('quality-review.png'), fullPage: true });
    await page.getByRole('searchbox', { name: 'Buscar en observaciones' }).fill(actor);
    await page.getByRole('link', { name: `Revisar ${actor}: Territorio`, exact: true }).click();
    await page.getByRole('button', { name: 'Editar datos del registro' }).click();
    await page.getByLabel('Territorio', { exact: true }).fill('Zona documentada de prueba');
    await page.getByRole('button', { name: 'Guardar registro' }).click();
    await expect(page.getByText('Registro guardado.', { exact: true })).toBeVisible();
    const stored = await page.request.get(`/api/actores/${actor}`, { headers });
    expect(await stored.json()).toMatchObject({
      Territorio: 'Zona documentada de prueba',
      Columna_Original: 'Conservar información importada',
    });
    // An actual explicit relationship, supported by an accessible source, rather than a generated line.
    const link = await page.request.post('/system/links', {
      headers,
      data: {
        link_type: 'relacionado_con',
        source: { module: 'actores', id: actor },
        target: { module: 'compromisos', id: commitment },
        evidence: { module: 'fuentes', id: source },
      },
    });
    expect(link.status()).toBe(200);
    await page.reload();
    const evidenceLink = page
      .getByRole('paragraph')
      .filter({ hasText: 'Fuente de evidencia:' })
      .getByRole('link', { name: `Acta de prueba ${stamp}`, exact: true });
    await expect(evidenceLink).toBeVisible();
    await evidenceLink.click();
    await expect(page).toHaveURL(new RegExp(`/objeto/fuentes/${source}$`));
    await expect(
      page.getByRole('heading', { name: `Acta de prueba ${stamp}`, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Evidencias vinculadas', exact: true }),
    ).toBeVisible();
    // Recoverable bytes are checked with a real upload and viewer, metadata alone is insufficient.
    const uploaded = await page.request.post('/system/uploads', {
      headers,
      multipart: {
        linked_module: 'fuentes',
        linked_record_id: source,
        file: {
          name: 'acta-prueba.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('Contenido de prueba verificable del acta.'),
        },
      },
    });
    expect(uploaded.status()).toBe(200);
    await page.reload();
    await page.getByRole('button', { name: /Ver contenido de acta-prueba/ }).click();
    await expect(
      page.getByText('Contenido de prueba verificable del acta.', { exact: true }),
    ).toBeVisible();
    await page.goto('/demandas');
    await page.getByRole('button', { name: 'Compromisos', exact: true }).click();
    await page.getByRole('button', { name: /^Vencidos:/ }).click();
    await page.getByRole('button', { name: `Abrir compromiso ${commitment}`, exact: true }).click();
    await page.getByRole('button', { name: 'Editar', exact: true }).click();
    await page.getByLabel('Fecha límite', { exact: true }).fill('2099-01-01');
    await page.getByRole('button', { name: 'Guardar registro' }).click();
    await page.getByRole('button', { name: /^Próximos:/ }).click();
    await expect(
      page.getByRole('button', { name: `Abrir compromiso ${commitment}`, exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: `Abrir compromiso ${commitment}`, exact: true }).click();
    await page.getByRole('button', { name: 'Editar', exact: true }).click();
    await page.getByLabel('Fecha límite', { exact: true }).fill('');
    await page.getByRole('button', { name: 'Guardar registro' }).click();
    await page.getByRole('button', { name: /^Sin fecha válida:/ }).click();
    await expect(
      page.getByRole('button', { name: `Abrir compromiso ${commitment}`, exact: true }),
    ).toBeVisible();
    const cleared = await page.request.get(`/api/compromisos/${commitment}`, { headers });
    expect(await cleared.json()).toMatchObject({
      Fecha_Vencimiento: '',
      Fecha_Limite: '2020-01-02',
      Plazo: 'Según acta',
    });
    if (browserName === 'chromium')
      await page.screenshot({
        path: test.info().outputPath('commitment-followup.png'),
        fullPage: true,
      });
    await page.goto('/calidad');
    await page.getByRole('searchbox', { name: 'Buscar en observaciones' }).fill(actor);
    await expect(
      page.getByText(/No hay observaciones que coincidan|No se detectaron los campos pendientes/),
    ).toBeVisible();
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
}
