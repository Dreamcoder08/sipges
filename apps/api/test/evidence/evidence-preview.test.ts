import { describe, expect, it } from 'vitest';
import { AttachmentPreview } from '@mascli/contracts';
import { renderDemoEvidence } from '../../src/tools/academic-demo/documents.ts';
import { createTestApp, memoryStorage } from '../support/test-app.ts';

const TEXT = 'INFORME DE PRUEBA\nLinea con datos sinteticos para el visor.\n';

const setup = async () => {
  const memory = memoryStorage();
  const t = await createTestApp({}, { objectStorage: memory.storage });
  const admin = await t.login('admin', 'admin-password-123');
  const call = (method: string, path: string, body?: string | FormData, json = false) =>
    t.request(path, {
      method,
      headers: { cookie: admin.cookie, ...(json ? { 'content-type': 'application/json' } : {}) },
      ...(body === undefined ? {} : { body }),
    });
  await call('POST', '/api/fuentes', JSON.stringify({ payload: { ID_Fuente: 'F-T1' } }), true);
  const upload = async (name: string, bytes: Uint8Array) => {
    const form = new FormData();
    form.set('linked_module', 'fuentes');
    form.set('linked_record_id', 'F-T1');
    form.set('file', new File([bytes], name));
    const res = await call('POST', '/system/uploads', form);
    expect(res.status).toBe(200);
    return ((await res.json()) as { attachment: { id: string } }).attachment.id;
  };
  const preview = async (id: string) => {
    const res = await call('GET', `/system/uploads/${id}/preview`);
    return { status: res.status, body: (await res.json()) as unknown };
  };
  return { memory, upload, preview };
};

// Regression (functional audit, error 05): stored reports open in the app with their content.
describe('GET /system/uploads/{id}/preview', () => {
  it.each([
    ['informe.pdf', 'pdf'],
    ['informe.docx', 'docx'],
    ['informe.txt', 'txt'],
  ] as const)('returns the text of %s with its metadata', async (name, format) => {
    const { upload, preview } = await setup();
    const bytes = await renderDemoEvidence({
      recordId: 'F-T1',
      filename: name,
      format,
      text: TEXT,
    });
    const id = await upload(name, bytes);
    const { status, body } = await preview(id);
    expect(status).toBe(200);
    const parsed = AttachmentPreview.parse(body);
    expect(parsed.kind).toBe('text');
    if (parsed.kind !== 'text') return;
    expect(parsed.format).toBe(format);
    expect(parsed.pages.join('\n')).toContain('INFORME DE PRUEBA');
    expect(parsed.truncated).toBe(false);
    expect(parsed.attachment).toMatchObject({ id, original_name: name, linked_record_id: 'F-T1' });
  });

  it('marks images for inline display and reports a missing file or id', async () => {
    const { memory, upload, preview } = await setup();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const image = await upload('foto.png', png);
    expect(AttachmentPreview.parse((await preview(image)).body).kind).toBe('image');

    const text = await upload('nota.txt', new TextEncoder().encode(TEXT));
    memory.objects.clear();
    expect((await preview(text)).status).toBe(410);
    expect((await preview('ADJ-000000000000')).status).toBe(404);
  });

  it('says when a PDF has no text layer instead of showing an empty page', async () => {
    const { upload, preview } = await setup();
    const blank = await renderDemoEvidence({
      recordId: 'F-T1',
      filename: 'escaneado.pdf',
      format: 'pdf',
      text: ' ',
    });
    const id = await upload('escaneado.pdf', blank);
    expect(AttachmentPreview.parse((await preview(id)).body).kind).toBe('no_text');
  });
});
