import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';

// Synthetic records only (ODD territorial-operations).
test('the territorial map relates a signal to its alert, the action taken and what is pending', async ({
  page,
  admin,
}) => {
  await signInToProject(page, admin, DEFAULT_SCOPE);
  const stamp = Date.now();
  const event = `EV-OPS-${stamp}`;
  const alert = `AL-OPS-${stamp}`;
  const headers = { 'X-MASCLI-Scope': DEFAULT_SCOPE, Origin: new URL(page.url()).origin };
  const post = async (path: string, data: Record<string, unknown>) => {
    const response = await page.request.post(path, { headers, data });
    expect(response.status()).toBe(200);
  };
  const description = `Bloqueo sintético de vía ${stamp}`;
  await post('/api/eventos', {
    payload: {
      ID_Evento: event,
      Fecha: '2026-10-12',
      Territorio: 'Vice, Sechura',
      Descripcion_Hecho: description,
      Nivel_Verificacion: 'B - Probable',
      Fuente_ID: `F-OPS-${stamp}`,
    },
  });
  await post('/api/alertas', {
    payload: {
      ID_Alerta: alert,
      Causa: `Alerta sintética ${stamp}`,
      Nivel_Preliminar: 'Naranja',
      Estado: 'Abierta',
    },
  });
  await post('/api/acciones', {
    payload: {
      ID_Accion: `AC-OPS-${stamp}`,
      Accion: `Mesa sintética ${stamp}`,
      Alerta_Asociada: alert,
      Estado: 'Cumplida',
    },
  });
  await post('/system/links', {
    link_type: 'origina',
    source: { module: 'eventos', id: event },
    target: { module: 'alertas', id: alert },
  });

  await page.goto('/mapa');
  const evolution = page.getByRole('list', { name: 'Registros del periodo' });
  await evolution.getByRole('button', { name: new RegExp(description) }).click();
  const panel = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Inteligencia operacional' }) });
  await expect(panel.getByText(`Registro ${description}`, { exact: true })).toBeVisible();
  const alerts = panel.getByRole('region', { name: 'Alertas y su sustento' });
  await expect(alerts.getByRole('link', { name: `Alerta sintética ${stamp}` })).toBeVisible();
  await expect(alerts.getByText(/Verificación B - Probable con fuente/)).toBeVisible();
  await expect(alerts.getByRole('link', { name: `Mesa sintética ${stamp}` })).toBeVisible();
  const pending = panel.getByRole('region', { name: 'Requiere atención' });
  await expect(pending.getByText('Acción cumplida sin resultado documentado.')).toBeVisible();
  await expect(pending.getByText('Alerta abierta sin una acción vinculada')).toHaveCount(0);
});
