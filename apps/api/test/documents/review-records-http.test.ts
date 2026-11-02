import { describe, expect, it } from 'vitest';
import { runReviewMaterialize } from '../../src/tools/review-materialize/run.ts';
import { createTestApp } from '../support/test-app.ts';

// T23 (odd/tasks/functional-closure.md S13): approving a review item creates its record in the
// tenant's module; a dry-run-by-default backfill covers items approved before. Synthetic data.

const SHA = 'c'.repeat(64);
const finding = (tema: string, n: number) => ({
  tema,
  ubicacion: `Línea ${n}`,
  fragmento: `Fragmento sintético número ${n} sobre ${tema}.`,
  accion_sugerida: 'Contrastar con el acta sintética.',
});

const setup = async () => {
  const t = await createTestApp();
  const admin = await t.login('admin', 'admin-password-123');
  expect(admin.res.status).toBe(200);
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
  const importItems = async (items: unknown[], extra: Record<string, string> = {}) => {
    const res = await json(
      'POST',
      '/system/document-lab/review/import',
      { filename: 'acta-sintetica.txt', sha256: SHA, items },
      extra,
    );
    expect(res.status).toBe(200);
  };
  type Item = {
    id: string;
    theme: string;
    status: string;
    target: { module: string; label: string };
    record: { module: string; id: string } | null;
  };
  const list = async (extra: Record<string, string> = {}) =>
    (
      (await (
        await json('GET', '/system/document-lab/review?limit=200', undefined, extra)
      ).json()) as { items: Item[] }
    ).items;
  const recordsIn = async (slug: string, extra: Record<string, string> = {}) =>
    (await (await json('GET', `/api/${slug}?limit=500`, undefined, extra)).json()) as Record<
      string,
      unknown
    >[];
  const approve = (id: string, extra: Record<string, string> = {}) =>
    json(
      'PATCH',
      `/system/document-lab/review/${id}`,
      { status: 'corroborado_documentalmente', reviewer: 'Revisora', note: 'Acta sintética' },
      extra,
    );
  const rowHash = async () => {
    const [row] = await t.sql.query<{ h: string | null; n: number | string }>(
      `SELECT md5(string_agg(tenant_id || '|' || module || '|' || id || '|' || payload::text, ','
                 ORDER BY tenant_id, module, id)) AS h, count(*) AS n FROM module_records`,
    );
    const [audit] = await t.sql.query<{ n: number | string }>('SELECT count(*) AS n FROM audit');
    return `${row?.h ?? ''}/${row?.n ?? 0}/${audit?.n ?? 0}`;
  };
  return { t, admin, json, importItems, list, recordsIn, approve, rowHash };
};

describe('approving a document review item (T23)', () => {
  it('creates exactly one record in the mapped module, traceable to the item', async () => {
    const { json, importItems, list, recordsIn, approve } = await setup();
    await importItems([finding('Compromisos y trazabilidad', 1)]);
    const [pending] = await list();
    expect(pending).toMatchObject({
      status: 'pendiente',
      target: { module: 'compromisos', label: 'Compromisos' },
      record: null,
    });
    const before = (await recordsIn('compromisos')).length;

    const res = await approve(pending?.id ?? '');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { record: { module: string; id: string; created: boolean } };
    expect(body.record).toEqual({
      module: 'compromisos',
      id: `REV-${pending?.id}`,
      created: true,
    });

    const after = await recordsIn('compromisos');
    expect(after).toHaveLength(before + 1);
    const record = (await (
      await json('GET', `/api/compromisos/${body.record.id}`)
    ).json()) as Record<string, unknown>;
    expect(record).toMatchObject({
      _id: `REV-${pending?.id}`,
      ID_Compromiso: `REV-${pending?.id}`,
      Descripcion: 'Fragmento sintético número 1 sobre Compromisos y trazabilidad.',
      Proyecto_ID: 'PRJ-SECHURA',
      Revision_Documental_ID: pending?.id,
      Fuente_ID: 'acta-sintetica.txt · Línea 1',
    });
    expect(String(record.Observaciones)).toContain('Acta sintética');
    expect(String(record.Observaciones)).toContain(SHA);

    const [listed] = await list();
    expect(listed?.record).toEqual({ module: 'compromisos', id: `REV-${pending?.id}` });
  });

  it('maps every lexical theme to its module and keeps unknown themes as facts to verify', async () => {
    const { importItems, list, approve } = await setup();
    const themes = {
      'Representatividad y gobernanza': 'actores',
      'Demandas e intereses': 'demandas',
      'Compromisos y trazabilidad': 'compromisos',
      'Controversias y hechos compartidos': 'hechos',
      'Diálogo y construcción de consensos': 'dialogos',
      'Oportunidades de valor compartido': 'oportunidades',
      'Territorio y ambiente': 'narrativas',
      'Tema libre sintético': 'hechos',
    };
    await importItems(Object.keys(themes).map((tema, n) => finding(tema, n)));
    for (const item of await list()) {
      expect(item.target.module).toBe(themes[item.theme as keyof typeof themes]);
      const res = await approve(item.id);
      expect(res.status).toBe(200);
    }
    expect((await list()).every((item) => item.record?.module === item.target.module)).toBe(true);
  });

  it('never duplicates on a second approval and creates nothing on discard', async () => {
    const { json, importItems, list, recordsIn, approve } = await setup();
    await importItems([finding('Demandas e intereses', 1), finding('Demandas e intereses', 2)]);
    const [first, second] = await list();
    expect((await approve(first?.id ?? '')).status).toBe(200);
    const again = await approve(first?.id ?? '');
    expect(((await again.json()) as { record: { created: boolean } }).record.created).toBe(false);
    const accepted = await json('PATCH', `/system/document-lab/review/${first?.id}`, {
      status: 'aceptado_para_revision',
    });
    expect(((await accepted.json()) as { record: { created: boolean } }).record.created).toBe(
      false,
    );
    const discarded = await json('PATCH', `/system/document-lab/review/${second?.id}`, {
      status: 'descartado',
    });
    expect(((await discarded.json()) as { record: unknown }).record).toBeNull();
    const demandas = await recordsIn('demandas');
    expect(demandas.filter((r) => String(r._id).startsWith('REV-'))).toHaveLength(1);
  });

  it("keeps tenant A's approval out of tenant B", async () => {
    const { t, admin, importItems, list, recordsIn, approve } = await setup();
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
    const south = { 'x-sipges-scope': 'SIPGES/PRJ-SECHURA' };
    const north = { 'x-sipges-scope': 'ACME/NORTE' };
    await importItems([finding('Territorio y ambiente', 1)], south);
    const [item] = await list(south);
    // Another tenant cannot approve it, and nothing is created there.
    expect((await approve(item?.id ?? '', north)).status).toBe(404);
    expect((await approve(item?.id ?? '', south)).status).toBe(200);
    const southIds = (await recordsIn('narrativas', south)).map((r) => r._id);
    const northIds = (await recordsIn('narrativas', north)).map((r) => r._id);
    expect(southIds).toContain(`REV-${item?.id}`);
    expect(northIds).not.toContain(`REV-${item?.id}`);
    const [stored] = await t.sql.query<{ tenant_id: string; project: string }>(
      `SELECT tenant_id, payload->>'Proyecto_ID' AS project FROM module_records WHERE id = $1`,
      [`REV-${item?.id}`],
    );
    expect(stored).toEqual({ tenant_id: 'SIPGES/PRJ-SECHURA', project: 'PRJ-SECHURA' });
  });
});

