import { describe, expect, it } from 'vitest';
import { createTestApp } from '../support/test-app.ts';

const PDF = new TextEncoder().encode('%PDF-1.7\nsynthetic closing minutes\n');
// sha256 of PDF above.
const PDF_SHA256 = '7a0610ad8ab6ac06e61aa4e05ea56a8bf5d85a6b6d419cd756c56d5321a78aee';

const setup = async () => {
  const t = await createTestApp();
  const admin = await t.login('admin', 'admin-password-123');
  expect(admin.res.status).toBe(200);
  const call = (method: string, path: string, body?: unknown) =>
    t.request(path, {
      method,
      headers: {
        cookie: admin.cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

  const alertId = String(
    (
      await json(
        await call('POST', '/system/intelligence/territorial-alerts', {
          text: 'Convocatoria sintética a asamblea por agua limpia.',
          mode: 'rules',
        }),
      )
    ).id,
  );
  await call('PATCH', `/system/intelligence/territorial-alerts/${alertId}`, {
    status: 'Corroborado',
  });
  const created = await json(
    await call('POST', '/system/prevention/actions', {
      alert_id: alertId,
      title: 'Mesa técnica sintética',
      responsible: 'Equipo social',
      due_date: '2026-11-01',
    }),
  );
  const actionId = (created.action as { id: string }).id;

  await call('POST', '/api/eventos', { payload: { ID_Evento: 'EV-1', Titulo: 'Sintético' } });
  const form = new FormData();
  form.set('linked_module', 'eventos');
  form.set('linked_record_id', 'EV-1');
  form.set('file', new File([PDF], 'acta-cierre.pdf'));
  const uploaded = await t.request('/system/uploads', {
    method: 'POST',
    headers: { cookie: admin.cookie },
    body: form,
  });
  expect(uploaded.status).toBe(200);
  const attachmentId = String(((await json(uploaded)).attachment as { id: string }).id);

  const patch = (body: Record<string, unknown>) =>
    call('PATCH', `/system/prevention/actions/${actionId}`, body);
  return { t, call, json, patch, attachmentId };
};

const COMPLETE = { status: 'Completada', progress: 100, note: 'Acuerdo firmado' };

// The test clock is fixed, so entries share a timestamp: pick the closing entry by status.
const closing = async (res: Response) =>
  ((await res.json()) as { action: { history: Record<string, unknown>[] } }).action.history.find(
    (h) => h.status === 'Completada',
  );

describe('Decision receipts on preventive actions (SIPGES)', () => {
  it('requires an attached file to complete a plan and binds the decision to its sha256', async () => {
    const { t, patch, json, attachmentId } = await setup();
    const missing = await patch(COMPLETE);
    expect(missing.status).toBe(422);
    expect(await json(missing)).toEqual({
      detail: 'Adjunte la evidencia que respalda el cierre de la acción',
    });
    const unknown = await patch({ ...COMPLETE, evidence_attachment_id: 'ADJ-NOPE' });
    expect(unknown.status).toBe(404);
    expect(await json(unknown)).toEqual({ detail: 'Evidencia no encontrada en el proyecto' });

    // Progress updates stay light: no attachment needed.
    expect((await patch({ status: 'En ejecución', progress: 40 })).status).toBe(200);

    const done = await patch({ ...COMPLETE, evidence_attachment_id: attachmentId });
    expect(done.status).toBe(200);
    expect(await closing(done)).toMatchObject({
      status: 'Completada',
      receipt: {
        attachment_id: attachmentId,
        file_name: 'acta-cierre.pdf',
        sha256: PDF_SHA256,
        decided_by: 'admin',
      },
    });
    const [audit] = await t.sql.query<{ detail: string }>(
      "SELECT detail FROM audit WHERE module = 'PrevencionTerritorial' AND action = 'UPDATE' ORDER BY ts DESC, id DESC LIMIT 1",
    );
    expect(audit?.detail).toContain(`sha256 ${PDF_SHA256.slice(0, 12)}`);
  });
});
