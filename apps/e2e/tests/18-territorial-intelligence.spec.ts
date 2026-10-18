import { randomUUID } from 'node:crypto';
import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';
type Signal = {
  id: string;
  source_record?: { module: string; id: string } | null;
  source_url: string;
  territory?: string | null;
  status: string;
};
type Notice = { id: number; title: string; href?: string };
for (const mobile of [false, true]) {
  test(`committed narrative creates one pending signal and linked inbox without a manual tick (${mobile ? 'phone' : 'desktop'})`, async ({
    page,
    admin,
    browserName,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await signInToProject(page, admin, DEFAULT_SCOPE);
    const stamp = randomUUID().slice(0, 12);
    const marker = `territorial-e2e-${stamp}`;
    const narrativeId = `NAR-TERRITORIAL-${stamp}`;
    const sourceUrl = `https://example.test/synthetic/${stamp}`;
    const territory = `Territorio documentado sintético ${stamp}`;
    const noticeTitle = `Señal sintética ${stamp}`;
    const headers = { 'X-MASCLI-Scope': DEFAULT_SCOPE, Origin: new URL(page.url()).origin };
    const rules: number[] = [];
    const payload = {
      ID_Narrativa: narrativeId,
      Descripcion: `${marker}. Exigimos agua limpia: habrá paro y bloqueo este lunes. Convocatoria a asamblea.`,
      URL_Publicacion: sourceUrl,
      Tipo_Fuente: 'Publicación digital',
      Territorio: territory,
    };
    const notices = async () => {
      const response = await page.request.get('/system/notifications?limit=200', { headers });
      expect(response.status(), await response.text()).toBe(200);
      const inbox = (await response.json()) as { items: Notice[] };
      return inbox.items.filter((item) => item.title === noticeTitle);
    };
    const signals = async () => {
      const response = await page.request.get('/system/intelligence/territorial-alerts?limit=200', {
        headers,
      });
      expect(response.status(), await response.text()).toBe(200);
      return ((await response.json()) as Signal[]).filter(
        (item) => item.source_record?.id === narrativeId,
      );
    };
    try {
      for (const rule of [
        {
          name: `Evaluar evidencia ${stamp}`,
          module: 'Narrativas',
          actions: ['CREATE', 'UPDATE'],
          conditions: [{ field: 'Descripcion', op: 'contains', value: marker }],
          steps: [{ kind: 'evaluate', title: 'Evaluar {id}', minimum_level: 'Media' }],
        },
        {
          name: `Avisar evidencia ${stamp}`,
          module: 'InteligenciaDigital',
          actions: ['CREATE'],
          conditions: [
            { field: 'source_url', op: 'eq', value: sourceUrl },
            { field: 'territory', op: 'eq', value: territory },
            { field: 'status', op: 'eq', value: 'Pendiente de verificación' },
          ],
          steps: [{ kind: 'notify', title: noticeTitle }],
        },
      ]) {
        const response = await page.request.post('/system/automations/rules', {
          headers,
          data: rule,
        });
        expect(response.status(), await response.text()).toBe(200);
        const created = (await response.json()) as { id: number };
        rules.push(created.id);
      }
      const created = await page.request.post('/api/narrativas', { headers, data: { payload } });
      expect(created.status(), await created.text()).toBe(200);
      await expect.poll(async () => (await notices()).length).toBe(1);
      await expect.poll(async () => (await signals()).length).toBe(1);
      const [signal] = await signals();
      if (!signal) throw new Error('The committed narrative must produce its pending signal');
      expect(signal).toMatchObject({
        source_record: { module: 'Narrativas', id: narrativeId },
        source_url: sourceUrl,
        territory,
        status: 'Pendiente de verificación',
      });
      expect((await notices())[0]?.href).toBe(`/inteligencia-redes?alert=${signal.id}`);
      const updated = await page.request.put(`/api/narrativas/${narrativeId}`, {
        headers,
        data: { payload },
      });
      expect(updated.status(), await updated.text()).toBe(200);
      const runtime = await page.request.get('/system/automations/runtime', { headers });
      expect(await runtime.json()).toMatchObject({
        event_processing: true,
        latest_attempt: { source: 'event', status: 'completed', error: '' },
      });
      expect(await signals()).toHaveLength(1);
      expect(await notices()).toHaveLength(1);
      // Regression: navigate from an already mounted intelligence route with another selection.
      await page.goto('/inteligencia-redes?alert=DIG-MISSING-SYNTHETIC');
      if (mobile) await page.getByRole('button', { name: /^Cuenta de / }).click();
      else await page.getByRole('button', { name: /Notificaciones/ }).click();
      const inbox = mobile
        ? page.getByRole('dialog', { name: 'Cuenta', exact: true })
        : page.getByRole('region', { name: 'Notificaciones', exact: true });
      await inbox.getByRole('link', { name: noticeTitle, exact: true }).click();
      await expect(page).toHaveURL(
        (url) =>
          url.pathname === '/inteligencia-redes' && url.searchParams.get('alert') === signal.id,
      );
      if (mobile)
        await expect(page.getByRole('dialog', { name: 'Cuenta', exact: true })).toBeHidden();
      else
        await expect(
          page.getByRole('region', { name: 'Notificaciones', exact: true }),
        ).toBeHidden();
      await expect(
        page.getByRole('heading', { name: `Alerta ${signal.id}`, exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText(`Procedencia: Narrativas · ${narrativeId}`, { exact: true }),
      ).toBeVisible();
      await expect(page.getByText(`Territorio: ${territory}`, { exact: true })).toBeVisible();
      await expect(
        page.getByText(`Fuente: ${sourceUrl} · Publicación digital`, { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole('combobox', { name: 'Estado de revisión', exact: true }),
      ).toHaveValue('Pendiente de verificación');
      await expect(page.getByText(/Última revisión: Sin revisión · Pendiente/)).toBeVisible();
      const sourceCard = page.locator('section').filter({
        has: page.getByRole('heading', { name: 'Fuentes oficiales autorizadas', exact: true }),
      });
      await expect(
        sourceCard.getByRole('checkbox', { name: 'Activar consulta periódica autorizada' }),
      ).not.toBeChecked();
      await expect(sourceCard.getByText(/Consulta periódica: desactivada/)).toBeVisible();
      // Explicit UI failure fixture: no external official request or claimed provider availability.
      await page.route('**/system/intelligence/sources/defensoria/preview*', (route) =>
        route.fulfill({
          status: 502,
          contentType: 'application/json',
          body: JSON.stringify({ detail: 'Fuente sintética temporalmente no disponible.' }),
        }),
      );
      await sourceCard
        .getByRole('button', { name: 'Previsualizar publicaciones', exact: true })
        .click();
      await expect(sourceCard.getByRole('status')).toHaveText(
        'Fuente sintética temporalmente no disponible.',
      );
      await expect(
        sourceCard.getByRole('button', { name: 'Importar publicación', exact: true }),
      ).toHaveCount(0);
      if (browserName === 'chromium')
        await page.screenshot({
          path: test
            .info()
            .outputPath(`territorial-intelligence-${mobile ? 'phone' : 'desktop'}.png`),
          fullPage: true,
        });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.goto('/automatizaciones');
      await expect(
        page.getByRole('heading', { name: 'Procesamiento y entregas', exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText('Al guardar registros: procesamiento automático habilitado.', {
          exact: true,
        }),
      ).toBeVisible();
      await expect(page.getByText(/Último intento: .* · registro · completado\./)).toBeVisible();
    } finally {
      for (const id of rules) {
        const response = await page.request.delete(`/system/automations/rules/${id}`, { headers });
        expect(response.status(), await response.text()).toBe(200);
      }
    }
  });
}
