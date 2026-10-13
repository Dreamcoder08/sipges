import { describe, expect, it } from 'vitest';
import type { ObjectStorage } from '../../src/contexts/evidence/application/index.ts';
import { createTestApp, memoryStorage } from '../support/test-app.ts';

const PDF = new TextEncoder().encode('%PDF-1.7\nsynthetic evidence\n');

type Fields = Record<string, string>;

const setup = async (env: Record<string, string> = {}, objectStorage?: ObjectStorage) => {
  const t = await createTestApp(env, objectStorage ? { objectStorage } : {});
  const admin = await t.login('admin', 'admin-password-123');
  expect(admin.res.status).toBe(200);

  const json = (method: string, path: string, body?: unknown, extra: Fields = {}) =>
    t.request(path, {
      method,
      headers: {
        cookie: admin.cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const upload = (
    fields: Fields,
    file: { name: string; bytes: Uint8Array } | null = { name: 'informe.pdf', bytes: PDF },
    extra: Fields = {},
  ) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    if (file) form.set('file', new File([file.bytes], file.name));
    return t.request('/system/uploads', {
      method: 'POST',
      headers: { cookie: admin.cookie, ...extra },
      body: form,
    });
  };

  const event = (id: string, extra: Fields = {}) =>
    json('POST', '/api/eventos', { payload: { ID_Evento: id, Titulo: 'Sintético' } }, extra);

  return { t, admin, json, upload, event };
};

const LINK = { linked_module: 'eventos', linked_record_id: 'EV-1' };

describe('POST /system/uploads', () => {
  it('stores the file, links it into the record and audits the upload', async () => {
    const { t, json, upload, event } = await setup();
    await event('EV-1');

    const res = await upload({ ...LINK, notes: 'Acta de campo' });
    expect(res.status).toBe(200);
    const { attachment } = (await res.json()) as { attachment: Record<string, unknown> };
    expect(attachment).toMatchObject({
      original_name: 'informe.pdf',
      content_type: 'application/pdf',
      size_bytes: PDF.length,
      linked_module: 'eventos',
      linked_record_id: 'EV-1',
      document_type: 'Reporte / evidencia',
      verification: 'E - No verificada',
      notes: 'Acta de campo',
      project_id: 'PRJ-SECHURA',
      project_name: 'Proyecto Sechura',
    });
    expect(attachment.id).toMatch(/^ADJ-[0-9A-F]{12}$/);
    expect(attachment.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(attachment).not.toHaveProperty('storage_key');

    const record = (await (await json('GET', '/api/eventos/EV-1')).json()) as Record<
      string,
      unknown
    >;
    expect(record['Evidencia/Resultado']).toBe('informe.pdf');
    expect(record.Adjuntos).toEqual([
      {
        id: attachment.id,
        archivo: 'informe.pdf',
        tipo: 'Reporte / evidencia',
        verificacion: 'E - No verificada',
      },
    ]);

    const audit = (await (await json('GET', '/system/audit')).json()) as {
      action: string;
      detail: string;
    }[];
    expect(audit[0]).toMatchObject({
      action: 'UPLOAD',
      detail: `Evidencia adjunta: informe.pdf (${PDF.length} bytes)`,
    });

    const download = await t.request(`/system/uploads/${String(attachment.id)}/download`, {
      headers: { cookie: (await t.login('admin', 'admin-password-123')).cookie },
    });
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toBe('application/pdf');
    expect(download.headers.get('content-disposition')).toBe('attachment; filename="informe.pdf"');
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(PDF);
  });

  it('answers each rejection with app.py status codes and stores nothing', async () => {
    const { t, upload, event } = await setup({ MASCLI_MAX_UPLOAD_BYTES: '1048576' });
    await event('EV-1');
    const cases: [Fields, { name: string; bytes: Uint8Array } | null, number][] = [
      [{ ...LINK, linked_module: 'planetas' }, undefined as never, 400],
      [LINK, { name: 'script.exe', bytes: PDF }, 415],
      [LINK, { name: 'falso.pdf', bytes: new TextEncoder().encode('MZ not a pdf') }, 415],
      [LINK, { name: 'vacio.pdf', bytes: new Uint8Array() }, 400],
      [{ ...LINK, linked_record_id: 'EV-404' }, undefined as never, 404],
      [{ linked_module: 'eventos' }, undefined as never, 422],
      [LINK, null, 422],
    ];
    for (const [fields, file, status] of cases) {
      const res = file === undefined ? await upload(fields) : await upload(fields, file);
      expect(res.status, JSON.stringify(fields)).toBe(status);
    }
    const big = new Uint8Array(1048576 + 1);
    big.set(new TextEncoder().encode('%PDF-'));
    expect((await upload(LINK, { name: 'grande.pdf', bytes: big })).status).toBe(413);
    const huge = new Uint8Array(2 * 1048576);
    expect((await upload(LINK, { name: 'enorme.pdf', bytes: huge })).status).toBe(413);

    expect(t.objects.size).toBe(0);
    expect(await t.sql.query('SELECT id FROM attachments')).toEqual([]);
  });

  it('deletes the stored object when the metadata transaction fails', async () => {
    const memory = memoryStorage();
    const { t, upload, event } = await setup({}, memory.storage);
    await event('EV-1');
    await t.sql.query('ALTER TABLE attachments ADD CONSTRAINT fail_all CHECK (false) NOT VALID');
    expect((await upload(LINK)).status).toBe(500);
    expect(memory.objects.size).toBe(0);
  });

  it('refuses read-only roles and cross-origin posts', async () => {
    const { t, admin, upload, event } = await setup();
    await event('EV-1');
    await t.createAccount(admin.cookie, {
      username: 'reader',
      full_name: 'Reader',
      password: 'reader-password-123',
      role: 'consulta',
    });
    await t.grant(admin.cookie, 'reader');
    const reader = await t.login('reader', 'reader-password-123');
    const form = new FormData();
    form.set('linked_module', 'eventos');
    form.set('linked_record_id', 'EV-1');
    form.set('file', new File([PDF], 'a.pdf'));
    const res = await t.request('/system/uploads', {
      method: 'POST',
      headers: { cookie: reader.cookie },
      body: form,
    });
    expect(res.status).toBe(403);
    expect((await upload(LINK, undefined, { origin: 'https://evil.example' })).status).toBe(403);
    expect(t.objects.size).toBe(0);
  });
});

describe('GET /system/uploads', () => {
  it('lists, filters and fetches attachments of the active tenant only', async () => {
    const { t, admin, json, upload, event } = await setup();
    await event('EV-1');
    await event('EV-2');
    await upload(LINK, { name: 'uno.pdf', bytes: PDF });
    await upload({ ...LINK, linked_record_id: 'EV-2' }, { name: 'dos_100%.pdf', bytes: PDF });

    const all = (await (await json('GET', '/system/uploads')).json()) as { id: string }[];
    expect(all).toHaveLength(2);
    const byRecord = (await (
      await json('GET', '/system/uploads?linked_module=eventos&linked_record_id=EV-2')
    ).json()) as { original_name: string }[];
    expect(byRecord.map((a) => a.original_name)).toEqual(['dos_100.pdf']);
    expect(await (await json('GET', '/system/uploads?q=%25')).json()).toEqual([]);
    expect((await json('GET', '/system/uploads?limit=abc')).status).toBe(422);

    const [first] = all;
    expect((await json('GET', `/system/uploads/${first?.id}`)).status).toBe(200);
    expect((await json('GET', '/system/uploads/ADJ-NOPE')).status).toBe(404);

    expect(
      (
        await t.createScope(admin.cookie, {
          company_id: 'ACME',
          project_id: 'NORTE',
          label: 'North',
          username: 'admin',
        })
      ).status,
    ).toBe(200);
    const north = { 'x-mascli-scope': 'ACME/NORTE' };
    expect(await (await json('GET', '/system/uploads', undefined, north)).json()).toEqual([]);
    expect((await json('GET', `/system/uploads/${first?.id}`, undefined, north)).status).toBe(404);
    expect(
      (await json('GET', `/system/uploads/${first?.id}/download`, undefined, north)).status,
    ).toBe(404);
    expect((await upload(LINK, undefined, north)).status).toBe(404);
  });

  it('exports the metadata, answers 410 when the object is gone and cascades on delete', async () => {
    const { t, json, upload, event } = await setup();
    await event('EV-1');
    const { attachment } = (await (await upload(LINK)).json()) as { attachment: { id: string } };

    const exported = (await (await json('GET', '/system/export')).json()) as {
      data: { attachments: { id: string }[] };
    };
    expect(exported.data.attachments.map((a) => a.id)).toEqual([attachment.id]);

    t.objects.clear();
    const gone = await json('GET', `/system/uploads/${attachment.id}/download`);
    expect(gone.status).toBe(410);

    expect((await json('DELETE', '/api/eventos/EV-1')).status).toBe(200);
    expect((await json('GET', `/system/uploads/${attachment.id}`)).status).toBe(404);
  });
});