describe('review:materialize backfill (T23)', () => {
  const approveLegacy = async (sql: Awaited<ReturnType<typeof setup>>['t']['sql']) =>
    sql.query(
      `UPDATE document_review SET status = 'corroborado_documentalmente', reviewer = 'Revisora'
        WHERE theme <> 'Demandas e intereses'`,
    );

  it('dry run reports counts per tenant and module and writes nothing', async () => {
    const { t, importItems, rowHash } = await setup();
    await importItems([
      finding('Compromisos y trazabilidad', 1),
      finding('Compromisos y trazabilidad', 2),
      finding('Territorio y ambiente', 3),
      finding('Demandas e intereses', 4),
    ]);
    await approveLegacy(t.sql);
    const before = await rowHash();
    const report = await runReviewMaterialize(t.sql, { apply: false, now: t.clock.now });
    expect(report.applied).toBe(false);
    expect(report.tenants).toEqual([
      {
        tenant: 'SIPGES/PRJ-SECHURA',
        approved: 3,
        modules: [
          { module: 'compromisos', nuevos: 2, ya_existentes: 0 },
          { module: 'narrativas', nuevos: 1, ya_existentes: 0 },
        ],
        problems: [],
      },
    ]);
    expect(await rowHash()).toBe(before);
  });

  it('apply creates the missing records once and is idempotent with approvals', async () => {
    const { t, importItems, list, approve, rowHash } = await setup();
    await importItems([
      finding('Compromisos y trazabilidad', 1),
      finding('Territorio y ambiente', 2),
    ]);
    const [first] = await list();
    // One item approved through the inbox (record exists), the other approved before T23.
    expect((await approve(first?.id ?? '')).status).toBe(200);
    await approveLegacy(t.sql);

    const applied = await runReviewMaterialize(t.sql, { apply: true, now: t.clock.now });
    expect(applied.applied).toBe(true);
    expect(applied.tenants[0]?.modules.reduce((sum, m) => sum + m.nuevos, 0)).toBe(1);
    expect(applied.tenants[0]?.modules.reduce((sum, m) => sum + m.ya_existentes, 0)).toBe(1);

    const settled = await rowHash();
    const rerun = await runReviewMaterialize(t.sql, { apply: true, now: t.clock.now });
    expect(rerun.tenants[0]?.modules.every((m) => m.nuevos === 0)).toBe(true);
    expect(await rowHash()).toBe(settled);
    // Approving again after the backfill still creates nothing.
    for (const item of await list()) await approve(item.id);
    const [{ n } = { n: 0 }] = await t.sql.query<{ n: number | string }>(
      `SELECT count(*) AS n FROM module_records WHERE id LIKE 'REV-%'`,
    );
    expect(Number(n)).toBe(2);
  });

  it('limits the run to one tenant with scope', async () => {
    const { t, admin, importItems } = await setup();
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
    await importItems([finding('Territorio y ambiente', 1)], { 'x-sipges-scope': 'ACME/NORTE' });
    await importItems([finding('Territorio y ambiente', 2)], {
      'x-sipges-scope': 'SIPGES/PRJ-SECHURA',
    });
    await approveLegacy(t.sql);
    const report = await runReviewMaterialize(t.sql, {
      apply: true,
      scope: 'ACME/NORTE',
      now: t.clock.now,
    });
    expect(report.tenants.map((r) => r.tenant)).toEqual(['ACME/NORTE']);
    const rows = await t.sql.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM module_records WHERE id LIKE 'REV-%'`,
    );
    expect(rows).toEqual([{ tenant_id: 'ACME/NORTE' }]);
  });
});
