import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';

/**
 * ADR 0014 end to end: a rule built on the screen, an API key shown once, a record that
 * arrives through the inbound webhook, the bell notice the rule produces, and the same key
 * reading the record back over MCP.
 */
test('automation rule, API key, inbound webhook, notification and MCP', async ({ page, admin }) => {
  const stamp = Date.now();
  const cause = `Bloqueo sintético ${stamp}`;
  const alertId = `AL-E2E-${stamp}`;

  await signInToProject(page, admin, DEFAULT_SCOPE);
  await page.goto('/automatizaciones');
  await expect(page.getByRole('heading', { level: 1, name: 'Automatizaciones' })).toBeVisible();

  // A rule on new alerts whose cause is this run's synthetic text.
  await page.getByLabel('Nombre de la regla').fill(`Alertas E2E ${stamp}`);
  await page.getByRole('button', { name: 'Añadir condición' }).click();
  await page.getByLabel(/^Campo/).fill('Causa');
  await page.getByLabel('Valor', { exact: true }).fill(cause);
  await page.getByRole('button', { name: 'Crear regla' }).click();
  await expect(page.getByText('Regla creada.')).toBeVisible();

  // A write key; the token is shown once.
  await page.getByLabel(/Nombre de la clave/).fill(`Formulario E2E ${stamp}`);
  await page.getByRole('combobox', { name: /^Permisos/ }).selectOption('write');
  await page.getByRole('button', { name: 'Crear clave' }).click();
  const token =
    (await page
      .locator('code')
      .filter({ hasText: /^mscli_/ })
      .textContent()) ?? '';
  expect(token).toMatch(/^mscli_[a-f0-9]{12}_/);

  // An outside system sends the alert through the inbound webhook.
  const ingested = await page.request.post('/hooks/ingest/alertas', {
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': `e2e-${stamp}` },
    data: { ID_Alerta: alertId, Causa: cause, Nivel_Preliminar: 'Alto' },
  });
  expect(ingested.status(), await ingested.text()).toBe(201);
  expect(await ingested.json()).toMatchObject({ ids: [alertId] });

  // Running the rules now turns it into a notice in the bell.
  await page.getByRole('button', { name: 'Ejecutar ahora' }).click();
  await expect(page.getByText(/Revisión completada/)).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: /Notificaciones/ }).click();
  const inbox = page.getByRole('region', { name: 'Notificaciones' });
  await expect(inbox.getByRole('link', { name: new RegExp(alertId) })).toBeVisible();
  await inbox.getByRole('link', { name: new RegExp(alertId) }).click();
  await expect(page).toHaveURL(new RegExp(`/objeto/alertas/${alertId}$`));

  // The same key reads the record back over MCP, as an agent would (ADR 0030): only once an
  // administrator turns «Envío a IA externa» on, and pseudonymised even then.
  const getRecord = () =>
    page.request.post('/mcp', {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json, text/event-stream',
      },
      data: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_record', arguments: { module: 'alertas', id: alertId } },
      },
    });
  await page.goto('/version-4');
  const externalAi = page.getByRole('checkbox', { name: 'Envío a IA externa' });
  // A controlled checkbox: it flips only once the server saved the setting.
  const setExternalAi = async (on: boolean) => {
    if ((await externalAi.isChecked()) !== on) await externalAi.click();
    await expect(externalAi).toBeChecked({ checked: on });
  };
  await setExternalAi(false);
  await expect(page.getByText(/^Desactivado: ningún dato del proyecto sale/)).toBeVisible();
  const refused = await getRecord();
  expect(refused.status(), await refused.text()).toBe(200);
  const refusal = JSON.stringify(await refused.json());
  expect(refusal).toContain('El envío a IA externa está desactivado para este proyecto');
  expect(refusal).not.toContain(cause);

  await setExternalAi(true);
  await expect(page.getByText(/^Activado: el servidor MCP/)).toBeVisible();
  const mcp = await getRecord();
  expect(mcp.status(), await mcp.text()).toBe(200);
  expect(JSON.stringify(await mcp.json())).toContain(cause);

  // Leave the project as every new project starts: nothing leaves.
  await setExternalAi(false);
  await expect(page.getByText(/^Desactivado: ningún dato del proyecto sale/)).toBeVisible();
});

/** S4: one Integraciones page, reached from the sidebar, with filters and the synthetic-data warning (S7). */
test('Integraciones: sidebar link, kind filters and the MCP card opens its keys', async ({
  page,
  admin,
}) => {
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await page.goto('/inicio');
  await page
    .getByRole('navigation', { name: 'Secciones' })
    .getByRole('link', { name: 'Integraciones', exact: true })
    .click();
  await expect(page).toHaveURL(/\/integraciones$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Integraciones' })).toBeVisible();

  const mcp = page
    .getByRole('listitem')
    .filter({ has: page.getByRole('heading', { name: 'Claude vía MCP' }) });
  await expect(
    mcp.getByText('Datos sintéticos hasta aprobar política de datos (Ley 29733)'),
  ).toBeVisible();

  const kinds = page.getByRole('group', { name: 'Filtrar por tipo' });
  await kinds.getByRole('button', { name: /^Skills/ }).click();
  await expect(page.getByRole('heading', { level: 2, name: /^Skills/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Claude vía MCP' })).toHaveCount(0);
  await kinds.getByRole('button', { name: /^Todos/ }).click();

  await page.getByRole('button', { name: 'Claude vía MCP', exact: true }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Claude vía MCP' })).toBeFocused();
  await expect(page.getByLabel(/Nombre de la clave/)).toBeVisible();
  await page.getByRole('button', { name: 'Integraciones', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Filtrar por tipo' })).toBeVisible();
});
