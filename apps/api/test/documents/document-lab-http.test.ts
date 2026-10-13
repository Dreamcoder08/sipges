import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { docxRenderer } from '../../src/contexts/documents/infrastructure/index.ts';
import { heading, paragraph, table } from '@mascli/kernel';
import { createTestApp } from '../support/test-app.ts';
import { SAMPLE_TEXT, minimalPdf, utf8 } from './fixtures.ts';

type Fixture = Awaited<ReturnType<typeof createTestApp>>;
type Upload = { field?: string; name: string; bytes: Uint8Array };

const setup = async (env: Record<string, string> = {}) => {
  const t = await createTestApp(env);
  const admin = await t.login('admin', 'admin-password-123');
  expect(admin.res.status).toBe(200);

  const post = (
    path: string,
    files: Upload[],
    fields: Record<string, string> = {},
    cookie = admin.cookie,
  ) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    for (const f of files) form.set(f.field ?? 'file', new File([f.bytes], f.name));
    return t.request(path, { method: 'POST', headers: { cookie }, body: form });
  };
  const json = (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
    t.request(path, {
      method,
      headers: {
        cookie: admin.cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { t, admin, post, json };
};

const addUser = async (t: Fixture, adminCookie: string, role: string) => {
  const username = `user.${role}`;
  expect(
    (
      await t.createAccount(adminCookie, {
        username,
        full_name: 'Synthetic',
        password: 'synthetic-pass-123',
        role,
      })
    ).status,
  ).toBe(200);
  await t.grant(adminCookie, username);
  return (await t.login(username, 'synthetic-pass-123')).cookie;
};

const docx = (texts: string[]) =>
  docxRenderer.render({
    blocks: [
      heading(1, 'Acta sintética'),
      ...texts.map(paragraph),
      table(['Responsable', 'Plazo'], [['Comité', 'Seguimiento mensual del acuerdo']]),
    ],
  });

describe('POST /system/document-lab/analyze', () => {
  it('reads TXT, PDF and DOCX into located candidate findings', async () => {
    const { post } = await setup();
    const txt = await post('/system/document-lab/analyze', [
      { name: 'acta.txt', bytes: utf8(SAMPLE_TEXT) },
    ]);
    expect(txt.status).toBe(200);
    const body = (await txt.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      version: '2.1',
      project_id: 'PRJ-SECHURA',
      filename: 'acta.txt',
      generated_at: '2026-10-12T12:00:00Z',
      text_sections: 3,
      themes: {
        'Representatividad y gobernanza': 1,
        'Demandas e intereses': 1,
        'Compromisos y trazabilidad': 1,
      },
    });
    expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((body.limitations as string[]).join(' ')).not.toContain('no tiene autenticación');

    const pdf = await post('/system/document-lab/analyze', [
      {
        name: 'informe.pdf',
        bytes: minimalPdf([
          'Sin texto relevante',
          'La comunidad pide empleo local y capacitacion.',
        ]),
      },
    ]);
    expect(pdf.status).toBe(200);
    const pdfBody = (await pdf.json()) as { items: { ubicacion: string }[] };
    expect(pdfBody.items.map((i) => i.ubicacion)).toEqual(['Página 2', 'Página 2']);

    const word = await post('/system/document-lab/analyze', [
      { name: 'acta.docx', bytes: await docx(['La mesa de diálogo acordó una nueva reunión.']) },
    ]);
    expect(word.status).toBe(200);
    const wordBody = (await word.json()) as { items: { ubicacion: string; tema: string }[] };
    expect(wordBody.items.map((i) => [i.ubicacion, i.tema])).toEqual([
      ['Párrafo 2', 'Diálogo y construcción de consensos'],
      ['Tabla 1, fila 2', 'Compromisos y trazabilidad'],
    ]);
  });

  it('maps every rejection to app.py status codes', async () => {
    const { post } = await setup({ MASCLI_MAX_UPLOAD_BYTES: '1048576' });
    const analyze = (name: string, bytes: Uint8Array) =>
      post('/system/document-lab/analyze', [{ name, bytes }]);
    const cases: [string, Uint8Array, number, string][] = [
      ['macro.docm', utf8('x'), 415, 'Tipo de documento no compatible'],
      ['vacio.txt', new Uint8Array(), 400, 'Archivo vacío'],
      ['roto.pdf', utf8('%PDF-1.4 not really'), 422, 'No se puede leer el documento'],
      ['roto.docx', utf8('PK not a zip'), 422, 'No se puede leer el documento'],
      [
        'blanco.txt',
        utf8('   \n\n'),
        422,
        'No se detectó texto extraíble. Los PDF escaneados requieren OCR externo.',
      ],
      [
        'largo.pdf',
        minimalPdf(Array.from({ length: 101 }, () => 'p')),
        413,
        'El PDF supera 100 páginas',
      ],
      ['grande.txt', new Uint8Array(1048577).fill(97), 413, 'Archivo demasiado grande'],
      ['enorme.txt', new Uint8Array(3 * 1048576).fill(97), 413, 'Archivo demasiado grande'],
    ];
    for (const [name, bytes, status, detail] of cases) {
      const res = await analyze(name, bytes);
      expect(res.status, name).toBe(status);
      expect(await res.json(), name).toEqual({ detail });
    }
    const missing = await post('/system/document-lab/analyze', []);
    expect(missing.status).toBe(422);
  });

  it('refuses another project and is open to read-only roles', async () => {
    const { t, admin, post } = await setup();
    const acta = { name: 'acta.txt', bytes: utf8(SAMPLE_TEXT) };
    const file = [acta];
    const foreign = await post('/system/document-lab/analyze', file, { project_id: 'OTRO' });
    expect(foreign.status).toBe(403);
    const reader = await addUser(t, admin.cookie, 'consulta');
    expect((await post('/system/document-lab/analyze', file, {}, reader)).status).toBe(200);
    expect(
      (
        await post(
          '/system/document-lab/compare',
          [
            { field: 'file_a', ...acta },
            { field: 'file_b', ...acta },
          ],
          {},
          reader,
        )
      ).status,
    ).toBe(200);
  });
});

describe('POST /system/document-lab/report.docx', () => {
  it('returns a Word report with the findings', async () => {
    const { post } = await setup();
    const res = await post('/system/document-lab/report.docx', [
      { name: 'acta.txt', bytes: utf8(SAMPLE_TEXT) },
    ]);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="MASCLI_RC20_Lectura_Documental.docx"',
    );
    const xml = strFromU8(
      unzipSync(new Uint8Array(await res.arrayBuffer()))['word/document.xml'] ?? new Uint8Array(),
    );
    expect(xml).toContain('Informe de lectura documental');
    expect(xml).toContain('H001 — Representatividad y gobernanza (Línea 1)');
  });
});

describe('POST /system/document-lab/compare', () => {
  it('pairs same-theme findings of two documents', async () => {
    const { post } = await setup();
    const res = await post('/system/document-lab/compare', [
      { field: 'file_a', name: 'v1.txt', bytes: utf8(SAMPLE_TEXT) },
      {
        field: 'file_b',
        name: 'v2.pdf',
        bytes: minimalPdf(['Se firmo un acta con compromiso, responsable y plazo de entrega.']),
      },
    ]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      documents: { filename: string }[];
      comparaciones: Record<string, unknown>[];
      total_candidatos: number;
    };
    expect(body.documents.map((d) => d.filename)).toEqual(['v1.txt', 'v2.pdf']);
    expect(body.total_candidatos).toBe(1);
    expect(body.comparaciones[0]).toMatchObject({
      tema: 'Compromisos y trazabilidad',
      terminos_comunes: ['compromiso', 'firmo', 'plazo', 'responsable'],
      coincidencia_lexica: 0.67,
    });

    const bad = await post('/system/document-lab/compare', [
      { field: 'file_a', name: 'v1.txt', bytes: utf8(SAMPLE_TEXT) },
      { field: 'file_b', name: 'v2.exe', bytes: utf8('x') },
    ]);
    expect(bad.status).toBe(415);
    const empty = await post('/system/document-lab/compare', [
      { field: 'file_a', name: 'v1.txt', bytes: new Uint8Array() },
      { field: 'file_b', name: 'v2.txt', bytes: utf8(SAMPLE_TEXT) },
    ]);
    expect(empty.status).toBe(413);
    expect(await empty.json()).toEqual({ detail: 'Tamaño inválido' });
  });
});

describe('document review inbox', () => {
  const SHA = 'a'.repeat(64);
  const item = (n: number) => ({
    tema: 'Compromisos y trazabilidad',
    ubicacion: `Línea ${n}`,
    fragmento: `Se firmó un acta de compromiso número ${n}.`,
    accion_sugerida: 'Contrastar actas.',
  });

  it('imports excerpts once, lists them and records decisions in the audit trail', async () => {
    const { json } = await setup();
    const batch = { filename: 'acta.txt', sha256: SHA, items: [item(1), item(2), { tema: 'x' }] };
    const first = await json('POST', '/system/document-lab/review/import', batch);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      ok: true,
      new_items: 2,
      message: 'Sólo se guardaron extractos de revisión, no los archivos originales.',
    });
    const again = await json('POST', '/system/document-lab/review/import', batch);
    expect(((await again.json()) as { new_items: number }).new_items).toBe(0);

    const list = (await (await json('GET', '/system/document-lab/review')).json()) as {
      items: { id: string; status: string; project_id: string; created_at: string }[];
      total: number;
    };
    expect(list.total).toBe(2);
    expect(list.items[0]).toMatchObject({
      status: 'pendiente',
      project_id: 'PRJ-SECHURA',
      source_file: 'acta.txt',
      source_sha256: SHA,
      created_at: '2026-10-12T12:00:00Z',
    });
    const id = list.items[0]?.id ?? '';
    expect(id).toMatch(/^[0-9a-f]{32}$/);

    const needsNote = await json('PATCH', `/system/document-lab/review/${id}`, {
      status: 'corroborado_documentalmente',
    });
    expect(needsNote.status).toBe(422);
    expect(
      (await json('PATCH', `/system/document-lab/review/${id}`, { status: 'otro' })).status,
    ).toBe(422);
    expect(
      (await json('PATCH', '/system/document-lab/review/nope', { status: 'descartado' })).status,
    ).toBe(404);

    const ok = await json('PATCH', `/system/document-lab/review/${id}`, {
      status: 'corroborado_documentalmente',
      reviewer: 'Revisora',
      note: 'Contrastado con acta firmada',
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, id, status: 'corroborado_documentalmente' });

    const done = (await (
      await json('GET', '/system/document-lab/review?status=corroborado_documentalmente')
    ).json()) as { items: { id: string; note: string }[] };
    expect(done.items).toEqual([
      expect.objectContaining({ id, note: 'Contrastado con acta firmada' }),
    ]);

    const audit = (await (await json('GET', '/system/audit')).json()) as Record<string, unknown>[];
    expect(audit[0]).toMatchObject({
      module: 'Laboratorio_Documental',
      record_id: id,
      action: 'REVIEW',
      detail: 'corroborado_documentalmente | Revisora',
    });

    const exported = (await (await json('GET', '/system/export')).json()) as {
      data: { document_review: { id: string }[] };
    };
    expect(exported.data.document_review).toHaveLength(2);
  });

  it('validates the batch and keeps the inbox inside the tenant', async () => {
    const { t, admin, json } = await setup();
    const importBatch = (body: unknown, extra: Record<string, string> = {}) =>
      json('POST', '/system/document-lab/review/import', body, extra);
    expect((await importBatch({ filename: 'a', sha256: 'XYZ', items: [] })).status).toBe(422);
    expect(
      (
        await importBatch({
          filename: 'a',
          sha256: SHA,
          items: Array.from({ length: 76 }, (_, i) => item(i)),
        })
      ).status,
    ).toBe(413);
    expect(
      (await importBatch({ project_id: 'OTRO', filename: 'a', sha256: SHA, items: [item(1)] }))
        .status,
    ).toBe(403);
    expect(
      (
        await importBatch({
          filename: 'a',
          sha256: SHA,
          items: [{ ...item(1), fragmento: 'a\u0000b' }],
        })
      ).status,
    ).toBe(422);
    expect((await importBatch({ filename: 'a', sha256: SHA, items: [item(1)] })).status).toBe(200);
    // Accounts are created before a second scope makes the admin choose one per request.
    const reader = await addUser(t, admin.cookie, 'consulta');

    expect(
      (
        await t.createScope(admin.cookie, {
          company_id: 'ACME',
          project_id: 'NORTE',
          label: 'Norte',
          username: 'admin',
        })
      ).status,
    ).toBe(200);
    const north = { 'x-mascli-scope': 'ACME/NORTE' };
    const listed = (await (
      await json('GET', '/system/document-lab/review', undefined, north)
    ).json()) as {
      total: number;
    };
    expect(listed.total).toBe(0);
    const [row] = await t.sql.query<{ id: string }>('SELECT id FROM document_review');
    const rowId = row?.id ?? '';
    expect(
      (await json('PATCH', `/system/document-lab/review/${rowId}`, { status: 'descartado' }, north))
        .status,
    ).toBe(404);

    const denied = await t.request(`/system/document-lab/review/${rowId}`, {
      method: 'PATCH',
      headers: { cookie: reader, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'descartado' }),
    });
    expect(denied.status).toBe(403);
  });
});
