import type { Page } from '@playwright/test';
import { expect } from './fixtures.ts';

/**
 * The digital-signal workflow end to end (Inteligencia de redes → Centro gerencial): analyse a
 * publication, register it as an alert, corroborate it after human review, open a preventive
 * plan and record its progress until it is completed with an attached evidence file (MASCLI 4.0
 * decision receipt, ADR 0023/0027).
 */
export const preventionJourney = async (page: Page, stamp: string, scope: string) => {
  const text = `Publicación sintética ${stamp}: vecinos anuncian protesta por agua y bloqueo de vía.`;
  await page.goto('/inteligencia-redes');
  await page.getByLabel('Texto a analizar').fill(text);
  await page.getByRole('button', { name: 'Analizar texto' }).click();
  await expect(page.getByRole('heading', { name: 'Resultado orientativo' })).toBeVisible();
  await page.getByRole('button', { name: 'Registrar alerta' }).click();
  await expect(page.getByText(/^Alerta registrada\./)).toBeVisible();

  // The new alert opens from the inbox and its review form takes the focus.
  const row = page.getByRole('row').filter({ hasText: stamp });
  await expect(row).toHaveCount(1);
  const open = row.getByRole('button', { name: /^Ver alerta / });
  const alertId = ((await open.textContent()) ?? '').replace(/^Ver alerta /, '').trim();
  await open.click();
  await expect(page.getByRole('heading', { name: `Alerta ${alertId}` })).toBeFocused();
  await page.getByLabel('Estado de revisión').selectOption('Corroborado');
  await page.getByLabel('Nota de revisión').fill('Contrastado con acta sintética.');
  await page.getByRole('button', { name: 'Guardar revisión' }).click();
  await expect(row.getByRole('cell', { name: 'Corroborado', exact: true })).toBeVisible();

  // The synthetic receipt that will back the closing: a record and its file, both created
  // through the public endpoints.
  const headers = { 'X-MASCLI-Scope': scope, Origin: new URL(page.url()).origin };
  const eventId = `EV-CIERRE-${stamp}`;
  const event = await page.request.post('/api/eventos', {
    headers,
    data: { payload: { ID_Evento: eventId, Titulo: `Reunión de cierre ${stamp}` } },
  });
  expect(event.status()).toBe(200);
  const uploaded = await page.request.post('/system/uploads', {
    headers,
    multipart: {
      linked_module: 'eventos',
      linked_record_id: eventId,
      file: {
        name: `acta-cierre-${stamp}.txt`,
        mimeType: 'text/plain',
        buffer: Buffer.from(`Acta sintética de cierre ${stamp}.`),
      },
    },
  });
  expect(uploaded.status()).toBe(200);
  const receipt = ((await uploaded.json()) as { attachment: { id: string } }).attachment.id;

  // Preventive plan for the corroborated alert.
  await page.goto('/gerencia');
  const plan = `Plan sintético ${stamp}`;
  await page.getByLabel('Alerta verificada').selectOption(alertId);
  await page.getByLabel('Título del plan').fill(plan);
  await page.getByLabel('Responsable', { exact: true }).fill('Equipo sintético');
  await page.getByLabel('Fecha de vencimiento').fill('2030-01-31');
  await page.getByRole('button', { name: 'Crear plan' }).click();
  await expect(page.getByText('Plan preventivo creado; no modifica el IRSA.')).toBeVisible();
  const planRow = page.getByRole('row').filter({ hasText: plan });
  await expect(planRow).toHaveCount(1);

  // Progress: in execution at 40 %, then completed with a justification.
  await planRow.getByRole('button', { name: /^Ver plan / }).click();
  await expect(page.getByRole('heading', { name: plan })).toBeFocused();
  await page.getByLabel('Estado del plan').selectOption('En ejecución');
  await page.getByLabel('Avance (%)').fill('40');
  await page.getByLabel('Nota de avance').fill('Primera reunión realizada.');
  await page.getByRole('button', { name: 'Guardar avance' }).click();
  await expect(page.getByText('Avance registrado; no modifica el IRSA.')).toBeVisible();
  await expect(planRow.getByRole('cell', { name: '40%' })).toBeVisible();
  await page.getByLabel('Estado del plan').selectOption('Completada');
  await page.getByLabel('Nota de avance').fill('Acuerdo cumplido y verificado.');
  // Closing without a receipt is refused before it reaches the API.
  await expect(
    page.getByText('Adjunte la evidencia que respalda el cierre de la acción.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Guardar avance' })).toBeDisabled();
  await page.getByLabel('Evidencia adjunta (recibo)').selectOption(receipt);
  await page.getByRole('button', { name: 'Guardar avance' }).click();
  await expect(planRow.getByRole('cell', { name: 'Completada' })).toBeVisible();
  await expect(planRow.getByRole('cell', { name: '100%' })).toBeVisible();
};
