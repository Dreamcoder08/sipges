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

  // The same key reads the record back over MCP, as an agent would.
  const mcp = await page.request.post('/mcp', {
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
  expect(mcp.status(), await mcp.text()).toBe(200);
  expect(JSON.stringify(await mcp.json())).toContain(cause);
});
