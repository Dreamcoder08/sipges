import { describe, expect, it } from 'vitest';
import { createTestApp } from '../support/test-app.ts';

// T26 (odd/tasks/functional-closure.md S14): decide many review items at once, by ids or by the
// pending items of a theme and/or source document. Synthetic data only.

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SOUTH = { 'x-sipges-scope': 'SIPGES/PRJ-SECHURA' };
const NORTH = { 'x-sipges-scope': 'ACME/NORTE' };
const BULK = '/system/document-lab/review/bulk';

const finding = (tema: string, n: number) => ({
  tema,
  ubicacion: `Línea ${n}`,
  fragmento: `Fragmento sintético ${n} sobre ${tema}.`,
  accion_sugerida: 'Contrastar con el acta sintética.',
});

type Item = { id: string; theme: string; status: string; source_sha256: string; reviewer: string };
type Bulk = {
  ok: true;
  dry_run: boolean;
  decided: number;
  records_created: number;
  skipped: number;
  remaining: number;
  modules: { module: string; label: string; nuevos: number; ya_existentes: number }[];
  problems: string[];
};

const setup = async () => {
  const t = await createTestApp();
  const admin = await t.login('admin', 'admin-password-123');
  expect(admin.res.status).toBe(200);
  expect(
    (
      await t.createAccount(admin.cookie, {
        username: 'ana',
        full_name: 'Ana Sintética',
        password: 'ana-password-12345',
        role: 'analista',
      })
    ).status,
  ).toBe(200);
  await t.grant(admin.cookie, 'ana');
  const ana = await t.login('ana', 'ana-password-12345');
  expect(ana.res.status).toBe(200);
  const call = (
    cookie: string,
    method: string,
    path: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ) =>
    t.request(path, {
      method,
      headers: {
        cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const importItems = async (items: unknown[], sha = SHA_A, extra: Record<string, string> = {}) => {
    const res = await call(
      admin.cookie,
      'POST',
      '/system/document-lab/review/import',
      { filename: `acta-${sha.slice(0, 1)}.txt`, sha256: sha, items },
      extra,
    );
    expect(res.status).toBe(200);
  };
  const list = async (extra: Record<string, string> = {}) =>
    (
      (await (
        await call(admin.cookie, 'GET', '/system/document-lab/review?limit=200', undefined, extra)
      ).json()) as { items: Item[] }
    ).items;
  const bulk = (body: unknown, extra: Record<string, string> = {}, cookie = ana.cookie) =>
    call(cookie, 'POST', BULK, body, extra);
  const bulkJson = async (body: unknown, extra: Record<string, string> = {}) => {
    const res = await bulk(body, extra);
    expect(res.status).toBe(200);
    return (await res.json()) as Bulk;
  };
  const reviewRecords = async () =>
    t.sql.query<{ tenant_id: string; module: string; id: string }>(
      `SELECT tenant_id, module, id FROM module_records WHERE id LIKE 'REV-%' ORDER BY id`,
    );
  const rowHash = async () => {
    const [row] = await t.sql.query<{ h: string | null }>(
      `SELECT md5(coalesce(string_agg(tenant_id || module || id || payload::text, ','
                 ORDER BY tenant_id, module, id), '')) AS h FROM module_records`,
    );
    const [review] = await t.sql.query<{ h: string | null }>(
      `SELECT md5(coalesce(string_agg(id || status || reviewer || note, ',' ORDER BY id), ''))
         AS h FROM document_review`,
    );
    const [audit] = await t.sql.query<{ n: number | string }>('SELECT count(*) AS n FROM audit');
    return `${row?.h}/${review?.h}/${audit?.n}`;
  };
  return { t, admin, ana, call, importItems, list, bulk, bulkJson, reviewRecords, rowHash };
};

/** Inserts `count` synthetic pending items for one theme straight into the tenant's queue. */
const seedPending = (
  t: Awaited<ReturnType<typeof setup>>['t'],
  count: number,
  theme: string,
  tenant = 'SIPGES/PRJ-SECHURA',
) =>
  t.sql.query(
    `INSERT INTO document_review (tenant_id, id, project_id, source_file, source_sha256, location,
       theme, excerpt, action, status, created_at, updated_at)
     SELECT $1, 'seed' || lpad(n::text, 5, '0'), split_part($1, '/', 2), 'acta-seed.txt', $3,
            'Línea ' || n, $2, 'Fragmento sintético sembrado ' || n, '', 'pendiente', now(), now()
       FROM generate_series(1, $4::int) AS n`,
    [tenant, theme, SHA_A, count],
  );

describe('bulk review decision (T26)', () => {
  it('approves explicit ids: one record per item in its module, audited with the acting user', async () => {
    const { t, importItems, list, bulkJson, reviewRecords } = await setup();
    await importItems([
      finding('Compromisos y trazabilidad', 1),
      finding('Territorio y ambiente', 2),
      finding('Demandas e intereses', 3),
    ]);
    const items = await list();
    const chosen = items.filter((item) => item.theme !== 'Demandas e intereses');

    const result = await bulkJson({
      ids: chosen.map((item) => item.id),
      status: 'aceptado_para_revision',
      note: 'Lote sintético',
    });
    expect(result).toMatchObject({
      ok: true,
      dry_run: false,
      decided: 2,
      records_created: 2,
      skipped: 0,
      problems: [],
    });
    expect(result.modules).toEqual([
      { module: 'compromisos', label: 'Compromisos', nuevos: 1, ya_existentes: 0 },
      { module: 'narrativas', label: 'Narrativas', nuevos: 1, ya_existentes: 0 },
    ]);
    const records = await reviewRecords();
    expect(records.map((r) => `${r.module}/${r.id}`).sort()).toEqual(
      chosen
        .map(
          (item) =>
            `${item.theme === 'Territorio y ambiente' ? 'Narrativas' : 'Compromisos'}/REV-${item.id}`,
        )
        .sort(),
    );
    const after = await list();
    for (const item of after) {
      const picked = chosen.some((c) => c.id === item.id);
      expect(item.status).toBe(picked ? 'aceptado_para_revision' : 'pendiente');
      if (picked) expect(item.reviewer).toBe('Ana Sintética');
    }
    const audit = await t.sql.query<{ record_id: string; detail: string; module: string }>(
      `SELECT record_id, detail, module FROM audit WHERE action = 'REVIEW' ORDER BY record_id`,
    );
    expect(audit).toEqual(
      chosen
        .map((item) => ({
          record_id: item.id,
          detail: 'aceptado_para_revision | Ana Sintética',
          module: 'Laboratorio_Documental',
        }))
        .sort((a, b) => a.record_id.localeCompare(b.record_id)),
    );
  });

  it('re-running skips decided items and never duplicates records or audit rows', async () => {
    const { t, importItems, list, bulkJson, reviewRecords, rowHash } = await setup();
    await importItems([finding('Demandas e intereses', 1), finding('Demandas e intereses', 2)]);
    const ids = (await list()).map((item) => item.id);
    expect((await bulkJson({ ids, status: 'aceptado_para_revision' })).decided).toBe(2);
    const settled = await rowHash();

    const again = await bulkJson({ ids, status: 'corroborado_documentalmente', note: 'Acta' });
    expect(again).toMatchObject({ decided: 0, records_created: 0, skipped: 2 });
    const byTheme = await bulkJson({ theme: 'Demandas e intereses', status: 'descartado' });
    expect(byTheme).toMatchObject({ decided: 0, skipped: 0, remaining: 0 });
    expect(await rowHash()).toBe(settled);
    expect(await reviewRecords()).toHaveLength(2);
    const [{ n } = { n: 0 }] = await t.sql.query<{ n: number | string }>(
      `SELECT count(*) AS n FROM audit WHERE action = 'REVIEW'`,
    );
    expect(Number(n)).toBe(2);
  });

  it('decides the pending items of a theme and/or a source document only', async () => {
    const { importItems, list, bulkJson, reviewRecords } = await setup();
    await importItems([finding('Territorio y ambiente', 1), finding('Demandas e intereses', 2)]);
    await importItems(
      [finding('Territorio y ambiente', 3), finding('Demandas e intereses', 4)],
      SHA_B,
    );
    const both = await bulkJson({
      theme: 'Territorio y ambiente',
      source_sha256: SHA_A,
      status: 'aceptado_para_revision',
    });
    expect(both).toMatchObject({ decided: 1, records_created: 1, remaining: 0 });
    const doc = await bulkJson({ source_sha256: SHA_B, status: 'descartado' });
    expect(doc).toMatchObject({ decided: 2, records_created: 0, modules: [] });
    const statuses = Object.fromEntries(
      (await list()).map((item) => [`${item.source_sha256[0]}:${item.theme}`, item.status]),
    );
    expect(statuses).toEqual({
      'a:Territorio y ambiente': 'aceptado_para_revision',
      'a:Demandas e intereses': 'pendiente',
      'b:Territorio y ambiente': 'descartado',
      'b:Demandas e intereses': 'descartado',
    });
    expect(await reviewRecords()).toHaveLength(1);
  });

  it('never touches another tenant, by filter or by ids', async () => {
    const { t, admin, importItems, list, bulkJson, reviewRecords } = await setup();
    expect(
      (
        await t.createScope(admin.cookie, {
          company_id: 'ACME',
          project_id: 'NORTE',
          label: 'Norte',
          username: 'ana',
        })
      ).status,
    ).toBe(200);
    await t.grant(admin.cookie, 'admin', 'ACME/NORTE');
    await importItems([finding('Territorio y ambiente', 1)], SHA_A, SOUTH);
    await importItems([finding('Territorio y ambiente', 1)], SHA_A, NORTH);
    const [southItem] = await list(SOUTH);

    const byIds = await bulkJson({ ids: [southItem?.id], status: 'aceptado_para_revision' }, NORTH);
    expect(byIds).toMatchObject({ decided: 0, skipped: 1 });
    const byTheme = await bulkJson(
      { theme: 'Territorio y ambiente', source_sha256: SHA_A, status: 'aceptado_para_revision' },
      NORTH,
    );
    expect(byTheme).toMatchObject({ decided: 1, records_created: 1 });

    expect((await list(SOUTH)).map((item) => item.status)).toEqual(['pendiente']);
    expect((await list(NORTH)).map((item) => item.status)).toEqual(['aceptado_para_revision']);
    expect((await reviewRecords()).map((r) => r.tenant_id)).toEqual(['ACME/NORTE']);
    const audit = await t.sql.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM audit WHERE action = 'REVIEW'`,
    );
    expect(audit).toEqual([{ tenant_id: 'ACME/NORTE' }]);
  });

  it('caps a request at 1,000 items and reports what remains', async () => {
    const { t, bulk, bulkJson, reviewRecords } = await setup();
    const tooMany = await bulk({
      ids: Array.from({ length: 1001 }, (_, n) => `id${n}`),
      status: 'descartado',
    });
    expect(tooMany.status).toBe(422);
    expect(await tooMany.json()).toEqual({ detail: 'Máximo 1000 hallazgos por solicitud' });

    await seedPending(t, 1005, 'Compromisos y trazabilidad');
    const preview = await bulkJson({
      theme: 'Compromisos y trazabilidad',
      status: 'aceptado_para_revision',
      dry_run: true,
    });
    expect(preview).toMatchObject({ dry_run: true, decided: 1000, remaining: 5 });
    const first = await bulkJson({
      theme: 'Compromisos y trazabilidad',
      status: 'aceptado_para_revision',
    });
    expect(first).toMatchObject({ decided: 1000, records_created: 1000, remaining: 5 });
    const second = await bulkJson({
      theme: 'Compromisos y trazabilidad',
      status: 'aceptado_para_revision',
    });
    expect(second).toMatchObject({ decided: 5, records_created: 5, remaining: 0 });
    expect(await reviewRecords()).toHaveLength(1005);
  }, 120_000);

  it('previews the counts per module and writes nothing', async () => {
    const { importItems, list, bulkJson, rowHash } = await setup();
    await importItems([
      finding('Compromisos y trazabilidad', 1),
      finding('Compromisos y trazabilidad', 2),
      finding('Representatividad y gobernanza', 3),
    ]);
    const before = await rowHash();
    const preview = await bulkJson({
      ids: (await list()).map((item) => item.id),
      status: 'corroborado_documentalmente',
      note: 'Acta sintética contrastada',
      dry_run: true,
    });
    expect(preview).toEqual({
      ok: true,
      dry_run: true,
      decided: 3,
      records_created: 3,
      skipped: 0,
      remaining: 0,
      modules: [
        { module: 'actores', label: 'Actores', nuevos: 1, ya_existentes: 0 },
        { module: 'compromisos', label: 'Compromisos', nuevos: 2, ya_existentes: 0 },
      ],
      problems: [],
    });
    expect(await rowHash()).toBe(before);
  });

  it('validates the body and keeps the single decision permissions', async () => {
    const { t, admin, bulk } = await setup();
    const invalid = [
      { status: 'aceptado_para_revision' },
      { ids: [], status: 'aceptado_para_revision' },
      { ids: ['x'], theme: 'Tema', status: 'aceptado_para_revision' },
      { theme: 'Tema', status: 'pendiente' },
      { theme: 'Tema', status: 'corroborado_documentalmente' },
      { theme: 'Tema', status: 'aceptado_para_revision', extra: true },
    ];
    for (const body of invalid) expect((await bulk(body)).status).toBe(422);

    expect(
      (
        await t.createAccount(admin.cookie, {
          username: 'lectora',
          full_name: 'Lectora Sintética',
          password: 'lectora-password-123',
          role: 'consulta',
        })
      ).status,
    ).toBe(200);
    await t.grant(admin.cookie, 'lectora');
    const reader = await t.login('lectora', 'lectora-password-123');
    const denied = await bulk(
      { theme: 'Tema', status: 'descartado', dry_run: true },
      {},
      reader.cookie,
    );
    expect(denied.status).toBe(403);
  });
});
